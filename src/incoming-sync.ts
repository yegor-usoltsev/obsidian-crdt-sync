import type { Component, Debouncer, Vault } from "obsidian";
import { dirname, isAbsolute, normalize } from "pathe";
import * as Y from "yjs";
import type { ConnectionManager } from "./connection";
import type { EchoPrevention } from "./echo-prevention";
import { getPathForFileId, listActiveFiles } from "./file-index";
import { type FileKind, isVaultFile } from "./file-kind";
import type { PluginLogger } from "./logger";
import { createDebounce } from "./obsidian-debounce";
import { getBinaryContent } from "./y-text-content";

function isValidVaultPath(path: string): boolean {
  if (isAbsolute(path)) {
    return false;
  }
  for (const segment of normalize(path).split("\\").join("/").split("/")) {
    if (segment === ".." || segment === "." || segment.length === 0) {
      return false;
    }
  }
  return true;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

export class IncomingSync {
  private writeDebouncers = new Map<string, Debouncer<[], void>>();
  private enabled = false;
  private readonly contentObserver: (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction,
  ) => void;

  constructor(
    private readonly vault: Vault,
    private readonly connection: ConnectionManager,
    private readonly echoPrevention: EchoPrevention,
    private readonly logger: PluginLogger,
    owner?: Pick<Component, "register">,
  ) {
    this.contentObserver = (events, transaction) => {
      if (transaction.origin === "local") return;
      this.handleContentChanges(events);
    };
    this.connection.filesMap.observeDeep(this.contentObserver);
    owner?.register(() => this.destroy());
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  async flushActiveFilesToVault(): Promise<void> {
    const activeFiles = listActiveFiles(this.connection.metaFiles);

    for (const { fileId, kind } of activeFiles) {
      const existingWrite = this.writeDebouncers.get(fileId);
      if (existingWrite) {
        existingWrite.cancel();
        this.writeDebouncers.delete(fileId);
      }

      if (kind !== "directory") {
        await this.writeToVault(fileId, kind);
      }
    }
  }

  private handleContentChanges(
    events: Y.YEvent<Y.AbstractType<unknown>>[],
  ): void {
    if (!this.enabled) return;
    const fileIdsToWrite = new Set<string>();

    for (const event of events) {
      if (event instanceof Y.YMapEvent) {
        for (const [fileId, change] of event.changes.keys) {
          if (change.action === "add" || change.action === "update") {
            fileIdsToWrite.add(fileId);
          }
        }
      } else {
        const key = event.path[0];
        if (typeof key === "string") {
          fileIdsToWrite.add(key);
        }
      }
    }

    for (const fileId of fileIdsToWrite) {
      this.scheduleWrite(fileId);
    }
  }

  private scheduleWrite(fileId: string): void {
    let write = this.writeDebouncers.get(fileId);
    if (!write) {
      write = createDebounce(
        () => {
          this.writeDebouncers.delete(fileId);
          void this.writeToVault(fileId);
        },
        500,
        true,
      );
      this.writeDebouncers.set(fileId, write);
    }
    write();
  }

  private async writeToVault(
    fileId: string,
    kind?: Exclude<FileKind, "directory">,
  ): Promise<void> {
    const path = getPathForFileId(this.connection.metaFiles, fileId);
    if (!path) return;

    if (!isValidVaultPath(path)) {
      this.logger.warn("incoming sync skipping file with unsafe path", {
        fileId,
        path,
      });
      return;
    }

    const actualKind =
      kind ??
      (this.connection.metaFiles.get(fileId)?.get("kind") as
        | FileKind
        | undefined) ??
      "text";
    if (actualKind === "directory") {
      return;
    }

    const existing = this.vault.getAbstractFileByPath(path);

    this.echoPrevention.markWriting(path);
    try {
      if (isVaultFile(existing)) {
        if (actualKind === "text") {
          const ytext = this.connection.filesMap.get(fileId);
          if (!(ytext instanceof Y.Text)) {
            return;
          }
          await this.vault.process(existing, () => ytext.toString());
        } else {
          const binary = getBinaryContent(this.connection.filesMap, fileId);
          if (!binary) {
            return;
          }
          await this.vault.modifyBinary(existing, toArrayBuffer(binary));
        }
      } else if (this.echoPrevention.isLocallyDeleted(path)) {
        await this.ensureParentDir(path);
        await this.createFile(path, fileId, actualKind);
        this.echoPrevention.unmarkLocallyDeleted(path);
      } else {
        await this.ensureParentDir(path);
        await this.createFile(path, fileId, actualKind);
      }
    } catch (error) {
      this.logger.error("incoming sync vault write failed", {
        fileId,
        path,
        kind: actualKind,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.echoPrevention.unmarkWriting(path);
    }
  }

  private async ensureParentDir(path: string): Promise<void> {
    const dir = dirname(path);
    if (dir === "." || dir === "/") return;
    let current = "";
    for (const segment of dir.split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (this.vault.getAbstractFileByPath(current)) {
        continue;
      }
      try {
        await this.vault.createFolder(current);
      } catch (error) {
        this.logger.debug("ensureParentDir failed (may already exist)", {
          dir: current,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async createFile(
    path: string,
    fileId: string,
    kind: Exclude<FileKind, "directory">,
  ): Promise<void> {
    if (kind === "text") {
      const ytext = this.connection.filesMap.get(fileId);
      if (!(ytext instanceof Y.Text)) {
        return;
      }
      await this.vault.create(path, ytext.toString());
      return;
    }

    const binary = getBinaryContent(this.connection.filesMap, fileId);
    if (!binary) {
      return;
    }
    await this.vault.createBinary(path, toArrayBuffer(binary));
  }

  destroy(): void {
    this.connection.filesMap.unobserveDeep(this.contentObserver);
    for (const write of this.writeDebouncers.values()) {
      write.cancel();
    }
    this.writeDebouncers.clear();
  }
}
