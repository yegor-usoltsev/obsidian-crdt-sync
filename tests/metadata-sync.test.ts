import { beforeEach, describe, expect, test } from "bun:test";
import { WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import {
  type MetadataStatelessHandler,
  type MetadataStatelessMessage,
  MetadataSync,
} from "../src/metadata-sync";
import { loadSyncState, type SyncState } from "../src/state";

interface FakeConnection {
  status: WebSocketStatus;
  contentDoc: Y.Doc;
  filesMap: Y.Map<Y.Text>;
  metaFiles: Y.Map<Y.Map<unknown>>;
  sentMessages: MetadataStatelessMessage[];
  addStatelessHandler: (handler: MetadataStatelessHandler) => () => void;
  sendStateless: (message: MetadataStatelessMessage) => void;
  emitStateless: (message: MetadataStatelessMessage) => Promise<void>;
}

function createFakeConnection(): FakeConnection {
  const contentDoc = new Y.Doc();
  const metaDoc = new Y.Doc();
  const handlers = new Set<MetadataStatelessHandler>();
  const sentMessages: MetadataStatelessMessage[] = [];

  return {
    status: WebSocketStatus.Connected,
    contentDoc,
    filesMap: contentDoc.getMap<Y.Text>("files"),
    metaFiles: metaDoc.getMap<Y.Map<unknown>>("files"),
    sentMessages,
    addStatelessHandler(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    sendStateless(message) {
      sentMessages.push(message);
    },
    async emitStateless(message) {
      for (const handler of handlers) {
        handler(message);
      }
      await Bun.sleep(0);
    },
  };
}

describe("MetadataSync", () => {
  let syncState: SyncState;
  let notices: string[];

  beforeEach(() => {
    syncState = loadSyncState(undefined);
    notices = [];
  });

  test("queues local create ops, sends stateless requests, and seeds content on commit", async () => {
    const connection = createFakeConnection();
    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async (path) => {
        return path === "note.md" ? "# local draft" : null;
      },
      notify: (message) => {
        notices.push(message);
      },
    });

    const { clientOpId, fileId } = metadataSync.requestCreate("note.md");

    expect(syncState.pendingMetadataOps).toHaveLength(1);
    expect(connection.sentMessages).toHaveLength(1);
    expect(connection.sentMessages[0]).toMatchObject({
      type: "file.create",
      clientId: syncState.clientId,
      clientOpId,
      fileId,
      path: "note.md",
    });

    await connection.emitStateless({
      type: "metadata.commit",
      requestType: "file.create",
      clientId: syncState.clientId,
      clientOpId,
      fileId,
      metaEventId: 1,
      path: "note.md",
    });

    expect(syncState.pendingMetadataOps).toHaveLength(0);
    expect(connection.filesMap.get(fileId)?.toString()).toBe("# local draft");
    expect(notices).toEqual([]);

    metadataSync.destroy();
  });

  test("replays queued metadata ops in order after reconnect and surfaces rejections", async () => {
    const connection = createFakeConnection();
    connection.status = WebSocketStatus.Disconnected;

    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async () => null,
      notify: (message) => {
        notices.push(message);
      },
    });

    const create = metadataSync.requestCreate("draft.md");
    const rename = metadataSync.requestRename(
      create.fileId,
      "draft.md",
      "renamed.md",
    );
    const del = metadataSync.requestDelete(create.fileId, "renamed.md");

    expect(connection.sentMessages).toHaveLength(0);
    expect(syncState.pendingMetadataOps.map((op) => op.type)).toEqual([
      "file.create",
      "file.rename",
      "file.delete",
    ]);

    connection.status = WebSocketStatus.Connected;
    metadataSync.onConnectionSynced();

    expect(connection.sentMessages.map((message) => message.type)).toEqual([
      "file.create",
      "file.rename",
      "file.delete",
    ]);
    expect(connection.sentMessages[1]).toMatchObject({
      clientOpId: rename.clientOpId,
      fileId: create.fileId,
      oldPath: "draft.md",
      newPath: "renamed.md",
    });
    expect(connection.sentMessages[2]).toMatchObject({
      clientOpId: del.clientOpId,
      fileId: create.fileId,
      path: "renamed.md",
    });

    await connection.emitStateless({
      type: "metadata.reject",
      requestType: "file.rename",
      clientId: syncState.clientId,
      clientOpId: rename.clientOpId,
      fileId: create.fileId,
      reason: "fileId was deleted remotely",
      currentPath: "draft.md",
    });

    expect(syncState.pendingMetadataOps.map((op) => op.clientOpId)).toEqual([
      create.clientOpId,
      del.clientOpId,
    ]);
    expect(notices).toEqual([
      "Sync rejected local change: fileId was deleted remotely",
    ]);

    metadataSync.destroy();
  });

  test("drops ignored create ops instead of sending them", () => {
    const connection = createFakeConnection();

    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async () => null,
      notify: (message) => {
        notices.push(message);
      },
    });

    metadataSync.requestCreate(".obsidian/workspace.json", "text");

    expect(connection.sentMessages).toEqual([]);
    expect(syncState.pendingMetadataOps).toEqual([]);
    expect(
      metadataSync.resolveFileId(".obsidian/workspace.json"),
    ).toBeUndefined();

    metadataSync.destroy();
  });

  test("drops ignored rename targets on reconnect and restores the old path mapping", () => {
    syncState = {
      ...loadSyncState(undefined),
      pathIndex: { "note.md": "file-1" },
    };

    const connection = createFakeConnection();
    connection.status = WebSocketStatus.Disconnected;

    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async () => null,
      notify: (message) => {
        notices.push(message);
      },
    });

    metadataSync.requestRename(
      "file-1",
      "note.md",
      ".obsidian/workspace.json",
      "text",
    );

    connection.status = WebSocketStatus.Connected;
    metadataSync.onConnectionSynced();

    expect(connection.sentMessages).toEqual([]);
    expect(syncState.pendingMetadataOps).toEqual([]);
    expect(metadataSync.resolveFileId("note.md")).toBe("file-1");
    expect(
      metadataSync.resolveFileId(".obsidian/workspace.json"),
    ).toBeUndefined();

    metadataSync.destroy();
  });

  test("resolveFileId returns persisted fileId for known files when metaFiles is empty (cold start offline)", () => {
    syncState = {
      ...loadSyncState(undefined),
      pathIndex: {
        "note.md": "file-1",
        "folder/page.md": "file-2",
      },
    };

    const connection = createFakeConnection();
    connection.status = WebSocketStatus.Disconnected;

    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async () => null,
      notify: (message) => {
        notices.push(message);
      },
    });

    expect(metadataSync.resolveFileId("note.md")).toBe("file-1");
    expect(metadataSync.resolveFileId("folder/page.md")).toBe("file-2");
    expect(metadataSync.resolveFileId("unknown.md")).toBeUndefined();

    metadataSync.destroy();
  });

  test("resolveFileId ignores persisted paths for deleted canonical files", () => {
    syncState = loadSyncState({
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

    const connection = createFakeConnection();
    connection.status = WebSocketStatus.Disconnected;

    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async () => null,
      notify: (message) => {
        notices.push(message);
      },
    });

    expect(metadataSync.resolveFileId("note.md")).toBeUndefined();

    metadataSync.destroy();
  });

  test("offline delete is queued for a known file seeded from pathIndex", () => {
    syncState = {
      ...loadSyncState(undefined),
      pathIndex: { "note.md": "file-1" },
    };

    const connection = createFakeConnection();
    connection.status = WebSocketStatus.Disconnected;

    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async () => null,
      notify: (message) => {
        notices.push(message);
      },
    });

    const resolvedFileId = metadataSync.resolveFileId("note.md");
    expect(resolvedFileId).toBe("file-1");
    if (!resolvedFileId) {
      throw new Error("Expected resolved fileId for note.md");
    }

    const { clientOpId } = metadataSync.requestDelete(
      resolvedFileId,
      "note.md",
    );

    expect(syncState.pendingMetadataOps).toHaveLength(1);
    expect(syncState.pendingMetadataOps[0]).toMatchObject({
      type: "file.delete",
      clientOpId,
      fileId: "file-1",
      path: "note.md",
    });
    expect(connection.sentMessages).toHaveLength(0);

    metadataSync.destroy();
  });

  test("offline rename is queued for a known file seeded from pathIndex", () => {
    syncState = {
      ...loadSyncState(undefined),
      pathIndex: { "note.md": "file-1" },
    };

    const connection = createFakeConnection();
    connection.status = WebSocketStatus.Disconnected;

    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async () => null,
      notify: (message) => {
        notices.push(message);
      },
    });

    const resolvedFileId = metadataSync.resolveFileId("note.md");
    expect(resolvedFileId).toBe("file-1");
    if (!resolvedFileId) {
      throw new Error("Expected resolved fileId for note.md");
    }

    const { clientOpId } = metadataSync.requestRename(
      resolvedFileId,
      "note.md",
      "renamed.md",
    );

    expect(syncState.pendingMetadataOps).toHaveLength(1);
    expect(syncState.pendingMetadataOps[0]).toMatchObject({
      type: "file.rename",
      clientOpId,
      fileId: "file-1",
      oldPath: "note.md",
      newPath: "renamed.md",
    });
    expect(connection.sentMessages).toHaveLength(0);

    metadataSync.destroy();
  });

  test("pending content replay applies a cold-start offline edit to the synced Yjs content", async () => {
    syncState = {
      ...loadSyncState(undefined),
      pathIndex: { "note.md": "file-1" },
      pendingContentReplays: [{ fileId: "file-1", path: "note.md" }],
    };

    const connection = createFakeConnection();
    const remoteText = new Y.Text();
    remoteText.insert(0, "remote base");
    connection.filesMap.set("file-1", remoteText);

    const metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: async (path) => {
        return path === "note.md" ? "remote base + local edit" : null;
      },
      notify: (message) => {
        notices.push(message);
      },
    });

    await metadataSync.replayPendingContentChanges();

    expect(connection.filesMap.get("file-1")?.toString()).toBe(
      "remote base + local edit",
    );
    expect(syncState.pendingContentReplays).toEqual([]);

    metadataSync.destroy();
  });
});
