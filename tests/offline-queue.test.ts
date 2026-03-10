import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { PluginLogger } from "../src/logger";
import { OfflineQueue, type PendingUpdate } from "../src/offline-queue";

function toBase64(arr: Uint8Array): string {
  let binary = "";
  for (const byte of arr) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("OfflineQueue", () => {
  test("restores pending updates into the Y.Doc", () => {
    const logger = new PluginLogger(false);
    const sourceDoc = new Y.Doc();
    const sourceFiles = sourceDoc.getMap<Y.Text>("files");
    const text = new Y.Text();
    text.insert(0, "restored");
    sourceFiles.set("restored.md", text);

    const update = Y.encodeStateAsUpdate(sourceDoc);
    const pendingUpdates: PendingUpdate[] = [
      {
        update: toBase64(update),
        timestamp: Date.now(),
      },
    ];

    const targetDoc = new Y.Doc();
    const queue = new OfflineQueue(
      targetDoc,
      pendingUpdates,
      async () => {},
      () => false,
      logger,
    );

    expect(
      targetDoc.getMap<Y.Text>("files").get("restored.md")?.toString(),
    ).toBe("restored");

    queue.destroy();
  });

  test("persists each local update immediately without debounce when offline", async () => {
    const logger = new PluginLogger(false);
    const ydoc = new Y.Doc();
    const filesMap = ydoc.getMap<Y.Text>("files");
    const persistedCalls: PendingUpdate[][] = [];

    const queue = new OfflineQueue(
      ydoc,
      [],
      async (updates) => {
        persistedCalls.push([...updates]);
      },
      () => false,
      logger,
    );

    ydoc.transact(() => {
      const text = new Y.Text();
      text.insert(0, "offline-edit");
      filesMap.set("draft.md", text);
    }, "local");

    await Bun.sleep(0);

    expect(persistedCalls.length).toBeGreaterThan(0);
    expect(persistedCalls[persistedCalls.length - 1]?.length).toBe(1);

    queue.destroy();
  });

  test("flush() cancels pending debounce and persists immediately when called explicitly", async () => {
    const logger = new PluginLogger(false);
    const ydoc = new Y.Doc();
    const filesMap = ydoc.getMap<Y.Text>("files");
    const persistedCalls: PendingUpdate[][] = [];

    const queue = new OfflineQueue(
      ydoc,
      [],
      async (updates) => {
        persistedCalls.push([...updates]);
      },
      () => true,
      logger,
    );

    ydoc.transact(() => {
      const text = new Y.Text();
      text.insert(0, "online-edit");
      filesMap.set("note.md", text);
    }, "local");

    expect(persistedCalls.length).toBe(0);

    queue.flush();
    await Bun.sleep(0);

    expect(persistedCalls.length).toBeGreaterThan(0);
    expect(persistedCalls[persistedCalls.length - 1]?.length).toBe(1);

    queue.destroy();
  });

  test("destroy flushes pending updates immediately", async () => {
    const logger = new PluginLogger(false);
    const ydoc = new Y.Doc();
    const filesMap = ydoc.getMap<Y.Text>("files");
    const persistedCalls: PendingUpdate[][] = [];

    const queue = new OfflineQueue(
      ydoc,
      [],
      async (updates) => {
        persistedCalls.push([...updates]);
      },
      () => true,
      logger,
    );

    ydoc.transact(() => {
      const text = new Y.Text();
      text.insert(0, "offline");
      filesMap.set("offline.md", text);
    }, "local");

    queue.destroy();
    await Bun.sleep(0);

    expect(persistedCalls.length).toBeGreaterThan(0);
    expect(persistedCalls[persistedCalls.length - 1]?.length).toBe(1);
  });
});
