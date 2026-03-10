import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  getBinaryContent,
  replaceTextContent,
  setTextContent,
  writeBinaryContent,
} from "../src/y-text-content";

describe("y-text-content", () => {
  test("creates a missing Y.Text entry with the requested content", () => {
    const doc = new Y.Doc();
    const filesMap = doc.getMap<Y.Text>("files");

    doc.transact(() => {
      expect(setTextContent(filesMap, "file-1", "hello")).toBe(true);
    }, "local");

    expect(filesMap.get("file-1")?.toString()).toBe("hello");
  });

  test("updates an existing Y.Text entry in place", () => {
    const doc = new Y.Doc();
    const filesMap = doc.getMap<Y.Text>("files");

    doc.transact(() => {
      setTextContent(filesMap, "file-1", "hello");
    }, "local");

    const original = filesMap.get("file-1");
    if (!original) {
      throw new Error('Expected Y.Text entry for "file-1"');
    }

    doc.transact(() => {
      expect(replaceTextContent(original, "hello world")).toBe(true);
    }, "local");

    expect(filesMap.get("file-1")).toBe(original);
    expect(original.toString()).toBe("hello world");
  });

  test("treats an unchanged content update as a no-op", () => {
    const doc = new Y.Doc();
    const filesMap = doc.getMap<Y.Text>("files");

    doc.transact(() => {
      setTextContent(filesMap, "file-1", "");
    }, "local");

    const original = filesMap.get("file-1");
    if (!original) {
      throw new Error('Expected Y.Text entry for "file-1"');
    }

    doc.transact(() => {
      expect(setTextContent(filesMap, "file-1", "")).toBe(false);
      expect(replaceTextContent(original, "")).toBe(false);
    }, "local");

    expect(filesMap.get("file-1")).toBe(original);
  });

  test("stores large binary content as chunks and reconstructs it", () => {
    const doc = new Y.Doc();
    const filesMap = doc.getMap<Y.Text | Uint8Array | Y.Array<Uint8Array>>(
      "files",
    );
    const binary = new Uint8Array(10 * 1024 * 1024 + 123);
    for (let i = 0; i < binary.length; i += 4096) {
      binary[i] = i % 251;
    }

    expect(writeBinaryContent(doc, filesMap, "file-1", binary)).toBe(true);

    const stored = filesMap.get("file-1");
    expect(stored).toBeInstanceOf(Y.Array);
    expect(getBinaryContent(filesMap, "file-1")).toEqual(binary);
  });
});
