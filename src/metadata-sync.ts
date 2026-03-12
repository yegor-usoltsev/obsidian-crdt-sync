import { WebSocketStatus } from "@hocuspocus/provider";
import type { Component } from "obsidian";
import { join, normalize, relative } from "pathe";
import type { ConnectionManager } from "./connection";
import { findActiveFileIdByPath, getPathForFileId } from "./file-index";
import type { FileKind } from "./file-kind";
import {
  ackMetadataOp,
  clearPendingContentReplay,
  enqueueMetadataOp,
  type MetadataOpType,
  type PendingMetadataOp,
  queuePendingContentReplay,
  type SyncState,
} from "./state";
import { isIgnoredSyncPath } from "./sync-ignore";
import { setTextContent, writeBinaryContent } from "./y-text-content";

export interface MetadataOpTraceFields {
  clientId?: string;
  clientOpId?: string;
  fileId: string;
  metaEventId?: number;
  path?: string;
  timestamp?: number;
}

export interface FileCreateRequest extends MetadataOpTraceFields {
  type: "file.create";
  path: string;
  kind: FileKind;
}

export interface FileRenameRequest extends MetadataOpTraceFields {
  type: "file.rename";
  oldPath?: string;
  newPath: string;
  kind: FileKind;
}

export interface FileDeleteRequest extends MetadataOpTraceFields {
  type: "file.delete";
  path?: string;
}

export interface MetadataCommitMessage extends MetadataOpTraceFields {
  type: "metadata.commit";
  requestType: MetadataOpType;
  path?: string;
  kind?: FileKind;
  oldPath?: string;
  newPath?: string;
  deduplicated?: boolean;
}

export interface MetadataRejectMessage extends MetadataOpTraceFields {
  type: "metadata.reject";
  requestType: MetadataOpType;
  reason: string;
  currentPath?: string;
  kind?: FileKind;
  oldPath?: string;
  newPath?: string;
}

export type MetadataOpRequest =
  | FileCreateRequest
  | FileRenameRequest
  | FileDeleteRequest;

export type MetadataStatelessMessage =
  | MetadataOpRequest
  | MetadataCommitMessage
  | MetadataRejectMessage;

export type MetadataStatelessHandler = (
  message: MetadataStatelessMessage,
) => void;

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
    normalizedPath !== normalizedOldPath &&
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

function getOperationSyncKind(
  kind: FileKind | undefined,
): "file" | "directory" {
  return kind === "directory" ? "directory" : "file";
}

interface MetadataSyncConfiguration {
  connection: ConnectionManager;
  clientId: string;
  getSyncState: () => SyncState;
  updateSyncState: (updater: (syncState: SyncState) => SyncState) => void;
  getConfigDir?: () => string;
  readLocalFile: (
    path: string,
    kind: Exclude<FileKind, "directory">,
  ) => Promise<string | Uint8Array | null>;
  notify: (message: string) => void;
  persistSyncStateNow?: () => Promise<void>;
  reconcileRejectedOperation?: (
    message: MetadataRejectMessage,
    pendingOperation?: PendingMetadataOp,
  ) => Promise<void>;
  owner?: Pick<Component, "register">;
}

export class MetadataSync {
  private readonly connection: ConnectionManager;
  private readonly clientId: string;
  private readonly getSyncState: () => SyncState;
  private readonly updateSyncState: (
    updater: (syncState: SyncState) => SyncState,
  ) => void;
  private readonly getConfigDir: (() => string) | undefined;
  private readonly readLocalFile: (
    path: string,
    kind: Exclude<FileKind, "directory">,
  ) => Promise<string | Uint8Array | null>;
  private readonly notify: (message: string) => void;
  private readonly persistSyncStateNow?: (() => Promise<void>) | undefined;
  private readonly reconcileRejectedOperation?:
    | ((
        message: MetadataRejectMessage,
        pendingOperation?: PendingMetadataOp,
      ) => Promise<void>)
    | undefined;
  private readonly pendingPaths = new Map<string, string>();
  private removeStatelessHandler: (() => void) | null = null;

  constructor(configuration: MetadataSyncConfiguration) {
    this.connection = configuration.connection;
    this.clientId = configuration.clientId;
    this.getSyncState = configuration.getSyncState;
    this.updateSyncState = configuration.updateSyncState;
    this.getConfigDir = configuration.getConfigDir;
    this.readLocalFile = configuration.readLocalFile;
    this.notify = configuration.notify;
    this.persistSyncStateNow = configuration.persistSyncStateNow;
    this.reconcileRejectedOperation = configuration.reconcileRejectedOperation;
    this.removeStatelessHandler = this.connection.addStatelessHandler((msg) => {
      if (msg.type === "metadata.commit") {
        void this.handleCommit(msg);
      } else if (msg.type === "metadata.reject") {
        void this.handleReject(msg);
      }
    });
    configuration.owner?.register(() => this.destroy());
    const initialState = this.getSyncState();
    for (const [path, fileId] of Object.entries(initialState.pathIndex)) {
      this.rememberPath(fileId, path);
    }
  }

  resolveFileId(path: string): string | undefined {
    return (
      findActiveFileIdByPath(this.connection.metaFiles, path) ??
      this.pendingPaths.get(path)
    );
  }

  rememberPath(fileId: string, path: string): void {
    this.clearFileId(fileId);
    this.pendingPaths.set(path, fileId);
  }

  async queuePendingContentReplay(
    fileId: string,
    path: string,
    kind: Exclude<FileKind, "directory">,
  ): Promise<void> {
    if (isIgnoredSyncPath(path, "file", this.getConfigDir?.())) {
      return;
    }
    this.rememberPath(fileId, path);
    this.updateSyncState((syncState) =>
      queuePendingContentReplay(syncState, { fileId, path, kind }),
    );
    await this.persistSyncStateNow?.();
  }

  async replayPendingContentChanges(): Promise<void> {
    for (const replay of this.getSyncState().pendingContentReplays) {
      const replayKind = replay.kind ?? "text";
      const indexedPath =
        this.getSyncState().fileIndexById[replay.fileId]?.path;
      const replayPathCandidates = Array.from(
        new Set(
          [replay.path, indexedPath].filter((path): path is string => {
            return (
              typeof path === "string" &&
              path.length > 0 &&
              !isIgnoredSyncPath(path, "file", this.getConfigDir?.())
            );
          }),
        ),
      );
      if (replayPathCandidates.length === 0) {
        this.updateSyncState((syncState) =>
          clearPendingContentReplay(syncState, replay.fileId),
        );
        await this.persistSyncStateNow?.();
        continue;
      }
      let localContent: string | Uint8Array | null = null;

      for (const candidatePath of replayPathCandidates) {
        localContent = await this.readLocalFile(candidatePath, replayKind);
        if (localContent !== null) {
          break;
        }
      }

      if (localContent === null) {
        continue;
      }

      this.connection.contentDoc.transact(() => {
        if (replayKind === "text") {
          setTextContent(
            this.connection.filesMap,
            replay.fileId,
            localContent as string,
          );
        }
      }, "local");
      if (replayKind === "binary") {
        writeBinaryContent(
          this.connection.contentDoc,
          this.connection.filesMap,
          replay.fileId,
          localContent as Uint8Array,
        );
      }
      this.updateSyncState((syncState) =>
        clearPendingContentReplay(syncState, replay.fileId),
      );
      await this.persistSyncStateNow?.();
    }
  }

  hasPendingCreate(fileId: string): boolean {
    return this.getSyncState().pendingMetadataOps.some((op) => {
      return op.fileId === fileId && op.type === "file.create";
    });
  }

  getCanonicalPath(fileId: string): string | undefined {
    return getPathForFileId(this.connection.metaFiles, fileId);
  }

  isCoveredByPendingDirectoryRename(oldPath: string, newPath: string): boolean {
    const normalizedNewPath = normalizeVaultPath(newPath);
    return this.getSyncState().pendingMetadataOps.some((op) => {
      return (
        op.type === "file.rename" &&
        op.kind === "directory" &&
        typeof op.oldPath === "string" &&
        typeof op.newPath === "string" &&
        remapDescendantPath(oldPath, op.oldPath, op.newPath) ===
          normalizedNewPath
      );
    });
  }

  requestCreate(
    path: string,
    kind: FileKind = "text",
  ): { clientOpId: string; fileId: string } {
    const operation: PendingMetadataOp = {
      clientOpId: crypto.randomUUID(),
      type: "file.create",
      fileId: crypto.randomUUID(),
      kind,
      path,
      timestamp: Date.now(),
    };

    this.rememberPath(operation.fileId, path);
    this.enqueueAndMaybeSend(operation);

    return {
      clientOpId: operation.clientOpId,
      fileId: operation.fileId,
    };
  }

  requestRename(
    fileId: string,
    oldPath: string,
    newPath: string,
    kind: FileKind = "text",
  ): { clientOpId: string } {
    const operation: PendingMetadataOp = {
      clientOpId: crypto.randomUUID(),
      type: "file.rename",
      fileId,
      kind,
      oldPath,
      newPath,
      path: newPath,
      timestamp: Date.now(),
    };

    this.rememberPath(fileId, newPath);
    this.enqueueAndMaybeSend(operation);
    this.updateSyncState((syncState) => {
      if (
        !syncState.pendingContentReplays.some(
          (replay) => replay.fileId === fileId,
        )
      ) {
        return syncState;
      }
      if (kind === "directory") {
        return clearPendingContentReplay(syncState, fileId);
      }

      return queuePendingContentReplay(syncState, {
        fileId,
        path: newPath,
        kind,
      });
    });
    void this.persistSyncStateNow?.();

    return { clientOpId: operation.clientOpId };
  }

  requestDelete(fileId: string, path: string): { clientOpId: string } {
    const operation: PendingMetadataOp = {
      clientOpId: crypto.randomUUID(),
      type: "file.delete",
      fileId,
      path,
      timestamp: Date.now(),
    };

    this.clearFileId(fileId);
    this.enqueueAndMaybeSend(operation);
    this.updateSyncState((syncState) =>
      clearPendingContentReplay(syncState, fileId),
    );
    void this.persistSyncStateNow?.();

    return { clientOpId: operation.clientOpId };
  }

  onConnectionSynced(): void {
    this.replayPendingOps();
  }

  destroy(): void {
    this.removeStatelessHandler?.();
    this.removeStatelessHandler = null;
  }

  private enqueueAndMaybeSend(operation: PendingMetadataOp): void {
    this.updateSyncState((syncState) =>
      enqueueMetadataOp(syncState, operation),
    );

    if (this.connection.status === WebSocketStatus.Connected) {
      this.sendOperation(operation);
    }
  }

  private replayPendingOps(): void {
    if (this.connection.status !== WebSocketStatus.Connected) {
      return;
    }

    for (const operation of this.getSyncState().pendingMetadataOps) {
      this.sendOperation(operation);
    }
  }

  private sendOperation(operation: PendingMetadataOp): void {
    if (this.getIgnoredOperationPath(operation)) {
      this.dropOperation(operation);
      return;
    }
    try {
      this.connection.sendStateless(this.toRequest(operation));
    } catch {
      this.updateSyncState((syncState) =>
        ackMetadataOp(syncState, operation.clientOpId),
      );
    }
  }

  private getIgnoredOperationPath(
    operation: PendingMetadataOp,
  ): string | undefined {
    switch (operation.type) {
      case "file.create":
        return operation.path &&
          isIgnoredSyncPath(
            operation.path,
            getOperationSyncKind(operation.kind),
            this.getConfigDir?.(),
          )
          ? operation.path
          : undefined;
      case "file.rename":
        return operation.newPath &&
          isIgnoredSyncPath(
            operation.newPath,
            getOperationSyncKind(operation.kind),
            this.getConfigDir?.(),
          )
          ? operation.newPath
          : undefined;
      case "file.delete":
        return undefined;
    }
  }

  private dropOperation(operation: PendingMetadataOp): void {
    this.updateSyncState((syncState) =>
      ackMetadataOp(syncState, operation.clientOpId),
    );

    switch (operation.type) {
      case "file.create":
        if (operation.path) {
          this.pendingPaths.delete(operation.path);
        }
        this.clearFileId(operation.fileId);
        break;
      case "file.rename": {
        if (operation.newPath) {
          this.pendingPaths.delete(operation.newPath);
        }
        const restoredPath = operation.oldPath ?? operation.newPath;
        if (restoredPath) {
          this.rememberPath(operation.fileId, restoredPath);
        }
        break;
      }
      case "file.delete":
        break;
    }

    void this.persistSyncStateNow?.();
  }

  private toRequest(operation: PendingMetadataOp): MetadataOpRequest {
    switch (operation.type) {
      case "file.create":
        if (!operation.path) {
          throw new Error(
            `Corrupt pending create op "${operation.clientOpId}": missing path`,
          );
        }
        return {
          type: operation.type,
          clientId: this.clientId,
          clientOpId: operation.clientOpId,
          fileId: operation.fileId,
          kind: operation.kind ?? "text",
          timestamp: operation.timestamp,
          path: operation.path,
        };
      case "file.rename":
        if (!operation.newPath) {
          throw new Error(
            `Corrupt pending rename op "${operation.clientOpId}": missing newPath`,
          );
        }
        return {
          type: operation.type,
          clientId: this.clientId,
          clientOpId: operation.clientOpId,
          fileId: operation.fileId,
          kind: operation.kind ?? "text",
          timestamp: operation.timestamp,
          oldPath: operation.oldPath,
          newPath: operation.newPath,
          path: operation.newPath,
        };
      case "file.delete":
        return {
          type: operation.type,
          clientId: this.clientId,
          clientOpId: operation.clientOpId,
          fileId: operation.fileId,
          timestamp: operation.timestamp,
          path: operation.path,
        };
    }
  }

  private async handleCommit(message: MetadataCommitMessage): Promise<void> {
    if (message.clientId !== this.clientId || !message.clientOpId) {
      return;
    }
    const clientOpId = message.clientOpId;

    this.updateSyncState((syncState) => {
      return ackMetadataOp(syncState, clientOpId);
    });

    switch (message.requestType) {
      case "file.create":
        if (message.path) {
          this.rememberPath(message.fileId, message.path);
          const kind = message.kind ?? "text";
          if (kind !== "directory") {
            await this.seedContentFromDisk(message.fileId, message.path, kind);
          }
        }
        return;
      case "file.rename":
        this.clearFileId(message.fileId);
        if (message.newPath) {
          this.rememberPath(message.fileId, message.newPath);
        }
        return;
      case "file.delete":
        this.clearFileId(message.fileId);
        return;
    }
  }

  private async handleReject(message: MetadataRejectMessage): Promise<void> {
    if (message.clientId !== this.clientId || !message.clientOpId) {
      return;
    }
    const clientOpId = message.clientOpId;

    const pendingOperation = this.getSyncState().pendingMetadataOps.find(
      (op) => {
        return op.clientOpId === clientOpId;
      },
    );

    this.updateSyncState((syncState) => {
      return ackMetadataOp(syncState, clientOpId);
    });

    this.restorePathsAfterReject(message, pendingOperation);
    this.notify(`Sync rejected local change: ${message.reason}`);

    if (this.reconcileRejectedOperation) {
      await this.reconcileRejectedOperation(message, pendingOperation);
    }
  }

  private async seedContentFromDisk(
    fileId: string,
    path: string,
    kind: Exclude<FileKind, "directory">,
  ): Promise<void> {
    if (this.connection.filesMap.has(fileId)) {
      return;
    }

    const content = await this.readLocalFile(path, kind);
    if (content === null) {
      return;
    }

    if (kind === "text") {
      this.connection.contentDoc.transact(() => {
        if (this.connection.filesMap.has(fileId)) {
          return;
        }
        setTextContent(this.connection.filesMap, fileId, content as string);
      }, "local");
      return;
    }

    if (this.connection.filesMap.has(fileId)) {
      return;
    }
    writeBinaryContent(
      this.connection.contentDoc,
      this.connection.filesMap,
      fileId,
      content as Uint8Array,
    );
  }

  private restorePathsAfterReject(
    message: MetadataRejectMessage,
    pendingOperation?: PendingMetadataOp,
  ): void {
    if (!pendingOperation) {
      return;
    }

    switch (pendingOperation.type) {
      case "file.create":
        if (pendingOperation.path) {
          this.pendingPaths.delete(pendingOperation.path);
        }
        this.clearFileId(pendingOperation.fileId);
        return;
      case "file.rename":
        if (pendingOperation.newPath) {
          this.pendingPaths.delete(pendingOperation.newPath);
        }
        break;
      case "file.delete":
        break;
    }

    const restoredPath =
      message.currentPath ??
      (pendingOperation.type === "file.rename"
        ? (pendingOperation.oldPath ?? pendingOperation.newPath)
        : pendingOperation.path);
    if (restoredPath) {
      this.rememberPath(pendingOperation.fileId, restoredPath);
    }
  }

  private clearFileId(fileId: string): void {
    for (const [path, trackedFileId] of this.pendingPaths.entries()) {
      if (trackedFileId === fileId) {
        this.pendingPaths.delete(path);
      }
    }
  }
}
