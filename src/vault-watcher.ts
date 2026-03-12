import type {
  Component,
  Debouncer,
  TAbstractFile,
  TFile,
  Vault,
} from "obsidian";
import { join, normalize, relative } from "pathe";
import * as Y from "yjs";
import type { ConnectionManager } from "./connection";
import type { EchoPrevention } from "./echo-prevention";
import {
  detectVaultFileKind,
  isVaultEntry,
  isVaultFile,
  MAX_SYNC_FILE_BYTES,
} from "./file-kind";
import { PluginLogger } from "./logger";
import type { MetadataSync } from "./metadata-sync";
import { createDebounce } from "./obsidian-debounce";
import { isIgnoredSyncPath } from "./sync-ignore";
import {
  byteArraysEqual,
  getBinaryContent,
  replaceTextContent,
  writeBinaryContent,
} from "./y-text-content";

function normalizeVaultPath(path: string): string {
  return normalize(path).split("\\").join("/");
}

function remapDescendantPath(
  path: string,
  oldPath: string,
  newPath: string,
): string | null {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedOldPath = normalizeVaultPath(oldPath);
  if (
    normalizedPath === normalizedOldPath ||
    !normalizedPath.startsWith(`${normalizedOldPath}/`)
  ) {
    return null;
  }

  return normalizeVaultPath(
    join(
      normalizeVaultPath(newPath),
      relative(normalizedOldPath, normalizedPath),
    ),
  );
}

function getVaultEntrySyncKind(file: TAbstractFile): "file" | "directory" {
  return isVaultFile(file) ? "file" : "directory";
}

export class VaultWatcher {
  private static readonly CREATE_SETTLE_MS = 350;
  private static readonly MODIFY_DEBOUNCE_MS = 300;
  private static readonly DIRECTORY_EVENT_TTL_MS = 5_000;
  private createDebouncers = new Map<string, Debouncer<[], void>>();
  private modifyDebouncers = new Map<string, Debouncer<[], void>>();
  private recentDirectoryRenames: Array<{
    oldPath: string;
    newPath: string;
    expiresAt: number;
  }> = [];
  private recentDirectoryDeletes: Array<{ path: string; expiresAt: number }> =
    [];
  private enabled = false;

  constructor(
    private readonly vault: Vault,
    private readonly connection: ConnectionManager,
    private readonly echoPrevention: EchoPrevention,
    private readonly metadataSync: MetadataSync,
    private readonly logger = new PluginLogger(false),
    owner?: Pick<Component, "register" | "registerEvent">,
  ) {
    owner?.registerEvent(
      this.vault.on("create", (file) => {
        void this.onCreate(file);
      }),
    );
    owner?.registerEvent(
      this.vault.on("modify", (file) => {
        this.onModify(file);
      }),
    );
    owner?.registerEvent(
      this.vault.on("delete", (file) => {
        this.onDelete(file);
      }),
    );
    owner?.registerEvent(
      this.vault.on("rename", (file, oldPath) => {
        void this.onRename(file, oldPath);
      }),
    );
    owner?.register(() => this.destroy());
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  private async onCreate(file: TAbstractFile): Promise<void> {
    if (!this.enabled) return;
    if (!isVaultEntry(file)) return;
    if (
      isIgnoredSyncPath(
        file.path,
        getVaultEntrySyncKind(file),
        this.vault.configDir,
      )
    )
      return;
    if (this.echoPrevention.isWriting(file.path)) return;
    this.echoPrevention.unmarkLocallyDeleted(file.path);

    this.scheduleCreate(file.path);
  }

  private scheduleCreate(path: string): void {
    let create = this.createDebouncers.get(path);
    if (!create) {
      create = createDebounce(
        () => {
          this.createDebouncers.delete(path);
          void this.applyCreate(path);
        },
        VaultWatcher.CREATE_SETTLE_MS,
        true,
      );
      this.createDebouncers.set(path, create);
    }
    create();
  }

  private cancelCreate(path: string): boolean {
    const existing = this.createDebouncers.get(path);
    if (!existing) {
      return false;
    }

    existing.cancel();
    this.createDebouncers.delete(path);
    return true;
  }

  private moveCreate(oldPath: string, newPath: string): boolean {
    if (!this.cancelCreate(oldPath)) {
      return false;
    }

    this.scheduleCreate(newPath);
    return true;
  }

  private async applyCreate(path: string): Promise<void> {
    if (!this.enabled) return;
    const file = this.vault.getAbstractFileByPath(path);
    if (!isVaultEntry(file)) {
      return;
    }
    if (
      isIgnoredSyncPath(
        file.path,
        getVaultEntrySyncKind(file),
        this.vault.configDir,
      )
    ) {
      return;
    }
    if (isVaultFile(file) && file.stat.size > MAX_SYNC_FILE_BYTES) {
      this.logger.debug("vault create skipped: file too large", { path });
      return;
    }
    if (this.echoPrevention.isWriting(file.path)) {
      return;
    }

    const existingFileId = this.resolveFileId(file.path);
    if (existingFileId) {
      this.metadataSync.rememberPath(existingFileId, file.path);
      return;
    }

    const kind = await detectVaultFileKind(this.vault, file);
    this.logger.debug("vault create detected", { path, kind });
    this.metadataSync.requestCreate(file.path, kind);
  }

  private onModify(file: TAbstractFile): void {
    if (!this.enabled) return;
    if (!isVaultFile(file)) return;
    if (isIgnoredSyncPath(file.path, "file", this.vault.configDir)) return;
    if (this.echoPrevention.isWriting(file.path)) return;

    if (this.createDebouncers.has(file.path)) {
      this.scheduleCreate(file.path);
      return;
    }

    let modify = this.modifyDebouncers.get(file.path);
    if (!modify) {
      modify = createDebounce(
        () => {
          this.modifyDebouncers.delete(file.path);
          void this.applyModify(file);
        },
        VaultWatcher.MODIFY_DEBOUNCE_MS,
        true,
      );
      this.modifyDebouncers.set(file.path, modify);
    }
    modify();
  }

  private async applyModify(file: TFile): Promise<void> {
    if (isIgnoredSyncPath(file.path, "file", this.vault.configDir)) return;
    if (this.echoPrevention.isWriting(file.path)) return;
    if (file.stat.size > MAX_SYNC_FILE_BYTES) {
      return;
    }

    const fileId = this.resolveFileId(file.path);
    if (!fileId) {
      return;
    }

    this.logger.debug("vault modify detected", { path: file.path, fileId });

    const kind = await detectVaultFileKind(this.vault, file);
    if (kind === "directory") {
      return;
    }

    this.metadataSync.rememberPath(fileId, file.path);
    const existing = this.connection.filesMap.get(fileId);
    if (!existing) {
      if (this.metadataSync.hasPendingCreate(fileId)) {
        return;
      }

      await this.metadataSync.queuePendingContentReplay(
        fileId,
        file.path,
        kind,
      );
      return;
    }

    if (kind === "text") {
      if (!(existing instanceof Y.Text)) {
        await this.metadataSync.queuePendingContentReplay(
          fileId,
          file.path,
          kind,
        );
        return;
      }

      const newContent = await this.vault.cachedRead(file);
      if (existing.toString() === newContent) return;

      this.connection.contentDoc.transact(() => {
        replaceTextContent(existing, newContent);
      }, "local");
      return;
    }

    const newContent = new Uint8Array(await this.vault.readBinary(file));
    const oldContent = getBinaryContent(this.connection.filesMap, fileId);
    if (oldContent && byteArraysEqual(oldContent, newContent)) {
      return;
    }

    writeBinaryContent(
      this.connection.contentDoc,
      this.connection.filesMap,
      fileId,
      newContent,
    );
  }

  private onDelete(file: TAbstractFile): void {
    if (!this.enabled) return;
    if (!isVaultEntry(file)) return;
    if (this.echoPrevention.isWriting(file.path)) return;
    if (this.isCoveredByRecentDirectoryDelete(file.path)) {
      return;
    }
    if (!isVaultFile(file)) {
      this.rememberDirectoryDelete(file.path);
    }
    if (this.cancelCreate(file.path)) {
      return;
    }
    const fileId = this.resolveFileId(file.path);
    if (
      isIgnoredSyncPath(
        file.path,
        getVaultEntrySyncKind(file),
        this.vault.configDir,
      ) &&
      !fileId
    ) {
      return;
    }
    if (!fileId) {
      return;
    }

    this.logger.debug("vault delete detected", { path: file.path, fileId });
    this.echoPrevention.markLocallyDeleted(file.path);
    this.metadataSync.requestDelete(fileId, file.path);
  }

  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.enabled) return;
    if (!isVaultEntry(file)) return;
    if (isVaultFile(file) && file.stat.size > MAX_SYNC_FILE_BYTES) {
      return;
    }
    if (
      this.echoPrevention.isWriting(oldPath) ||
      this.echoPrevention.isWriting(file.path)
    ) {
      return;
    }

    const syncKind = getVaultEntrySyncKind(file);
    const oldPathIgnored = isIgnoredSyncPath(
      oldPath,
      syncKind,
      this.vault.configDir,
    );
    const newPathIgnored = isIgnoredSyncPath(
      file.path,
      syncKind,
      this.vault.configDir,
    );
    if (newPathIgnored) {
      if (this.cancelCreate(oldPath)) {
        return;
      }
      this.cancelCreate(file.path);
    } else if (this.moveCreate(oldPath, file.path)) {
      return;
    }
    if (!isVaultFile(file) && !oldPathIgnored) {
      this.rememberDirectoryRename(oldPath, file.path);
    }

    const oldFileId = this.resolveFileId(oldPath);
    const newFileId = this.resolveFileId(file.path);
    const fileId = oldFileId ?? newFileId;
    if (this.isCoveredByRecentDirectoryRename(oldPath, file.path)) {
      if (fileId && !newPathIgnored) {
        this.metadataSync.rememberPath(fileId, file.path);
      }
      return;
    }
    const kind = await detectVaultFileKind(this.vault, file);
    if (oldPathIgnored && newPathIgnored) {
      return;
    }
    if (oldPathIgnored) {
      if (fileId) {
        this.metadataSync.requestRename(fileId, oldPath, file.path, kind);
        return;
      }
      this.metadataSync.requestCreate(file.path, kind);
      return;
    }
    if (newPathIgnored) {
      if (fileId) {
        this.metadataSync.requestDelete(fileId, oldPath);
      }
      return;
    }
    if (!fileId) {
      return;
    }
    if (
      (newFileId === fileId && oldFileId !== fileId) ||
      this.metadataSync.getCanonicalPath(fileId) === file.path ||
      this.metadataSync.isCoveredByPendingDirectoryRename(oldPath, file.path)
    ) {
      this.metadataSync.rememberPath(fileId, file.path);
      return;
    }

    this.logger.debug("vault rename detected", {
      oldPath,
      newPath: file.path,
      fileId,
      kind,
    });
    this.metadataSync.requestRename(fileId, oldPath, file.path, kind);
  }

  private resolveFileId(path: string): string | undefined {
    return this.metadataSync.resolveFileId(path);
  }

  private rememberDirectoryRename(oldPath: string, newPath: string): void {
    const expiresAt = Date.now() + VaultWatcher.DIRECTORY_EVENT_TTL_MS;
    this.pruneRecentDirectoryOps(expiresAt);
    this.recentDirectoryRenames = this.recentDirectoryRenames.filter(
      (entry) => {
        return entry.oldPath !== oldPath;
      },
    );
    this.recentDirectoryRenames.push({ oldPath, newPath, expiresAt });
  }

  private isCoveredByRecentDirectoryRename(
    oldPath: string,
    newPath: string,
  ): boolean {
    this.pruneRecentDirectoryOps();
    const normalizedNewPath = normalizeVaultPath(newPath);
    for (const entry of this.recentDirectoryRenames) {
      if (
        remapDescendantPath(oldPath, entry.oldPath, entry.newPath) ===
        normalizedNewPath
      ) {
        return true;
      }
    }

    return false;
  }

  private rememberDirectoryDelete(path: string): void {
    const expiresAt = Date.now() + VaultWatcher.DIRECTORY_EVENT_TTL_MS;
    this.pruneRecentDirectoryOps(expiresAt);
    this.recentDirectoryDeletes = this.recentDirectoryDeletes.filter(
      (entry) => {
        return entry.path !== path;
      },
    );
    this.recentDirectoryDeletes.push({ path, expiresAt });
  }

  private isCoveredByRecentDirectoryDelete(path: string): boolean {
    this.pruneRecentDirectoryOps();
    const normalizedPath = normalizeVaultPath(path);
    for (const entry of this.recentDirectoryDeletes) {
      const normalizedDirectoryPath = normalizeVaultPath(entry.path);
      if (
        normalizedPath !== normalizedDirectoryPath &&
        normalizedPath.startsWith(`${normalizedDirectoryPath}/`)
      ) {
        return true;
      }
    }

    return false;
  }

  private pruneRecentDirectoryOps(now = Date.now()): void {
    this.recentDirectoryRenames = this.recentDirectoryRenames.filter(
      (entry) => {
        return entry.expiresAt > now;
      },
    );
    this.recentDirectoryDeletes = this.recentDirectoryDeletes.filter(
      (entry) => {
        return entry.expiresAt > now;
      },
    );
  }

  destroy(): void {
    for (const create of this.createDebouncers.values()) {
      create.cancel();
    }
    this.createDebouncers.clear();
    for (const modify of this.modifyDebouncers.values()) {
      modify.cancel();
    }
    this.modifyDebouncers.clear();
  }
}
