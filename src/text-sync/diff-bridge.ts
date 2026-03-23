/**
 * Filesystem-to-Yjs import: diff-based bridging for external text edits.
 * Uses diff-match-patch to compute minimal edits and apply them to Y.Text.
 */

import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";
import { LOCAL_ORIGIN } from "./text-doc-manager";

const dmp = new DiffMatchPatch();

/**
 * Import filesystem content into a Y.Text via diff-based bridging.
 * Computes a minimal set of edits to transform the current CRDT state
 * into the new filesystem content.
 */
export function importTextViaDiff(yText: Y.Text, newContent: string): void {
  const currentContent = yText.toString();
  if (currentContent === newContent) return;

  const diffs = dmp.diff_main(currentContent, newContent);
  dmp.diff_cleanupEfficiency(diffs);

  // Apply diffs as Yjs operations in a single transaction
  const doc = yText.doc;
  if (!doc) return;

  doc.transact(() => {
    let offset = 0;
    for (const [op, text] of diffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) {
        offset += text.length;
      } else if (op === DiffMatchPatch.DIFF_DELETE) {
        yText.delete(offset, text.length);
      } else if (op === DiffMatchPatch.DIFF_INSERT) {
        yText.insert(offset, text);
        offset += text.length;
      }
    }
  }, LOCAL_ORIGIN);
}
