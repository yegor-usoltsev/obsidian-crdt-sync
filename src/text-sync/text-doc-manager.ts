/**
 * Text document manager: per-file Yjs document lifecycle.
 * Each text file gets its own logical Y.Doc keyed by stable file identity.
 */

import * as Y from "yjs";
import type { PluginLogger } from "../shared/logger";
import type { FileId } from "../shared/types";

export interface TextDocEntry {
  fileId: FileId;
  doc: Y.Doc;
  text: Y.Text;
  /** Whether this doc has been synced with the server at least once. */
  synced: boolean;
}

export interface TextDocManagerDeps {
  logger: PluginLogger;
}

export class TextDocManager {
  private docs = new Map<FileId, TextDocEntry>();
  private logger: PluginLogger;

  constructor(deps: TextDocManagerDeps) {
    this.logger = deps.logger;
  }

  /** Get or create a text document for a file identity. */
  getOrCreate(fileId: FileId): TextDocEntry {
    let entry = this.docs.get(fileId);
    if (!entry) {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      entry = { fileId, doc, text, synced: false };
      this.docs.set(fileId, entry);
      this.logger.debug("Created text doc", { fileId });
    }
    return entry;
  }

  /** Get an existing text document entry. */
  get(fileId: FileId): TextDocEntry | undefined {
    return this.docs.get(fileId);
  }

  /** Check if a text document exists. */
  has(fileId: FileId): boolean {
    return this.docs.has(fileId);
  }

  /** Remove and destroy a text document. */
  destroy(fileId: FileId): void {
    const entry = this.docs.get(fileId);
    if (entry) {
      entry.doc.destroy();
      this.docs.delete(fileId);
      this.logger.debug("Destroyed text doc", { fileId });
    }
  }

  /** Import text content into a Yjs document (for external edits). */
  importText(fileId: FileId, content: string): void {
    const entry = this.getOrCreate(fileId);
    const current = entry.text.toString();
    if (current === content) return;

    entry.doc.transact(() => {
      entry.text.delete(0, entry.text.length);
      entry.text.insert(0, content);
    });
  }

  /** Get the current text content of a document. */
  getText(fileId: FileId): string | undefined {
    const entry = this.docs.get(fileId);
    if (!entry) return undefined;
    return entry.text.toString();
  }

  /** Get all active file IDs. */
  getActiveFileIds(): FileId[] {
    return Array.from(this.docs.keys());
  }

  /** Destroy all documents. */
  destroyAll(): void {
    for (const entry of this.docs.values()) {
      entry.doc.destroy();
    }
    this.docs.clear();
  }

  /** Get encoded state for persistence. */
  encodeState(fileId: FileId): Uint8Array | undefined {
    const entry = this.docs.get(fileId);
    if (!entry) return undefined;
    return Y.encodeStateAsUpdate(entry.doc);
  }

  /** Apply a remote update to a document. */
  applyUpdate(fileId: FileId, update: Uint8Array): void {
    const entry = this.getOrCreate(fileId);
    Y.applyUpdate(entry.doc, update);
  }
}
