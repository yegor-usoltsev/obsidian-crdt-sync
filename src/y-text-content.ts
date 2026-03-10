import { diff_match_patch } from "diff-match-patch";
import * as Y from "yjs";

export type SyncedFileContent = Y.Text | Uint8Array | Y.Array<Uint8Array>;
export type SyncedFileData = string | Uint8Array;
const BINARY_CHUNK_BYTES = 4 * 1024 * 1024;

function splitBinaryContent(content: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < content.length; start += BINARY_CHUNK_BYTES) {
    chunks.push(content.slice(start, start + BINARY_CHUNK_BYTES));
  }
  return chunks;
}

function joinBinaryChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length < 2) {
    return new Uint8Array(chunks[0] ?? []);
  }

  const merged = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function ensureTextEntry<T extends SyncedFileContent>(
  filesMap: Y.Map<T>,
  fileId: string,
): Y.Text {
  const existing = filesMap.get(fileId);
  if (existing instanceof Y.Text) {
    return existing;
  }
  if (existing instanceof Uint8Array || existing instanceof Y.Array) {
    throw new Error(`fileId "${fileId}" is stored as binary content`);
  }

  const created = new Y.Text();
  filesMap.set(fileId, created as T);
  return created;
}

export function replaceTextContent(
  ytext: Y.Text,
  nextContent: string,
): boolean {
  const currentContent = ytext.toString();
  if (currentContent === nextContent) {
    return false;
  }

  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(currentContent, nextContent);
  dmp.diff_cleanupSemantic(diffs);

  if (diffs.length === 0) {
    return false;
  }

  let cursor = 0;
  for (const [operation, text] of diffs) {
    switch (operation) {
      case 1:
        ytext.insert(cursor, text);
        cursor += text.length;
        break;
      case 0:
        cursor += text.length;
        break;
      case -1:
        ytext.delete(cursor, text.length);
        break;
    }
  }

  return true;
}

export function setTextContent<T extends SyncedFileContent>(
  filesMap: Y.Map<T>,
  fileId: string,
  nextContent: string,
): boolean {
  const hadEntry = filesMap.has(fileId);
  return (
    replaceTextContent(ensureTextEntry(filesMap, fileId), nextContent) ||
    !hadEntry
  );
}

export function writeBinaryContent<T extends SyncedFileContent>(
  ydoc: Y.Doc,
  filesMap: Y.Map<T>,
  fileId: string,
  nextContent: Uint8Array,
  origin: unknown = "local",
): boolean {
  const existing = filesMap.get(fileId);
  if (existing instanceof Y.Text) {
    throw new Error(`fileId "${fileId}" is stored as text content`);
  }

  if (
    filesMap.has(fileId) &&
    byteArraysEqual(
      getBinaryContent(filesMap, fileId) ?? new Uint8Array(),
      nextContent,
    )
  ) {
    return false;
  }

  const binary =
    existing instanceof Y.Array ? existing : new Y.Array<Uint8Array>();
  ydoc.transact(() => {
    if (!(existing instanceof Y.Array)) {
      filesMap.set(fileId, binary as T);
    } else if (binary.length > 0) {
      binary.delete(0, binary.length);
    }
  }, origin);
  for (const chunk of splitBinaryContent(nextContent)) {
    ydoc.transact(() => {
      binary.push([chunk]);
    }, origin);
  }

  return true;
}

export function getBinaryContent<T extends SyncedFileContent>(
  filesMap: Y.Map<T>,
  fileId: string,
): Uint8Array | null {
  const existing = filesMap.get(fileId);
  if (existing instanceof Uint8Array) {
    return existing;
  }
  if (existing instanceof Y.Array) {
    return joinBinaryChunks(existing.toArray());
  }
  return null;
}

export function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}
