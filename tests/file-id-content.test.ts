import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

const SYNC_ORIGIN = Symbol("sync");

function contentFiles(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>("files");
}

function metaFiles(doc: Y.Doc): Y.Map<Record<string, unknown>> {
  return doc.getMap<Record<string, unknown>>("files");
}

function setContent(doc: Y.Doc, fileId: string, content: string): void {
  doc.transact(() => {
    const text = new Y.Text();
    text.insert(0, content);
    contentFiles(doc).set(fileId, text);
  }, "local");
}

function setMetaFile(
  doc: Y.Doc,
  fileId: string,
  path: string,
  deleted = false,
): void {
  doc.transact(() => {
    metaFiles(doc).set(fileId, { path, deleted });
  }, "local");
}

function renameFile(doc: Y.Doc, fileId: string, newPath: string): void {
  const deleted = isDeleted(doc, fileId);
  setMetaFile(doc, fileId, newPath, deleted);
}

function deleteFile(doc: Y.Doc, fileId: string): void {
  const currentPath = path(doc, fileId);
  if (!currentPath) {
    throw new Error(`Missing metadata for ${fileId}`);
  }

  setMetaFile(doc, fileId, currentPath, true);
}

function linkDocs(...docs: Y.Doc[]): () => void {
  const unsubs: Array<() => void> = [];

  for (const source of docs) {
    for (const target of docs) {
      if (source === target) continue;
      const handler = (update: Uint8Array, origin: unknown) => {
        if (origin === SYNC_ORIGIN) return;
        Y.applyUpdate(target, update, SYNC_ORIGIN);
      };
      source.on("update", handler);
      unsubs.push(() => source.off("update", handler));
    }
  }

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}

function syncBoth(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), SYNC_ORIGIN);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), SYNC_ORIGIN);
}

function content(doc: Y.Doc, fileId: string): string | undefined {
  return contentFiles(doc).get(fileId)?.toString();
}

function path(doc: Y.Doc, fileId: string): string | undefined {
  const metadata = metaFiles(doc).get(fileId);
  return typeof metadata?.path === "string" ? metadata.path : undefined;
}

function isDeleted(doc: Y.Doc, fileId: string): boolean {
  return metaFiles(doc).get(fileId)?.deleted === true;
}

describe("fileId-keyed content", () => {
  test("rename while both clients are editing keeps one shared Y.Text identity", () => {
    const contentA = new Y.Doc();
    const contentB = new Y.Doc();
    const metaA = new Y.Doc();
    const metaB = new Y.Doc();
    const disconnect = linkDocs(contentA, contentB, metaA, metaB);

    setMetaFile(metaA, "file-1", "note.md");
    setContent(contentA, "file-1", "base");

    syncBoth(contentA, contentB);
    syncBoth(metaA, metaB);
    disconnect();

    const aText = contentFiles(contentA).get("file-1");
    const bText = contentFiles(contentB).get("file-1");
    if (!aText || !bText) {
      throw new Error("Expected file-1 content on both clients");
    }

    renameFile(metaA, "file-1", "renamed.md");
    aText.insert(aText.length, " + local");
    bText.insert(0, "peer + ");

    syncBoth(contentA, contentB);
    syncBoth(metaA, metaB);

    expect([...contentFiles(contentA).keys()]).toEqual(["file-1"]);
    expect([...contentFiles(contentB).keys()]).toEqual(["file-1"]);
    expect(content(contentA, "file-1")).toBe("peer + base + local");
    expect(content(contentB, "file-1")).toBe("peer + base + local");
    expect(path(metaA, "file-1")).toBe("renamed.md");
    expect(path(metaB, "file-1")).toBe("renamed.md");
  });

  test("rename followed by reconnect restores the renamed path and shared content", () => {
    const sourceContent = new Y.Doc();
    const sourceMeta = new Y.Doc();

    setMetaFile(sourceMeta, "file-1", "note.md");
    setContent(sourceContent, "file-1", "base");
    renameFile(sourceMeta, "file-1", "renamed.md");
    const text = contentFiles(sourceContent).get("file-1");
    if (!text) {
      throw new Error("Expected file-1 content on source");
    }
    text.insert(text.length, " + remote");

    const reconnectedContent = new Y.Doc();
    const reconnectedMeta = new Y.Doc();
    syncBoth(sourceContent, reconnectedContent);
    syncBoth(sourceMeta, reconnectedMeta);

    expect([...contentFiles(reconnectedContent).keys()]).toEqual(["file-1"]);
    expect(content(reconnectedContent, "file-1")).toBe("base + remote");
    expect(path(reconnectedMeta, "file-1")).toBe("renamed.md");
  });

  test("rename followed by delete keeps content keyed by fileId until later cleanup", () => {
    const contentA = new Y.Doc();
    const contentB = new Y.Doc();
    const metaA = new Y.Doc();
    const metaB = new Y.Doc();

    setMetaFile(metaA, "file-1", "note.md");
    setContent(contentA, "file-1", "base");
    syncBoth(contentA, contentB);
    syncBoth(metaA, metaB);

    renameFile(metaA, "file-1", "renamed.md");
    syncBoth(metaA, metaB);
    deleteFile(metaB, "file-1");

    syncBoth(contentA, contentB);
    syncBoth(metaA, metaB);

    expect([...contentFiles(contentA).keys()]).toEqual(["file-1"]);
    expect([...contentFiles(contentB).keys()]).toEqual(["file-1"]);
    expect(content(contentA, "file-1")).toBe("base");
    expect(content(contentB, "file-1")).toBe("base");
    expect(path(metaA, "file-1")).toBe("renamed.md");
    expect(path(metaB, "file-1")).toBe("renamed.md");
    expect(isDeleted(metaA, "file-1")).toBe(true);
    expect(isDeleted(metaB, "file-1")).toBe(true);
  });
});
