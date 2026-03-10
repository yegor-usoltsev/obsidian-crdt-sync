import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  ackMetadataOp,
  advanceMetaCursor,
  buildIndexesFromMetaFiles,
  clearPendingContentReplay,
  enqueueMetadataOp,
  loadSyncState,
  queuePendingContentReplay,
  SYNC_STATE_VERSION,
  type SyncState,
} from "../src/state";

const reload = <T>(value: T) => loadSyncState(structuredClone(value));

describe("sync state", () => {
  test("initializes a versioned sync state with a stable clientId", () => {
    const syncState = loadSyncState(undefined);

    expect(syncState.version).toBe(SYNC_STATE_VERSION);
    expect(syncState.clientId.length).toBeGreaterThan(0);
    expect(syncState.lastAppliedMetaEventId).toBe(0);
    expect(syncState.fileIndexById).toEqual({});
    expect(syncState.pathIndex).toEqual({});
    expect(syncState.pendingMetadataOps).toEqual([]);
    expect(syncState.pendingContentReplays).toEqual([]);
  });

  test("restart persistence preserves clientId, indexes, cursor, and metadata queue", () => {
    const initialState = loadSyncState(undefined);
    const queuedState = enqueueMetadataOp(advanceMetaCursor(initialState, 7), {
      clientOpId: "op-1",
      type: "file.rename",
      fileId: "file-1",
      kind: "text",
      oldPath: "note.md",
      newPath: "renamed.md",
      path: "renamed.md",
      timestamp: 1_700_000_000_000,
    });

    const persisted: SyncState = {
      ...queuedState,
      fileIndexById: {
        "file-1": {
          path: "renamed.md",
          kind: "text",
          deleted: false,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_123,
        },
      },
      pathIndex: {
        "renamed.md": "file-1",
      },
      pendingContentReplays: [
        { fileId: "file-1", path: "renamed.md", kind: "text" },
      ],
    };
    const reloaded = reload(persisted);

    expect(reloaded).toEqual(persisted);
    expect(reloaded.clientId).toBe(initialState.clientId);
  });

  test("pending metadata ops survive save/load and acknowledgements remove only the matching op", () => {
    const initialState = loadSyncState(undefined);
    const withCreate = enqueueMetadataOp(initialState, {
      clientOpId: "op-1",
      type: "file.create",
      fileId: "file-1",
      path: "note.md",
      timestamp: 1,
    });
    const withDelete = enqueueMetadataOp(withCreate, {
      clientOpId: "op-2",
      type: "file.delete",
      fileId: "file-2",
      path: "other.md",
      timestamp: 2,
    });

    const reloaded = reload(withDelete);
    const acked = ackMetadataOp(reloaded, "op-1");

    expect(reloaded.pendingMetadataOps.map((op) => op.clientOpId)).toEqual([
      "op-1",
      "op-2",
    ]);
    expect(acked.pendingMetadataOps.map((op) => op.clientOpId)).toEqual([
      "op-2",
    ]);
  });

  test("metadata cursor persists monotonically and file indexes rebuild from vault-meta", () => {
    const metaDoc = new Y.Doc();
    const metaFiles = metaDoc.getMap<Y.Map<unknown>>("files");

    metaDoc.transact(() => {
      const activeFile = new Y.Map<unknown>();
      activeFile.set("path", "active.md");
      activeFile.set("deleted", false);
      activeFile.set("createdAt", 10);
      activeFile.set("updatedAt", 11);
      metaFiles.set("file-1", activeFile);

      const deletedFile = new Y.Map<unknown>();
      deletedFile.set("path", "deleted.md");
      deletedFile.set("deleted", true);
      deletedFile.set("createdAt", 20);
      deletedFile.set("updatedAt", 21);
      metaFiles.set("file-2", deletedFile);
    });

    const indexedState = {
      ...advanceMetaCursor(advanceMetaCursor(loadSyncState(undefined), 3), 2),
      ...buildIndexesFromMetaFiles(metaFiles),
    };
    const reloaded = reload(indexedState);

    expect(reloaded.lastAppliedMetaEventId).toBe(3);
    expect(reloaded.fileIndexById).toEqual({
      "file-1": {
        path: "active.md",
        kind: "text",
        deleted: false,
        createdAt: 10,
        updatedAt: 11,
      },
      "file-2": {
        path: "deleted.md",
        kind: "text",
        deleted: true,
        createdAt: 20,
        updatedAt: 21,
      },
    });
    expect(reloaded.pathIndex).toEqual({
      "active.md": "file-1",
    });
  });

  test("loadSyncState drops stale pathIndex entries for deleted canonical files", () => {
    const reloaded = reload({
      ...loadSyncState(undefined),
      fileIndexById: {
        "file-1": {
          path: "note.md",
          kind: "text",
          deleted: true,
        },
      },
      pathIndex: {
        "note.md": "file-1",
      },
    });

    expect(reloaded.fileIndexById).toEqual({
      "file-1": {
        path: "note.md",
        kind: "text",
        deleted: true,
      },
    });
    expect(reloaded.pathIndex).toEqual({});
  });

  test("loadSyncState drops stale pathIndex entries that disagree with canonical paths", () => {
    const reloaded = reload({
      ...loadSyncState(undefined),
      fileIndexById: {
        "file-1": {
          path: "renamed.md",
          kind: "text",
          deleted: false,
        },
      },
      pathIndex: {
        "note.md": "file-1",
      },
    });

    expect(reloaded.pathIndex).toEqual({
      "renamed.md": "file-1",
    });
  });

  test("pending content replays survive save/load and can be cleared by fileId", () => {
    const initialState = loadSyncState(undefined);
    const queued = queuePendingContentReplay(initialState, {
      fileId: "file-1",
      path: "note.md",
      kind: "text",
    });
    const reloaded = reload(queued);
    const cleared = clearPendingContentReplay(reloaded, "file-1");

    expect(reloaded.pendingContentReplays).toEqual([
      { fileId: "file-1", path: "note.md", kind: "text" },
    ]);
    expect(cleared.pendingContentReplays).toEqual([]);
  });

  test("queue helpers replace existing entries with the same identity", () => {
    const initialState = loadSyncState(undefined);
    const updatedOps = enqueueMetadataOp(
      enqueueMetadataOp(initialState, {
        clientOpId: "op-1",
        type: "file.create",
        fileId: "file-1",
        path: "draft.md",
        timestamp: 1,
      }),
      {
        clientOpId: "op-1",
        type: "file.rename",
        fileId: "file-1",
        oldPath: "draft.md",
        newPath: "renamed.md",
        path: "renamed.md",
        timestamp: 2,
      },
    );
    const updatedReplays = queuePendingContentReplay(
      queuePendingContentReplay(updatedOps, {
        fileId: "file-1",
        path: "draft.md",
        kind: "text",
      }),
      {
        fileId: "file-1",
        path: "renamed.md",
        kind: "text",
      },
    );

    expect(updatedReplays.pendingMetadataOps).toEqual([
      {
        clientOpId: "op-1",
        type: "file.rename",
        fileId: "file-1",
        oldPath: "draft.md",
        newPath: "renamed.md",
        path: "renamed.md",
        timestamp: 2,
      },
    ]);
    expect(updatedReplays.pendingContentReplays).toEqual([
      { fileId: "file-1", path: "renamed.md", kind: "text" },
    ]);
  });
});
