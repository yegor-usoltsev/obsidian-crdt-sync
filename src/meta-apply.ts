import type { App, Component, Vault } from "obsidian";
import { dirname, isAbsolute, normalize } from "pathe";
import * as v from "valibot";
import * as Y from "yjs";
import type { ConnectionManager } from "./connection";
import type { EchoPrevention } from "./echo-prevention";
import { findActiveFileIdByPath } from "./file-index";
import type { FileKind } from "./file-kind";
import { coerceFileKind, detectVaultFileKind, isVaultFile } from "./file-kind";
import { PluginLogger } from "./logger";
import type { MetadataRejectMessage } from "./metadata-sync";
import {
  advanceMetaCursor,
  type PendingMetadataOp,
  type SyncState,
} from "./state";
import {
  byteArraysEqual,
  getBinaryContent,
  type SyncedFileData,
} from "./y-text-content";

export interface MetadataEvent {
  eventId: number;
  type: "file.create" | "file.rename" | "file.delete";
  fileId: string;
  clientId?: string;
  clientOpId?: string;
  path?: string;
  kind: FileKind;
  oldPath?: string;
  newPath?: string;
  contentFingerprint?: string;
}

export interface SyncedVaultFacade {
  kind(path: string): Promise<FileKind | null>;
  read(
    path: string,
    kind: Exclude<FileKind, "directory">,
  ): Promise<SyncedFileData | null>;
  create(path: string, kind: FileKind, content?: SyncedFileData): Promise<void>;
  modify(
    path: string,
    kind: Exclude<FileKind, "directory">,
    content: SyncedFileData,
  ): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
  ensureParentDir(path: string): Promise<void>;
}

export interface MetadataMirrorConfiguration {
  vaultFacade: SyncedVaultFacade;
  connection: ConnectionManager;
  echoPrevention: EchoPrevention;
  localClientId: string;
  getSyncState: () => SyncState;
  updateSyncState: (updater: (syncState: SyncState) => SyncState) => void;
  notify: (message: string) => void;
  registerConflictCopy?: (path: string) => Promise<void>;
  logger?: PluginLogger;
  owner?: Pick<Component, "register">;
}

const optionalString = v.optional(v.pipe(v.string(), v.nonEmpty()));
const metadataEventSchema = v.object({
  eventId: v.pipe(v.number(), v.finite()),
  type: v.picklist(["file.create", "file.rename", "file.delete"]),
  fileId: v.pipe(v.string(), v.nonEmpty()),
  clientId: optionalString,
  clientOpId: optionalString,
  path: optionalString,
  kind: optionalString,
  oldPath: optionalString,
  newPath: optionalString,
  contentFingerprint: optionalString,
});

export function createObsidianVaultFacade(app: App): SyncedVaultFacade {
  const { vault, fileManager } = app;
  return {
    async kind(path) {
      const file = vault.getAbstractFileByPath(path);
      return file ? detectVaultFileKind(vault, file) : null;
    },
    async read(path, kind) {
      const file = vault.getAbstractFileByPath(path);
      if (!isVaultFile(file)) {
        return null;
      }

      return kind === "text"
        ? vault.cachedRead(file)
        : new Uint8Array(await vault.readBinary(file));
    },
    async create(path, kind, content) {
      if (kind === "directory") {
        await vault.createFolder(path);
        return;
      }

      if (kind === "text") {
        await vault.create(path, content as string);
        return;
      }

      await vault.createBinary(path, toArrayBuffer(content as Uint8Array));
    },
    async modify(path, kind, content) {
      const file = vault.getAbstractFileByPath(path);
      if (!isVaultFile(file)) {
        throw new Error(`Missing file "${path}"`);
      }

      if (kind === "text") {
        await vault.process(file, () => content as string);
        return;
      }

      await vault.modifyBinary(file, toArrayBuffer(content as Uint8Array));
    },
    async rename(oldPath, newPath) {
      const file = vault.getAbstractFileByPath(oldPath);
      if (!file) {
        throw new Error(`Missing entry "${oldPath}"`);
      }
      await vault.rename(file, newPath);
    },
    async delete(path) {
      const file = vault.getAbstractFileByPath(path);
      if (!file) {
        throw new Error(`Missing entry "${path}"`);
      }
      await fileManager.trashFile(file);
    },
    async ensureParentDir(path) {
      const parent = dirname(path);
      if (parent === "." || parent === "/") {
        return;
      }
      try {
        await vault.adapter.mkdir(parent);
      } catch {}
    },
  };
}

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

function parseMetadataEvent(rawEvent: Y.Map<unknown>): MetadataEvent | null {
  const parsed = v.safeParse(
    metadataEventSchema,
    Object.fromEntries(rawEvent.entries()),
  );
  if (!parsed.success) {
    return null;
  }

  return {
    ...parsed.output,
    eventId: Math.trunc(parsed.output.eventId),
    kind: coerceFileKind(parsed.output.kind) ?? "text",
  };
}

function getEventPath(event: Pick<MetadataEvent, "path" | "newPath">): string {
  return event.path ?? event.newPath ?? "";
}

function sameContent(left: SyncedFileData, right: SyncedFileData): boolean {
  return typeof left === "string" && typeof right === "string"
    ? left === right
    : left instanceof Uint8Array &&
        right instanceof Uint8Array &&
        byteArraysEqual(left, right);
}

const textEncoder = new TextEncoder();

async function fingerprintBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

async function fingerprintContent(content: SyncedFileData): Promise<string> {
  return await fingerprintBytes(
    typeof content === "string" ? textEncoder.encode(content) : content,
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

export class MetadataMirror {
  private readonly vault: SyncedVaultFacade;
  private readonly connection: ConnectionManager;
  private readonly echoPrevention: EchoPrevention;
  private readonly localClientId: string;
  private readonly getSyncState: () => SyncState;
  private readonly updateSyncState: (
    updater: (syncState: SyncState) => SyncState,
  ) => void;
  private readonly notify: (message: string) => void;
  private readonly registerConflictCopy?:
    | ((path: string) => Promise<void>)
    | undefined;
  private readonly logger: PluginLogger;
  private readonly metaEventsObserver: () => void;
  private enabled = false;
  private draining = false;
  private drainAgain = false;
  private activeDrain: Promise<void> = Promise.resolve();

  constructor(configuration: MetadataMirrorConfiguration) {
    this.vault = configuration.vaultFacade;
    this.connection = configuration.connection;
    this.echoPrevention = configuration.echoPrevention;
    this.localClientId = configuration.localClientId;
    this.getSyncState = configuration.getSyncState;
    this.updateSyncState = configuration.updateSyncState;
    this.notify = configuration.notify;
    this.registerConflictCopy = configuration.registerConflictCopy;
    this.logger = configuration.logger ?? new PluginLogger(false);
    this.metaEventsObserver = () => {
      if (!this.enabled) {
        return;
      }

      void this.replayAvailableEvents();
    };
    this.connection.metaEvents.observe(this.metaEventsObserver);
    configuration.owner?.register(() => this.destroy());
  }

  enable(): void {
    this.enabled = true;
    void this.replayAvailableEvents();
  }

  disable(): void {
    this.enabled = false;
  }

  destroy(): void {
    this.connection.metaEvents.unobserve(this.metaEventsObserver);
  }

  replayAvailableEvents(): Promise<void> {
    this.drainAgain = true;
    if (this.draining) {
      return this.activeDrain;
    }

    this.draining = true;
    this.activeDrain = (async () => {
      try {
        do {
          this.drainAgain = false;
          await this.drainPendingEvents();
        } while (this.drainAgain);
      } finally {
        this.draining = false;
      }
    })();

    return this.activeDrain;
  }

  async reconcileRejectedOperation(
    message: MetadataRejectMessage,
    pendingOperation?: PendingMetadataOp,
  ): Promise<void> {
    this.logger.debug("reconciling rejected operation", {
      requestType: message.requestType,
      fileId: message.fileId,
      reason: message.reason,
      currentPath: message.currentPath,
    });
    switch (message.requestType) {
      case "file.create":
        await this.reconcileRejectedCreate(message, pendingOperation);
        return;
      case "file.rename":
        await this.reconcileRejectedRename(message, pendingOperation);
        return;
      case "file.delete":
        await this.reconcileRejectedDelete(message);
        return;
    }
  }

  private async drainPendingEvents(): Promise<void> {
    const currentCursor = this.getSyncState().lastAppliedMetaEventId;
    const pendingEvents = this.connection.metaEvents
      .toArray()
      .map(parseMetadataEvent)
      .filter((event): event is MetadataEvent => event !== null)
      .filter((event) => event.eventId > currentCursor)
      .sort((left, right) => left.eventId - right.eventId);

    for (const event of pendingEvents) {
      this.logger.debug("applying remote metadata event", {
        type: event.type,
        fileId: event.fileId,
        eventId: event.eventId,
        path: getEventPath(event) || undefined,
      });
      try {
        await this.applyEvent(event);
        this.updateSyncState((syncState) =>
          advanceMetaCursor(syncState, event.eventId),
        );
      } catch (err) {
        this.logger.error("failed to apply remote metadata event", {
          type: event.type,
          fileId: event.fileId,
          eventId: event.eventId,
          path: getEventPath(event) || undefined,
          error: err instanceof Error ? err.message : String(err),
        });
        this.notify(
          `Sync could not apply remote ${event.type} for "${getEventPath(event) || event.fileId}". Local data was preserved where possible.`,
        );
        break;
      }
    }
  }

  private async applyEvent(event: MetadataEvent): Promise<void> {
    switch (event.type) {
      case "file.create":
        if (!event.path) {
          throw new Error("Create event is missing path");
        }
        if (!isValidVaultPath(event.path)) {
          throw new Error(`Create event has invalid path: "${event.path}"`);
        }
        await this.applyCreate(event);
        return;
      case "file.rename":
        if (!event.newPath) {
          throw new Error("Rename event is missing newPath");
        }
        if (!isValidVaultPath(event.newPath)) {
          throw new Error(
            `Rename event has invalid newPath: "${event.newPath}"`,
          );
        }
        await this.applyRename(
          event.fileId,
          event.oldPath,
          event.newPath,
          event.kind,
        );
        return;
      case "file.delete":
        await this.applyDelete(
          event.fileId,
          event.path,
          event.kind,
          event.contentFingerprint,
        );
        return;
    }
  }

  private async applyCreate(event: MetadataEvent): Promise<void> {
    const { fileId, path, kind } = event;
    if (!path) {
      throw new Error("Create event is missing path");
    }

    const existingKind = await this.vault.kind(path);
    if (existingKind === kind) {
      if (kind === "directory" || event.clientId === this.localClientId) {
        return;
      }

      const localContent = await this.vault.read(path, kind);
      const remoteContent = this.getRemoteContent(fileId, kind);
      if (localContent !== null && sameContent(localContent, remoteContent)) {
        return;
      }
    }

    if (existingKind !== null) {
      await this.preserveConflictCopy(path);
    }

    await this.materializeRemoteEntry(fileId, path, kind);
  }

  private async applyRename(
    fileId: string,
    oldPath: string | undefined,
    newPath: string,
    kind: FileKind,
  ): Promise<void> {
    const existingDestinationKind = await this.vault.kind(newPath);
    if (oldPath === newPath && existingDestinationKind === kind) {
      return;
    }

    const existingSourceKind = oldPath ? await this.vault.kind(oldPath) : null;
    if (!oldPath || existingSourceKind === null) {
      if (existingDestinationKind === kind) {
        if (kind === "directory") {
          return;
        }

        const localContent = await this.vault.read(newPath, kind);
        const remoteContent = this.getRemoteContent(fileId, kind);
        if (localContent !== null && sameContent(localContent, remoteContent)) {
          return;
        }
      }

      if (existingDestinationKind !== null) {
        await this.preserveConflictCopy(newPath);
      }

      await this.materializeRemoteEntry(fileId, newPath, kind);
      return;
    }

    if (kind === "directory" && existingDestinationKind === "directory") {
      await this.deleteEntry(oldPath);
      return;
    }

    if (existingDestinationKind !== null) {
      await this.preserveConflictCopy(newPath);
    }

    await this.renameEntry(oldPath, newPath);
  }

  private async applyDelete(
    fileId: string,
    path: string | undefined,
    kind: FileKind,
    contentFingerprint?: string,
  ): Promise<void> {
    if (!path) {
      return;
    }

    const existingKind = await this.vault.kind(path);
    if (existingKind === null) {
      return;
    }

    if (existingKind !== kind) {
      await this.preserveConflictCopy(path);
      return;
    }

    if (kind === "directory") {
      await this.deleteEntry(path);
      return;
    }

    const localContent = await this.vault.read(path, kind);
    const matchesDeletedContent =
      localContent === null
        ? true
        : contentFingerprint
          ? (await fingerprintContent(localContent)) === contentFingerprint
          : sameContent(localContent, this.getRemoteContent(fileId, kind));
    if (!matchesDeletedContent) {
      await this.preserveConflictCopy(path);
      return;
    }

    await this.deleteEntry(path);
  }

  private async reconcileRejectedCreate(
    message: MetadataRejectMessage,
    pendingOperation?: PendingMetadataOp,
  ): Promise<void> {
    const rejectedPath = pendingOperation?.path;
    if (rejectedPath && (await this.vault.kind(rejectedPath)) !== null) {
      await this.preserveConflictCopy(rejectedPath);
    }

    const canonicalPath = message.currentPath ?? rejectedPath;
    if (!canonicalPath) {
      return;
    }

    const canonicalFileId =
      findActiveFileIdByPath(this.connection.metaFiles, canonicalPath) ??
      message.fileId;
    await this.ensureCanonicalEntry(
      canonicalFileId,
      canonicalPath,
      message.kind ?? pendingOperation?.kind ?? "text",
    );
  }

  private async reconcileRejectedRename(
    message: MetadataRejectMessage,
    pendingOperation?: PendingMetadataOp,
  ): Promise<void> {
    const canonicalPath = message.currentPath ?? pendingOperation?.oldPath;
    const optimisticPath = pendingOperation?.newPath ?? message.newPath;
    if (!canonicalPath || !optimisticPath) {
      if (canonicalPath) {
        await this.ensureCanonicalEntry(
          message.fileId,
          canonicalPath,
          message.kind ?? pendingOperation?.kind ?? "text",
        );
      }
      return;
    }

    if ((await this.vault.kind(optimisticPath)) === null) {
      await this.ensureCanonicalEntry(
        message.fileId,
        canonicalPath,
        message.kind ?? pendingOperation?.kind ?? "text",
      );
      return;
    }

    if ((await this.vault.kind(canonicalPath)) !== null) {
      await this.preserveConflictCopy(canonicalPath);
    }

    await this.renameEntry(optimisticPath, canonicalPath);
  }

  private async reconcileRejectedDelete(
    message: MetadataRejectMessage,
  ): Promise<void> {
    if (!message.currentPath) {
      return;
    }

    await this.ensureCanonicalEntry(
      message.fileId,
      message.currentPath,
      message.kind ?? "text",
    );
  }

  private getRemoteContent(
    fileId: string,
    kind: Exclude<FileKind, "directory">,
  ): SyncedFileData {
    if (kind === "text") {
      const value = this.connection.filesMap.get(fileId);
      return value instanceof Y.Text ? value.toString() : "";
    }

    return (
      getBinaryContent(this.connection.filesMap, fileId) ?? new Uint8Array()
    );
  }

  private async ensureCanonicalEntry(
    fileId: string,
    path: string,
    kind: FileKind,
  ): Promise<void> {
    const localKind = await this.vault.kind(path);
    if (localKind === kind) {
      if (kind === "directory") {
        return;
      }

      const remoteContent = this.getRemoteContent(fileId, kind);
      const localContent = await this.vault.read(path, kind);
      if (localContent === null) {
        await this.writeFile(path, kind, remoteContent);
        return;
      }
      if (!sameContent(localContent, remoteContent)) {
        await this.modifyFile(path, kind, remoteContent);
      }
      return;
    }

    if (localKind !== null) {
      await this.preserveConflictCopy(path);
    }

    await this.materializeRemoteEntry(fileId, path, kind);
  }

  private async materializeRemoteEntry(
    fileId: string,
    path: string,
    kind: FileKind,
  ): Promise<void> {
    if (kind === "directory") {
      await this.createEntry(path, kind);
      return;
    }

    await this.writeFile(path, kind, this.getRemoteContent(fileId, kind));
  }

  private async withTrackedWrites(
    paths: string[],
    action: () => Promise<void>,
  ): Promise<void> {
    const uniquePaths = [...new Set(paths)];
    for (const path of uniquePaths) {
      this.echoPrevention.markWriting(path);
    }

    try {
      await action();
    } finally {
      for (const path of uniquePaths) {
        this.echoPrevention.unmarkWriting(path);
      }
    }
  }

  private makeConflictPath(path: string): string {
    const timestamp = Date.now();
    const dotIndex = path.lastIndexOf(".");
    const suffix = `.sync-conflict-${timestamp}`;

    if (dotIndex === -1) {
      return `${path}${suffix}`;
    }

    return `${path.slice(0, dotIndex)}${suffix}${path.slice(dotIndex)}`;
  }

  private async preserveConflictCopy(path: string): Promise<string> {
    const conflictPath = this.makeConflictPath(path);

    await this.withTrackedWrites([path, conflictPath], async () => {
      await this.vault.ensureParentDir(conflictPath);
      await this.vault.rename(path, conflictPath);
    });
    this.logger.warn("conflict copy preserved", { path, conflictPath });
    this.notify(
      `Sync preserved local data from "${path}" as "${conflictPath}".`,
    );
    if (!this.registerConflictCopy) {
      return conflictPath;
    }

    try {
      await this.registerConflictCopy(conflictPath);
    } catch {
      this.notify(
        `Sync could not queue conflict copy "${conflictPath}" for upload.`,
      );
    }

    return conflictPath;
  }

  private async createEntry(path: string, kind: FileKind): Promise<void> {
    await this.withTrackedWrites([path], async () => {
      await this.vault.ensureParentDir(path);
      await this.vault.create(path, kind);
    });
  }

  private async writeFile(
    path: string,
    kind: Exclude<FileKind, "directory">,
    content: SyncedFileData,
  ): Promise<void> {
    await this.withTrackedWrites([path], async () => {
      await this.vault.ensureParentDir(path);
      await this.vault.create(path, kind, content);
    });
  }

  private async modifyFile(
    path: string,
    kind: Exclude<FileKind, "directory">,
    content: SyncedFileData,
  ): Promise<void> {
    await this.withTrackedWrites([path], async () => {
      await this.vault.modify(path, kind, content);
    });
  }

  private async renameEntry(oldPath: string, newPath: string): Promise<void> {
    await this.withTrackedWrites([oldPath, newPath], async () => {
      await this.vault.ensureParentDir(newPath);
      await this.vault.rename(oldPath, newPath);
    });
  }

  private async deleteEntry(path: string): Promise<void> {
    await this.withTrackedWrites([path], async () => {
      await this.vault.delete(path);
    });
  }
}
