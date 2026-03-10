import { beforeEach, describe, expect, test } from "bun:test";
import { dirname } from "pathe";
import * as Y from "yjs";
import { EchoPrevention } from "../src/echo-prevention";
import { MetadataMirror, type SyncedVaultFacade } from "../src/meta-apply";
import {
  loadSyncState,
  type PendingMetadataOp,
  type SyncState,
} from "../src/state";

class MemoryVault implements SyncedVaultFacade {
  private readonly files = new Map<string, string | Uint8Array>();
  private readonly directories = new Set<string>();

  async kind(path: string): Promise<"text" | "binary" | "directory" | null> {
    const content = this.files.get(path);
    if (typeof content === "string") return "text";
    if (content instanceof Uint8Array) return "binary";
    return this.directories.has(path) ? "directory" : null;
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  async read(
    path: string,
    kind?: "text" | "binary",
  ): Promise<string | Uint8Array | null> {
    const content = this.files.get(path);
    if (content === undefined) {
      return null;
    }
    if (!kind) {
      return typeof content === "string" ? content : new Uint8Array(content);
    }
    if (kind === "text") {
      if (typeof content !== "string") {
        throw new Error(`File "${path}" is not stored as text`);
      }
      return content;
    }
    if (!(content instanceof Uint8Array)) {
      throw new Error(`File "${path}" is not stored as binary`);
    }
    return new Uint8Array(content);
  }

  async create(
    path: string,
    kind: "text" | "binary" | "directory",
    content?: string | Uint8Array,
  ): Promise<void> {
    if (await this.kind(path)) {
      throw new Error(`Entry "${path}" already exists`);
    }

    await this.ensureParentDir(path);
    if (kind === "directory") {
      this.directories.add(path);
      return;
    }
    this.files.set(
      path,
      kind === "binary"
        ? content instanceof Uint8Array
          ? new Uint8Array(content)
          : new Uint8Array()
        : typeof content === "string"
          ? content
          : "",
    );
  }

  async modify(
    path: string,
    kind: "text" | "binary",
    content: string | Uint8Array,
  ): Promise<void> {
    if (!this.files.has(path)) {
      throw new Error(`Missing file "${path}"`);
    }

    if (kind === "text") {
      if (typeof content !== "string") {
        throw new Error(`Expected text content for "${path}"`);
      }
      this.files.set(path, content);
      return;
    }

    if (!(content instanceof Uint8Array)) {
      throw new Error(`Expected binary content for "${path}"`);
    }
    this.files.set(path, new Uint8Array(content));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content !== undefined) {
      if (await this.kind(newPath)) {
        throw new Error(`Entry "${newPath}" already exists`);
      }
      await this.ensureParentDir(newPath);
      this.files.delete(oldPath);
      this.files.set(
        newPath,
        content instanceof Uint8Array ? new Uint8Array(content) : content,
      );
      return;
    }

    if (!this.directories.has(oldPath)) {
      throw new Error(`Missing entry "${oldPath}"`);
    }

    const movedFiles = [...this.files.entries()].filter(([path]) => {
      return path === oldPath || path.startsWith(`${oldPath}/`);
    });
    const movedDirectories = [...this.directories].filter((path) => {
      return path === oldPath || path.startsWith(`${oldPath}/`);
    });

    for (const [path] of movedFiles) {
      this.files.delete(path);
    }
    for (const path of movedDirectories) {
      this.directories.delete(path);
    }

    await this.ensureParentDir(newPath);
    for (const path of movedDirectories) {
      this.directories.add(path.replace(oldPath, newPath));
    }
    for (const [path, value] of movedFiles) {
      this.files.set(path.replace(oldPath, newPath), value);
    }
  }

  async delete(path: string): Promise<void> {
    if (this.files.delete(path)) {
      return;
    }
    if (!this.directories.has(path)) {
      throw new Error(`Missing entry "${path}"`);
    }
    this.directories.delete(path);
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(`${path}/`)) {
        this.files.delete(filePath);
      }
    }
    for (const directoryPath of [...this.directories]) {
      if (directoryPath.startsWith(`${path}/`)) {
        this.directories.delete(directoryPath);
      }
    }
  }

  async ensureParentDir(path: string): Promise<void> {
    const parts = dirname(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.directories.add(current);
    }
  }

  seed(path: string, content: string | Uint8Array): void {
    void this.ensureParentDir(path);
    this.files.set(
      path,
      content instanceof Uint8Array ? new Uint8Array(content) : content,
    );
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

interface FakeConnection {
  filesMap: Y.Map<Y.Text | Uint8Array | Y.Array<Uint8Array>>;
  metaFiles: Y.Map<Y.Map<unknown>>;
  metaEvents: Y.Array<Y.Map<unknown>>;
}

function createConnection(): FakeConnection {
  const contentDoc = new Y.Doc();
  const metaDoc = new Y.Doc();

  return {
    filesMap: contentDoc.getMap<Y.Text | Uint8Array | Y.Array<Uint8Array>>(
      "files",
    ),
    metaFiles: metaDoc.getMap<Y.Map<unknown>>("files"),
    metaEvents: metaDoc.getArray<Y.Map<unknown>>("events"),
  };
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

const textEncoder = new TextEncoder();

async function fingerprintText(content: string): Promise<string> {
  const bytes = textEncoder.encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

describe("MetadataMirror", () => {
  let connection: FakeConnection;
  let vault: MemoryVault;
  let syncState: SyncState;
  let notices: string[];
  let queuedConflictCopies: string[];

  beforeEach(() => {
    connection = createConnection();
    vault = new MemoryVault();
    syncState = loadSyncState(undefined);
    notices = [];
    queuedConflictCopies = [];
  });

  function createMirror(): MetadataMirror {
    const mirror = new MetadataMirror({
      vaultFacade: vault,
      connection: connection as never,
      echoPrevention: new EchoPrevention(),
      localClientId: syncState.clientId,
      getSyncState: () => syncState,
      updateSyncState: (updater) => {
        syncState = updater(syncState);
      },
      notify: (message) => {
        notices.push(message);
      },
      registerConflictCopy: async (path) => {
        queuedConflictCopies.push(path);
      },
    });
    return mirror;
  }

  test("second client bootstraps local files from canonical metadata events", async () => {
    setContent(connection, "file-1", "# synced");
    setMetaFile(connection, "file-1", "folder/note.md");
    pushEvent(connection, {
      eventId: 1,
      type: "file.create",
      fileId: "file-1",
      path: "folder/note.md",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    expect(await vault.read("folder/note.md")).toBe("# synced");
    expect(syncState.lastAppliedMetaEventId).toBe(1);
    expect(notices).toEqual([]);

    mirror.destroy();
  });

  test("replays unseen metadata events in eventId order after reconnect", async () => {
    syncState = {
      ...syncState,
      lastAppliedMetaEventId: 1,
    };
    vault.seed("note.md", "base");
    setContent(connection, "file-1", "base");
    setMetaFile(connection, "file-1", "renamed.md", true);
    pushEvent(connection, {
      eventId: 3,
      type: "file.delete",
      fileId: "file-1",
      path: "renamed.md",
    });
    pushEvent(connection, {
      eventId: 2,
      type: "file.rename",
      fileId: "file-1",
      oldPath: "note.md",
      newPath: "renamed.md",
      path: "renamed.md",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    expect(vault.paths()).toEqual([]);
    expect(syncState.lastAppliedMetaEventId).toBe(3);

    mirror.destroy();
  });

  test("reconciles rejected optimistic rename back to the canonical path", async () => {
    vault.seed("renamed.md", "shared");
    setContent(connection, "file-1", "shared");
    setMetaFile(connection, "file-1", "note.md");

    const mirror = createMirror();
    const pendingOperation: PendingMetadataOp = {
      clientOpId: "op-1",
      type: "file.rename",
      fileId: "file-1",
      oldPath: "note.md",
      newPath: "renamed.md",
      path: "renamed.md",
      timestamp: Date.now(),
    };

    await mirror.reconcileRejectedOperation(
      {
        type: "metadata.reject",
        requestType: "file.rename",
        clientId: syncState.clientId,
        clientOpId: "op-1",
        fileId: "file-1",
        reason: "path already exists",
        currentPath: "note.md",
        newPath: "renamed.md",
      },
      pendingOperation,
    );

    expect(await vault.read("note.md")).toBe("shared");
    expect(await vault.read("renamed.md")).toBeNull();

    mirror.destroy();
  });

  test("applyRename preserves stale local file as conflict copy when oldPath is absent and newPath has divergent content", async () => {
    vault.seed("note.md", "local-stale");
    setContent(connection, "file-1", "remote-canonical");
    setMetaFile(connection, "file-1", "note.md");
    pushEvent(connection, {
      eventId: 1,
      type: "file.rename",
      fileId: "file-1",
      newPath: "note.md",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    const conflictPath = vault
      .paths()
      .find((p) => p.startsWith("note.sync-conflict-"));
    expect(conflictPath).toBeDefined();
    if (!conflictPath) throw new Error("Expected a conflict copy");
    expect(await vault.read(conflictPath)).toBe("local-stale");
    expect(await vault.read("note.md")).toBe("remote-canonical");
    expect(syncState.lastAppliedMetaEventId).toBe(1);
    expect(queuedConflictCopies).toEqual([conflictPath]);

    mirror.destroy();
  });

  test("applyRename skips when oldPath is absent and newPath already has matching canonical content", async () => {
    vault.seed("note.md", "already-correct");
    setContent(connection, "file-1", "already-correct");
    setMetaFile(connection, "file-1", "note.md");
    pushEvent(connection, {
      eventId: 1,
      type: "file.rename",
      fileId: "file-1",
      newPath: "note.md",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    expect(vault.paths()).toEqual(["note.md"]);
    expect(await vault.read("note.md")).toBe("already-correct");
    expect(syncState.lastAppliedMetaEventId).toBe(1);
    expect(notices).toEqual([]);

    mirror.destroy();
  });

  test("applyRename treats an already materialized directory destination as the completed rename", async () => {
    vault.seed("old-folder/note.md", "shared");
    vault.seed("new-folder/note.md", "shared");
    pushEvent(connection, {
      eventId: 1,
      type: "file.rename",
      fileId: "dir-1",
      oldPath: "old-folder",
      newPath: "new-folder",
      path: "new-folder",
      kind: "directory",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    expect(await vault.kind("old-folder")).toBeNull();
    expect(await vault.read("new-folder/note.md")).toBe("shared");
    expect(
      vault.paths().filter((path) => path.includes("sync-conflict")),
    ).toEqual([]);
    expect(queuedConflictCopies).toEqual([]);
    expect(syncState.lastAppliedMetaEventId).toBe(1);

    mirror.destroy();
  });

  test("preserves local edits as a conflict copy before applying remote delete", async () => {
    vault.seed("note.md", "local edit");
    setContent(connection, "file-1", "remote base");
    setMetaFile(connection, "file-1", "note.md", true);
    pushEvent(connection, {
      eventId: 1,
      type: "file.delete",
      fileId: "file-1",
      path: "note.md",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    const conflictPath = vault
      .paths()
      .find((path) => path.startsWith("note.sync-conflict-"));

    expect(await vault.read("note.md")).toBeNull();
    expect(conflictPath).toBeDefined();
    if (!conflictPath) {
      throw new Error("Expected a conflict copy");
    }
    expect(await vault.read(conflictPath)).toBe("local edit");
    expect(syncState.lastAppliedMetaEventId).toBe(1);
    expect(notices).toHaveLength(1);
    expect(queuedConflictCopies).toEqual([conflictPath]);

    mirror.destroy();
  });

  test("applies remote delete without a conflict copy after content was pruned", async () => {
    vault.seed("note.md", "remote base");
    setMetaFile(connection, "file-1", "note.md", true);
    pushEvent(connection, {
      eventId: 1,
      type: "file.delete",
      fileId: "file-1",
      path: "note.md",
      contentFingerprint: await fingerprintText("remote base"),
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    expect(await vault.read("note.md")).toBeNull();
    expect(
      vault.paths().filter((path) => path.startsWith("note.sync-conflict-")),
    ).toEqual([]);
    expect(queuedConflictCopies).toEqual([]);

    mirror.destroy();
  });

  test("preserves local edits after content was pruned when delete fingerprint does not match", async () => {
    vault.seed("note.md", "local edit");
    setMetaFile(connection, "file-1", "note.md", true);
    pushEvent(connection, {
      eventId: 1,
      type: "file.delete",
      fileId: "file-1",
      path: "note.md",
      contentFingerprint: await fingerprintText("remote base"),
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    const conflictPath = vault
      .paths()
      .find((path) => path.startsWith("note.sync-conflict-"));
    expect(await vault.read("note.md")).toBeNull();
    expect(conflictPath).toBeDefined();
    if (!conflictPath) {
      throw new Error("Expected a conflict copy");
    }
    expect(await vault.read(conflictPath)).toBe("local edit");
    expect(queuedConflictCopies).toEqual([conflictPath]);

    mirror.destroy();
  });

  test("preserves mismatched local binary content before applying a remote text delete", async () => {
    vault.seed("note.md", new Uint8Array([1, 2, 3]));
    pushEvent(connection, {
      eventId: 1,
      type: "file.delete",
      fileId: "file-1",
      path: "note.md",
      kind: "text",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    const conflictPath = vault
      .paths()
      .find((path) => path.startsWith("note.sync-conflict-"));
    expect(await vault.read("note.md")).toBeNull();
    expect(conflictPath).toBeDefined();
    if (!conflictPath) {
      throw new Error("Expected a conflict copy");
    }
    expect(await vault.read(conflictPath)).toEqual(new Uint8Array([1, 2, 3]));
    expect(queuedConflictCopies).toEqual([conflictPath]);

    mirror.destroy();
  });

  test("remote directory delete removes the directory and its descendants", async () => {
    vault.seed("folder/note.md", "shared");
    pushEvent(connection, {
      eventId: 1,
      type: "file.delete",
      fileId: "dir-1",
      path: "folder",
      kind: "directory",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    expect(await vault.kind("folder")).toBeNull();
    expect(await vault.read("folder/note.md")).toBeNull();
    expect(syncState.lastAppliedMetaEventId).toBe(1);

    mirror.destroy();
  });

  test("rejected rename restores canonical text after preserving a mismatched local binary file", async () => {
    vault.seed("note.md", new Uint8Array([4, 5, 6]));
    setContent(connection, "file-1", "remote canonical");
    setMetaFile(connection, "file-1", "note.md");

    const mirror = createMirror();
    await mirror.reconcileRejectedOperation(
      {
        type: "metadata.reject",
        requestType: "file.rename",
        clientId: syncState.clientId,
        clientOpId: "op-1",
        fileId: "file-1",
        reason: "rename rejected",
        currentPath: "note.md",
        newPath: "renamed.md",
        kind: "text",
      },
      {
        clientOpId: "op-1",
        type: "file.rename",
        fileId: "file-1",
        kind: "text",
        oldPath: "note.md",
        newPath: "renamed.md",
        path: "renamed.md",
        timestamp: Date.now(),
      },
    );

    const conflictPath = vault
      .paths()
      .find((path) => path.startsWith("note.sync-conflict-"));
    expect(await vault.read("note.md")).toBe("remote canonical");
    expect(conflictPath).toBeDefined();
    if (!conflictPath) {
      throw new Error("Expected a conflict copy");
    }
    expect(await vault.read(conflictPath)).toEqual(new Uint8Array([4, 5, 6]));
    expect(queuedConflictCopies).toEqual([conflictPath]);

    mirror.destroy();
  });

  test("skips the creator's own echoed create event when the local file already exists", async () => {
    vault.seed("note.md", "# local draft");
    pushEvent(connection, {
      eventId: 1,
      type: "file.create",
      fileId: "file-1",
      path: "note.md",
      clientId: syncState.clientId,
      clientOpId: "op-create",
    });

    const mirror = createMirror();
    await mirror.replayAvailableEvents();

    expect(vault.paths()).toEqual(["note.md"]);
    expect(await vault.read("note.md")).toBe("# local draft");
    expect(queuedConflictCopies).toEqual([]);
    expect(syncState.lastAppliedMetaEventId).toBe(1);

    mirror.destroy();
  });
});
