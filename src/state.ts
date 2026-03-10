import { isAbsolute, normalize } from "pathe";
import * as v from "valibot";
import type * as Y from "yjs";
import type { FileKind } from "./file-kind";
import { coerceFileKind } from "./file-kind";

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

export const SYNC_STATE_VERSION = 1;

export type MetadataOpType = "file.create" | "file.rename" | "file.delete";

export interface PersistedFileEntry {
  path: string;
  kind?: FileKind;
  deleted: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface PendingMetadataOp {
  clientOpId: string;
  type: MetadataOpType;
  fileId: string;
  kind?: FileKind;
  path?: string;
  oldPath?: string;
  newPath?: string;
  timestamp: number;
}

export interface PendingContentReplay {
  fileId: string;
  path: string;
  kind?: Exclude<FileKind, "directory">;
}

export interface SyncState {
  version: typeof SYNC_STATE_VERSION;
  clientId: string;
  lastAppliedMetaEventId: number;
  fileIndexById: Record<string, PersistedFileEntry>;
  pathIndex: Record<string, string>;
  pendingMetadataOps: PendingMetadataOp[];
  pendingContentReplays: PendingContentReplay[];
}

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const finiteInt = v.pipe(v.number(), v.finite(), v.transform(Math.trunc));
const fileKind = v.picklist([
  "text",
  "binary",
  "directory",
] satisfies FileKind[]);
const sourceSchema = v.object({
  clientId: v.optional(nonEmptyString),
  lastAppliedMetaEventId: v.optional(finiteInt),
  fileIndexById: v.optional(v.record(v.string(), v.unknown())),
  pathIndex: v.optional(v.record(v.string(), v.unknown())),
  pendingMetadataOps: v.optional(v.array(v.unknown())),
  pendingContentReplays: v.optional(v.array(v.unknown())),
});
const fileEntrySchema = v.object({
  path: nonEmptyString,
  kind: v.optional(fileKind),
  deleted: v.optional(v.boolean()),
  createdAt: v.optional(finiteInt),
  updatedAt: v.optional(finiteInt),
});
const metadataOpSchema = v.variant("type", [
  v.object({
    clientOpId: nonEmptyString,
    type: v.literal("file.create"),
    fileId: nonEmptyString,
    kind: v.optional(fileKind),
    path: v.optional(nonEmptyString),
    timestamp: finiteInt,
  }),
  v.object({
    clientOpId: nonEmptyString,
    type: v.literal("file.rename"),
    fileId: nonEmptyString,
    kind: v.optional(fileKind),
    path: v.optional(nonEmptyString),
    oldPath: v.optional(nonEmptyString),
    newPath: v.optional(nonEmptyString),
    timestamp: finiteInt,
  }),
  v.object({
    clientOpId: nonEmptyString,
    type: v.literal("file.delete"),
    fileId: nonEmptyString,
    path: v.optional(nonEmptyString),
    timestamp: finiteInt,
  }),
]);
const contentReplaySchema = v.object({
  fileId: nonEmptyString,
  path: nonEmptyString,
  kind: v.optional(fileKind),
});

function createSyncState(clientId?: string): SyncState {
  return {
    version: SYNC_STATE_VERSION,
    clientId: clientId ?? crypto.randomUUID(),
    lastAppliedMetaEventId: 0,
    fileIndexById: {},
    pathIndex: {},
    pendingMetadataOps: [],
    pendingContentReplays: [],
  };
}

export function loadSyncState(value: unknown): SyncState {
  const parsed = v.safeParse(sourceSchema, value);
  const source = parsed.success ? parsed.output : {};
  const syncState = createSyncState(source.clientId);

  syncState.lastAppliedMetaEventId = source.lastAppliedMetaEventId ?? 0;

  if (source.fileIndexById) {
    for (const [fileId, rawEntry] of Object.entries(source.fileIndexById)) {
      const entry = v.safeParse(fileEntrySchema, rawEntry);
      if (!entry.success || !isValidVaultPath(entry.output.path)) {
        continue;
      }

      syncState.fileIndexById[fileId] = {
        ...entry.output,
        kind: entry.output.kind ?? "text",
        deleted: entry.output.deleted === true,
      };
    }
  }

  for (const [fileId, entry] of Object.entries(syncState.fileIndexById)) {
    if (!entry.deleted && isValidVaultPath(entry.path)) {
      syncState.pathIndex[entry.path] = fileId;
    }
  }

  if (source.pathIndex) {
    for (const [path, fileId] of Object.entries(source.pathIndex)) {
      if (!isValidVaultPath(path)) {
        continue;
      }

      const parsedFileId = v.safeParse(nonEmptyString, fileId);
      if (!parsedFileId.success) {
        continue;
      }

      const entry = syncState.fileIndexById[parsedFileId.output];
      if (entry) {
        if (!entry.deleted && entry.path === path) {
          syncState.pathIndex[path] = parsedFileId.output;
        }
        continue;
      }

      syncState.pathIndex[path] = parsedFileId.output;
    }
  }

  if (source.pendingMetadataOps) {
    for (const rawOp of source.pendingMetadataOps) {
      const operation = v.safeParse(metadataOpSchema, rawOp);
      if (!operation.success) {
        continue;
      }

      syncState.pendingMetadataOps.push({
        ...operation.output,
        kind:
          operation.output.type === "file.delete"
            ? undefined
            : (operation.output.kind ?? "text"),
      });
    }
  }

  if (source.pendingContentReplays) {
    for (const rawReplay of source.pendingContentReplays) {
      const replay = v.safeParse(contentReplaySchema, rawReplay);
      if (!replay.success) {
        continue;
      }

      const kind = replay.output.kind ?? "text";
      if (kind !== "directory") {
        syncState.pendingContentReplays.push({
          ...replay.output,
          kind,
        });
      }
    }
  }

  return syncState;
}

export function enqueueMetadataOp(
  syncState: SyncState,
  operation: PendingMetadataOp,
): SyncState {
  return {
    ...syncState,
    pendingMetadataOps: [
      ...syncState.pendingMetadataOps.filter(
        (pendingOp) => pendingOp.clientOpId !== operation.clientOpId,
      ),
      { ...operation },
    ],
  };
}

export function ackMetadataOp(
  syncState: SyncState,
  clientOpId: string,
): SyncState {
  return {
    ...syncState,
    pendingMetadataOps: syncState.pendingMetadataOps.filter(
      (pendingOp) => pendingOp.clientOpId !== clientOpId,
    ),
  };
}

export function queuePendingContentReplay(
  syncState: SyncState,
  replay: PendingContentReplay,
): SyncState {
  return {
    ...syncState,
    pendingContentReplays: [
      ...syncState.pendingContentReplays.filter(
        (pendingReplay) => pendingReplay.fileId !== replay.fileId,
      ),
      { ...replay },
    ],
  };
}

export function clearPendingContentReplay(
  syncState: SyncState,
  fileId: string,
): SyncState {
  return {
    ...syncState,
    pendingContentReplays: syncState.pendingContentReplays.filter(
      (pendingReplay) => pendingReplay.fileId !== fileId,
    ),
  };
}

export function advanceMetaCursor(
  syncState: SyncState,
  metaEventId: number,
): SyncState {
  return {
    ...syncState,
    lastAppliedMetaEventId: Math.max(
      syncState.lastAppliedMetaEventId,
      Math.trunc(metaEventId),
    ),
  };
}

export function buildIndexesFromMetaFiles(
  metaFiles: Y.Map<Y.Map<unknown>>,
): Pick<SyncState, "fileIndexById" | "pathIndex"> {
  const fileIndexById: Record<string, PersistedFileEntry> = {};
  const pathIndex: Record<string, string> = {};

  for (const [fileId, metadata] of metaFiles.entries()) {
    const parsed = v.safeParse(fileEntrySchema, {
      path: metadata.get("path"),
      kind: coerceFileKind(metadata.get("kind")),
      deleted: metadata.get("deleted"),
      createdAt: metadata.get("createdAt"),
      updatedAt: metadata.get("updatedAt"),
    });
    if (!parsed.success || !isValidVaultPath(parsed.output.path)) {
      continue;
    }

    const entry: PersistedFileEntry = {
      ...parsed.output,
      kind: parsed.output.kind ?? "text",
      deleted: parsed.output.deleted === true,
    };
    fileIndexById[fileId] = entry;

    if (!entry.deleted) {
      pathIndex[entry.path] = fileId;
    }
  }

  return { fileIndexById, pathIndex };
}
