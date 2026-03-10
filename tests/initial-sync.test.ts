import { beforeEach, describe, expect, test } from "bun:test";
import { WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { InitialSync } from "../src/initial-sync";
import { PluginLogger } from "../src/logger";
import { MetadataMirror, type SyncedVaultFacade } from "../src/meta-apply";
import {
  type MetadataStatelessMessage,
  MetadataSync,
} from "../src/metadata-sync";
import {
  buildIndexesFromMetaFiles,
  loadSyncState,
  type SyncState,
} from "../src/state";

type DocumentName = "vault-content" | "vault-meta";

class MemoryVault implements SyncedVaultFacade {
  private readonly files = new Map<string, string>();

  async kind(path: string): Promise<"text" | "directory" | null> {
    return this.files.has(path) ? "text" : null;
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async create(
    path: string,
    _kind: "text" | "binary" | "directory",
    content?: string,
  ): Promise<void> {
    this.files.set(path, content ?? "");
  }

  async modify(
    path: string,
    _kind: "text" | "binary",
    content: string,
  ): Promise<void> {
    this.files.set(path, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content === undefined) {
      throw new Error(`Missing file "${oldPath}"`);
    }

    this.files.delete(oldPath);
    this.files.set(newPath, content);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async ensureParentDir(_path: string): Promise<void> {}

  seed(path: string, content: string): void {
    this.files.set(path, content);
  }
}

class FakeConnection {
  status = WebSocketStatus.Connected;
  readonly contentDoc = new Y.Doc();
  readonly metaDoc = new Y.Doc();
  readonly filesMap = this.contentDoc.getMap<Y.Text>("files");
  readonly metaFiles = this.metaDoc.getMap<Y.Map<unknown>>("files");
  readonly metaEvents = this.metaDoc.getArray<Y.Map<unknown>>("events");
  readonly sentMessages: MetadataStatelessMessage[] = [];

  private syncedCallback: (() => void) | null = null;
  private readonly docSynced: Record<DocumentName, boolean> = {
    "vault-content": false,
    "vault-meta": false,
  };
  private readonly waiters: Record<
    DocumentName,
    Array<{ resolve: () => void; reject: (err: Error) => void }>
  > = {
    "vault-content": [],
    "vault-meta": [],
  };
  private readonly statelessHandlers = new Set<
    (message: MetadataStatelessMessage) => void
  >();

  setSyncedCallback(callback: () => void): void {
    this.syncedCallback = callback;
  }

  waitForDocumentSync(documentName: DocumentName): Promise<void> {
    if (this.docSynced[documentName]) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.waiters[documentName].push({ resolve, reject });
    });
  }

  addStatelessHandler(
    handler: (message: MetadataStatelessMessage) => void,
  ): () => void {
    this.statelessHandlers.add(handler);
    return () => {
      this.statelessHandlers.delete(handler);
    };
  }

  sendStateless(message: MetadataStatelessMessage): void {
    this.sentMessages.push(message);
  }

  markDocumentSynced(documentName: DocumentName): void {
    this.docSynced[documentName] = true;
    const waiters = this.waiters[documentName];
    this.waiters[documentName] = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }

    if (this.docSynced["vault-content"] && this.docSynced["vault-meta"]) {
      this.syncedCallback?.();
    }
  }

  failDocumentSync(documentName: DocumentName, error: Error): void {
    const waiters = this.waiters[documentName];
    this.waiters[documentName] = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  triggerSyncedCallback(): void {
    this.syncedCallback?.();
  }
}

class FakeStatusBar {
  current: "offline" | "syncing" | "synced" | "error" = "offline";
  lastError: string | null = null;

  setSyncing(): void {
    this.current = "syncing";
  }

  setSynced(): void {
    this.current = "synced";
  }

  setError(message: string): void {
    this.current = "error";
    this.lastError = message;
  }
}

class FakeVaultWatcher {
  enabled = false;

  constructor(private readonly calls: string[]) {}

  enable(): void {
    this.calls.push("watcher.enable");
    this.enabled = true;
  }

  disable(): void {
    this.calls.push("watcher.disable");
    this.enabled = false;
  }
}

class FakeIncomingSync {
  enabled = false;

  constructor(
    private readonly connection: FakeConnection,
    private readonly vault: MemoryVault,
    private readonly calls: string[],
  ) {}

  enable(): void {
    this.calls.push("content.enable");
    this.enabled = true;
  }

  disable(): void {
    this.calls.push("content.disable");
    this.enabled = false;
  }

  async flushActiveFilesToVault(): Promise<void> {
    this.calls.push("content.flush");

    for (const [fileId, metadata] of this.connection.metaFiles.entries()) {
      if (metadata.get("deleted") === true) {
        continue;
      }

      const path = metadata.get("path");
      if (typeof path !== "string" || path.length === 0) {
        continue;
      }

      const content = this.connection.filesMap.get(fileId)?.toString() ?? "";
      if (this.vault.exists(path)) {
        await this.vault.modify(path, "text", content);
      } else {
        await this.vault.create(path, "text", content);
      }
    }
  }
}

function setContent(
  connection: FakeConnection,
  fileId: string,
  content: string,
): void {
  const text = new Y.Text();
  text.insert(0, content);
  connection.filesMap.set(fileId, text);
}

function setMetaFile(
  connection: FakeConnection,
  fileId: string,
  path: string,
  deleted = false,
): void {
  const metadata = new Y.Map<unknown>();
  metadata.set("path", path);
  metadata.set("deleted", deleted);
  connection.metaFiles.set(fileId, metadata);
}

function pushEvent(
  connection: FakeConnection,
  event: Record<string, string | number | undefined>,
): void {
  const entry = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(event)) {
    if (value !== undefined) {
      entry.set(key, value);
    }
  }
  connection.metaEvents.push([entry]);
}

async function waitFor(
  condition: () => boolean,
  timeout = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeout) {
      throw new Error(`Timed out after ${timeout}ms`);
    }
    await Bun.sleep(10);
  }
}

describe("InitialSync", () => {
  let connection: FakeConnection;
  let vault: MemoryVault;
  let syncState: SyncState;
  let notices: string[];
  let calls: string[];
  let metadataMirror: MetadataMirror;
  let metadataSync: MetadataSync;

  beforeEach(() => {
    connection = new FakeConnection();
    vault = new MemoryVault();
    syncState = loadSyncState(undefined);
    notices = [];
    calls = [];

    metadataMirror = new MetadataMirror({
      vaultFacade: vault,
      connection: connection as never,
      echoPrevention: {
        isLocallyDeleted: () => false,
        isWriting: () => false,
        markWriting: () => {},
        unmarkWriting: () => {},
      } as never,
      localClientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      notify: (message) => {
        notices.push(message);
      },
    });

    metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: (path) => {
        return vault.read(path);
      },
      notify: (message) => {
        notices.push(message);
      },
    });
  });

  function buildInitialSyncHarness() {
    const watcher = new FakeVaultWatcher(calls);
    const incomingSync = new FakeIncomingSync(connection, vault, calls);
    const statusBar = new FakeStatusBar();
    const wrappedMirror = {
      enable: () => {
        calls.push("metadata.enable");
        metadataMirror.enable();
      },
      disable: () => {
        calls.push("metadata.disable");
        metadataMirror.disable();
      },
      replayAvailableEvents: async () => {
        calls.push("metadata.replay");
        await metadataMirror.replayAvailableEvents();
      },
    };
    const metadataSyncLifecycle = {
      replayPendingContentChanges: async () => {
        calls.push("content.replayPending");
        await metadataSync.replayPendingContentChanges();
      },
      onConnectionSynced: () => {
        calls.push("metadata.replayPendingOps");
        metadataSync.onConnectionSynced();
      },
    };

    const initialSync = new InitialSync(
      connection as never,
      watcher as never,
      incomingSync as never,
      statusBar as never,
      wrappedMirror as never,
      metadataSyncLifecycle as never,
      new PluginLogger(false),
      {
        onSynced: () => {
          calls.push("offline-queue.clear");
        },
      } as never,
      () => {
        calls.push("indexes.rebuild");
        syncState = {
          ...syncState,
          ...buildIndexesFromMetaFiles(connection.metaFiles),
        };
      },
    );

    return { initialSync, watcher, incomingSync, statusBar };
  }

  test("second device bootstrap rebuilds metadata indexes and writes canonical content", async () => {
    setContent(connection, "file-1", "# synced");
    setMetaFile(connection, "file-1", "folder/note.md");
    pushEvent(connection, {
      eventId: 1,
      type: "file.create",
      fileId: "file-1",
      path: "folder/note.md",
    });

    const { watcher, incomingSync, statusBar } = buildInitialSyncHarness();

    connection.markDocumentSynced("vault-meta");
    connection.markDocumentSynced("vault-content");
    await waitFor(() => watcher.enabled && incomingSync.enabled);

    expect(await vault.read("folder/note.md")).toBe("# synced");
    expect(syncState.lastAppliedMetaEventId).toBe(1);
    expect(syncState.pathIndex).toEqual({ "folder/note.md": "file-1" });
    expect(statusBar.current).toBe("synced");
    expect(calls).toEqual([
      "watcher.enable",
      "metadata.disable",
      "content.disable",
      "watcher.disable",
      "indexes.rebuild",
      "metadata.replay",
      "content.replayPending",
      "content.flush",
      "metadata.replayPendingOps",
      "offline-queue.clear",
      "metadata.enable",
      "content.enable",
      "watcher.enable",
    ]);
    expect(notices).toEqual([]);
  });

  test("reconnect overwrites stale local vault content from synced Yjs instead of patching Yjs from disk", async () => {
    vault.seed("note.md", "local-stale");
    setContent(connection, "file-1", "server-newer");
    setMetaFile(connection, "file-1", "note.md");

    const { watcher } = buildInitialSyncHarness();

    connection.markDocumentSynced("vault-meta");
    connection.markDocumentSynced("vault-content");
    await waitFor(() => watcher.enabled);

    expect(await vault.read("note.md")).toBe("server-newer");
    expect(connection.filesMap.get("file-1")?.toString()).toBe("server-newer");
    expect(syncState.pathIndex).toEqual({ "note.md": "file-1" });
  });

  test("reconnect flushes merged Yjs content for offline local edits after metadata replay", async () => {
    vault.seed("note.md", "base");
    setContent(connection, "file-1", "base + server + local");
    setMetaFile(connection, "file-1", "note.md");
    pushEvent(connection, {
      eventId: 2,
      type: "file.rename",
      fileId: "file-1",
      oldPath: "old-note.md",
      newPath: "note.md",
      path: "note.md",
    });
    syncState = {
      ...syncState,
      lastAppliedMetaEventId: 1,
    };

    const { watcher } = buildInitialSyncHarness();

    connection.markDocumentSynced("vault-meta");
    connection.markDocumentSynced("vault-content");
    await waitFor(() => watcher.enabled);

    expect(await vault.read("note.md")).toBe("base + server + local");
    expect(syncState.lastAppliedMetaEventId).toBe(2);
    expect(calls.indexOf("metadata.replay")).toBeLessThan(
      calls.indexOf("content.replayPending"),
    );
    expect(calls.indexOf("content.replayPending")).toBeLessThan(
      calls.indexOf("content.flush"),
    );
  });

  test("reconnect replays queued create, rename, and delete metadata ops after canonical bootstrap", async () => {
    connection.status = WebSocketStatus.Disconnected;
    setContent(connection, "file-1", "remote");
    setMetaFile(connection, "file-1", "remote.md");

    const create = metadataSync.requestCreate("draft.md");
    metadataSync.requestRename(create.fileId, "draft.md", "renamed.md");
    metadataSync.requestDelete(create.fileId, "renamed.md");

    expect(connection.sentMessages).toHaveLength(0);

    const { watcher } = buildInitialSyncHarness();
    connection.status = WebSocketStatus.Connected;
    connection.markDocumentSynced("vault-meta");
    connection.markDocumentSynced("vault-content");
    await waitFor(() => watcher.enabled);

    expect(connection.sentMessages.map((message) => message.type)).toEqual([
      "file.create",
      "file.rename",
      "file.delete",
    ]);
    expect(calls.indexOf("content.flush")).toBeLessThan(
      calls.indexOf("metadata.replayPendingOps"),
    );
  });

  test("cold-start offline edits to an existing file replay into synced Yjs before the content flush", async () => {
    syncState = {
      ...loadSyncState(undefined),
      pathIndex: { "note.md": "file-1" },
      pendingContentReplays: [{ fileId: "file-1", path: "note.md" }],
    };

    metadataSync = new MetadataSync({
      connection: connection as never,
      clientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      readLocalFile: (path) => {
        return vault.read(path);
      },
      notify: (message) => {
        notices.push(message);
      },
    });

    vault.seed("note.md", "remote base + local edit");
    setContent(connection, "file-1", "remote base");
    setMetaFile(connection, "file-1", "note.md");

    const { watcher } = buildInitialSyncHarness();

    connection.markDocumentSynced("vault-meta");
    connection.markDocumentSynced("vault-content");
    await waitFor(() => watcher.enabled);

    expect(connection.filesMap.get("file-1")?.toString()).toBe(
      "remote base + local edit",
    );
    expect(await vault.read("note.md")).toBe("remote base + local edit");
    expect(syncState.pendingContentReplays).toEqual([]);
    expect(calls.indexOf("content.replayPending")).toBeLessThan(
      calls.indexOf("content.flush"),
    );
  });

  test("watcher is enabled immediately so offline local changes are captured before server is reachable", () => {
    const { watcher } = buildInitialSyncHarness();
    expect(watcher.enabled).toBe(true);
    expect(calls).toEqual(["watcher.enable"]);
  });

  test("manual full sync reruns the bootstrap pipeline after the initial sync", async () => {
    setContent(connection, "file-1", "# synced");
    setMetaFile(connection, "file-1", "note.md");

    const { initialSync, watcher } = buildInitialSyncHarness();

    connection.markDocumentSynced("vault-meta");
    connection.markDocumentSynced("vault-content");
    await waitFor(() => watcher.enabled);

    calls.length = 0;
    await initialSync.requestFullSync();

    expect(calls).toEqual([
      "metadata.disable",
      "content.disable",
      "watcher.disable",
      "indexes.rebuild",
      "metadata.replay",
      "content.replayPending",
      "content.flush",
      "metadata.replayPendingOps",
      "offline-queue.clear",
      "metadata.enable",
      "content.enable",
      "watcher.enable",
    ]);
    expect(await vault.read("note.md")).toBe("# synced");
  });

  test("watcher is re-enabled after bootstrap failure so local changes continue to be journaled", async () => {
    const { watcher, statusBar } = buildInitialSyncHarness();

    connection.markDocumentSynced("vault-content");
    connection.triggerSyncedCallback();
    await Bun.sleep(10);
    connection.failDocumentSync(
      "vault-meta",
      new Error("Authentication failed: Unauthorized"),
    );

    await waitFor(() => statusBar.current === "error");
    expect(watcher.enabled).toBe(true);
    expect(statusBar.current).toBe("error");
  });
});
