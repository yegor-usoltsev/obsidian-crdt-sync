import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { PluginLogger } from "../../src/shared/logger";
import { importTextViaDiff } from "../../src/text-sync/diff-bridge";
import { TextDocManager } from "../../src/text-sync/text-doc-manager";

const logger = new PluginLogger("test", false);

describe("text-sync", () => {
  describe("TextDocManager", () => {
    it("creates a document for a file ID", () => {
      const mgr = new TextDocManager({ logger });
      const entry = mgr.getOrCreate("file-1");
      expect(entry.fileId).toBe("file-1");
      expect(entry.doc).toBeInstanceOf(Y.Doc);
      expect(entry.synced).toBe(false);
      mgr.destroyAll();
    });

    it("returns same document for same file ID", () => {
      const mgr = new TextDocManager({ logger });
      const a = mgr.getOrCreate("file-1");
      const b = mgr.getOrCreate("file-1");
      expect(a).toBe(b);
      mgr.destroyAll();
    });

    it("imports text content", () => {
      const mgr = new TextDocManager({ logger });
      mgr.importText("file-1", "Hello, world!");
      expect(mgr.getText("file-1")).toBe("Hello, world!");
      mgr.destroyAll();
    });

    it("skips import when content is unchanged", () => {
      const mgr = new TextDocManager({ logger });
      mgr.importText("file-1", "Hello");
      // biome-ignore lint/style/noNonNullAssertion: just imported above
      const entry = mgr.get("file-1")!;
      let updateCount = 0;
      entry.doc.on("update", () => updateCount++);
      mgr.importText("file-1", "Hello"); // same content
      expect(updateCount).toBe(0);
      mgr.destroyAll();
    });

    it("destroys documents", () => {
      const mgr = new TextDocManager({ logger });
      mgr.getOrCreate("file-1");
      expect(mgr.has("file-1")).toBe(true);
      mgr.destroy("file-1");
      expect(mgr.has("file-1")).toBe(false);
    });

    it("encodes state for persistence", () => {
      const mgr = new TextDocManager({ logger });
      mgr.importText("file-1", "test content");
      const state = mgr.encodeState("file-1");
      expect(state).toBeInstanceOf(Uint8Array);
      expect(state?.byteLength).toBeGreaterThan(0);
      mgr.destroyAll();
    });

    it("applies remote updates", () => {
      const mgr1 = new TextDocManager({ logger });
      const mgr2 = new TextDocManager({ logger });

      mgr1.importText("file-1", "Hello from client 1");
      // biome-ignore lint/style/noNonNullAssertion: just imported above
      const update = mgr1.encodeState("file-1")!;

      mgr2.applyUpdate("file-1", update);
      expect(mgr2.getText("file-1")).toBe("Hello from client 1");

      mgr1.destroyAll();
      mgr2.destroyAll();
    });
  });

  describe("diff-bridge", () => {
    it("imports via diff: insertion", () => {
      const doc = new Y.Doc();
      const yText = doc.getText("content");
      yText.insert(0, "Hello world");
      importTextViaDiff(yText, "Hello beautiful world");
      expect(yText.toString()).toBe("Hello beautiful world");
      doc.destroy();
    });

    it("imports via diff: deletion", () => {
      const doc = new Y.Doc();
      const yText = doc.getText("content");
      yText.insert(0, "Hello beautiful world");
      importTextViaDiff(yText, "Hello world");
      expect(yText.toString()).toBe("Hello world");
      doc.destroy();
    });

    it("imports via diff: replacement", () => {
      const doc = new Y.Doc();
      const yText = doc.getText("content");
      yText.insert(0, "foo bar baz");
      importTextViaDiff(yText, "foo qux baz");
      expect(yText.toString()).toBe("foo qux baz");
      doc.destroy();
    });

    it("skips diff when content is identical", () => {
      const doc = new Y.Doc();
      const yText = doc.getText("content");
      yText.insert(0, "same");
      let updateCount = 0;
      doc.on("update", () => updateCount++);
      importTextViaDiff(yText, "same");
      expect(updateCount).toBe(0);
      doc.destroy();
    });

    it("handles concurrent edits via CRDT merge", () => {
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();
      const text1 = doc1.getText("content");
      const text2 = doc2.getText("content");

      // Initial state
      text1.insert(0, "Hello world");
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      // Concurrent edits
      text1.insert(5, " beautiful");
      text2.insert(11, "!");

      // Merge
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

      // Both should converge
      expect(text1.toString()).toBe(text2.toString());
      expect(text1.toString()).toContain("beautiful");
      expect(text1.toString()).toContain("!");

      doc1.destroy();
      doc2.destroy();
    });
  });
});
