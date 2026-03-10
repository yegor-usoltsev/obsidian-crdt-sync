import { describe, expect, test } from "bun:test";
import { EchoPrevention } from "../src/echo-prevention";
import { VaultWatcher } from "../src/vault-watcher";

describe("VaultWatcher", () => {
  function createMetadataSync(
    resolveFileId: (path: string) => string | undefined,
    calls: Array<{ type: string; path?: string; oldPath?: string }>,
    options?: {
      canonicalPath?: string;
      coveredByPendingDirectoryRename?: boolean;
    },
  ) {
    return {
      getCanonicalPath() {
        return options?.canonicalPath;
      },
      isCoveredByPendingDirectoryRename() {
        return options?.coveredByPendingDirectoryRename ?? false;
      },
      rememberPath(_fileId: string, path: string) {
        calls.push({ type: "remember", path });
      },
      requestCreate(path: string) {
        calls.push({ type: "create", path });
      },
      requestRename(_fileId: string, oldPath: string, newPath: string) {
        calls.push({ type: "rename", oldPath, path: newPath });
      },
      requestDelete(_fileId: string, path: string) {
        calls.push({ type: "delete", path });
      },
      resolveFileId,
    };
  }

  function createWatcher(metadataSync: object): VaultWatcher {
    const watcher = new VaultWatcher(
      { readBinary: async () => new Uint8Array() } as never,
      {} as never,
      new EchoPrevention(),
      metadataSync as never,
    );
    watcher.enable();
    return watcher;
  }

  function emitDelete(watcher: VaultWatcher, file: unknown): void {
    (watcher as unknown as { onDelete: (file: unknown) => void }).onDelete(
      file,
    );
  }

  function emitRename(
    watcher: VaultWatcher,
    file: unknown,
    oldPath: string,
  ): Promise<void> {
    return (
      watcher as unknown as {
        onRename: (file: unknown, oldPath: string) => Promise<void>;
      }
    ).onRename(file, oldPath);
  }

  test("ignores rename events already reflected in synced paths", async () => {
    const calls: Array<{ type: string; path?: string; oldPath?: string }> = [];
    const metadataSync = createMetadataSync(
      (path) => (path === "Bar/file.pdf" ? "file-1" : undefined),
      calls,
    );

    const watcher = createWatcher(metadataSync);

    await emitRename(
      watcher,
      {
        extension: "pdf",
        name: "file.pdf",
        path: "Bar/file.pdf",
        stat: { size: 1 },
      },
      "Untitled/file.pdf",
    );

    expect(calls).toEqual([{ type: "remember", path: "Bar/file.pdf" }]);

    watcher.destroy();
  });

  test("ignores rename events already reflected in canonical metadata", async () => {
    const calls: Array<{ type: string; path?: string; oldPath?: string }> = [];
    const metadataSync = createMetadataSync(
      (path) =>
        path === "Untitled/file.pdf" || path === "Bar/file.pdf"
          ? "file-1"
          : undefined,
      calls,
      { canonicalPath: "Bar/file.pdf" },
    );

    const watcher = createWatcher(metadataSync);

    await emitRename(
      watcher,
      {
        extension: "pdf",
        name: "file.pdf",
        path: "Bar/file.pdf",
        stat: { size: 1 },
      },
      "Untitled/file.pdf",
    );

    expect(calls).toEqual([{ type: "remember", path: "Bar/file.pdf" }]);

    watcher.destroy();
  });

  test("ignores child renames covered by a pending directory rename", async () => {
    const calls: Array<{ type: string; path?: string; oldPath?: string }> = [];
    const metadataSync = createMetadataSync(
      (path) =>
        path === "Untitled/file.pdf" || path === "Bar/file.pdf"
          ? "file-1"
          : undefined,
      calls,
      { coveredByPendingDirectoryRename: true },
    );

    const watcher = createWatcher(metadataSync);

    await emitRename(
      watcher,
      {
        extension: "pdf",
        name: "file.pdf",
        path: "Bar/file.pdf",
        stat: { size: 1 },
      },
      "Untitled/file.pdf",
    );

    expect(calls).toEqual([{ type: "remember", path: "Bar/file.pdf" }]);

    watcher.destroy();
  });

  test("sends a rename when the synced path still points at the old location", async () => {
    const calls: Array<{ type: string; path?: string; oldPath?: string }> = [];
    const metadataSync = createMetadataSync(
      (path) => (path === "Untitled/file.pdf" ? "file-1" : undefined),
      calls,
    );

    const watcher = createWatcher(metadataSync);

    await emitRename(
      watcher,
      {
        extension: "pdf",
        name: "file.pdf",
        path: "Bar/file.pdf",
        stat: { size: 1 },
      },
      "Untitled/file.pdf",
    );

    expect(calls).toEqual([
      { type: "rename", oldPath: "Untitled/file.pdf", path: "Bar/file.pdf" },
    ]);

    watcher.destroy();
  });

  test("renaming a synced file into an ignored path sends a delete", async () => {
    const calls: Array<{ type: string; path?: string; oldPath?: string }> = [];
    const metadataSync = createMetadataSync(
      (path) => (path === "note.md" ? "file-1" : undefined),
      calls,
    );

    const watcher = createWatcher(metadataSync);

    await emitRename(
      watcher,
      {
        extension: "json",
        name: "workspace.json",
        path: ".obsidian/workspace.json",
        stat: { size: 1 },
      },
      "note.md",
    );

    expect(calls).toEqual([{ type: "delete", path: "note.md" }]);

    watcher.destroy();
  });

  test("renaming an ignored file into a synced path sends a create", async () => {
    const calls: Array<{ type: string; path?: string; oldPath?: string }> = [];
    const metadataSync = createMetadataSync(() => undefined, calls);

    const watcher = createWatcher(metadataSync);

    await emitRename(
      watcher,
      {
        extension: "json",
        name: "workspace.json",
        path: "workspace.json",
        stat: { size: 1 },
      },
      ".obsidian/workspace.json",
    );

    expect(calls).toEqual([{ type: "create", path: "workspace.json" }]);

    watcher.destroy();
  });

  test("ignores descendant renames after a directory rename event", async () => {
    const calls: Array<{ type: string; path?: string; oldPath?: string }> = [];
    const metadataSync = createMetadataSync((path) => {
      switch (path) {
        case "Dir 2":
          return "dir-1";
        case "Dir 2/Doc.md":
          return "file-1";
        default:
          return undefined;
      }
    }, calls);

    const watcher = createWatcher(metadataSync);

    await emitRename(
      watcher,
      {
        children: [],
        name: "Dir 3",
        path: "Dir 3",
      },
      "Dir 2",
    );
    await emitRename(
      watcher,
      {
        extension: "md",
        name: "Doc.md",
        path: "Dir 3/Doc.md",
        stat: { size: 1 },
      },
      "Dir 2/Doc.md",
    );

    expect(calls).toEqual([
      { type: "rename", oldPath: "Dir 2", path: "Dir 3" },
      { type: "remember", path: "Dir 3/Doc.md" },
    ]);

    watcher.destroy();
  });

  test("ignores descendant deletes after a directory delete event", () => {
    const calls: Array<{ type: string; path?: string; oldPath?: string }> = [];
    const metadataSync = createMetadataSync((path) => {
      switch (path) {
        case "Dir 3":
          return "dir-1";
        case "Dir 3/Doc.md":
          return "file-1";
        default:
          return undefined;
      }
    }, calls);

    const watcher = createWatcher(metadataSync);

    emitDelete(watcher, {
      children: [],
      name: "Dir 3",
      path: "Dir 3",
    });
    emitDelete(watcher, {
      extension: "md",
      name: "Doc.md",
      path: "Dir 3/Doc.md",
      stat: { size: 1 },
    });

    expect(calls).toEqual([{ type: "delete", path: "Dir 3" }]);

    watcher.destroy();
  });
});
