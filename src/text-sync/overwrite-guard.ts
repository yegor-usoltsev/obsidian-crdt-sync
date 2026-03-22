/**
 * Overwrite safety guard: re-stat local file before writing remote
 * content and abort if local content changed during the apply window.
 */

import type { TFile, Vault } from "obsidian";

export interface OverwriteGuardDeps {
  vault: Vault;
}

/**
 * Safely apply remote text content to a local file.
 * Re-stats the file before writing to detect concurrent local changes.
 *
 * @returns true if the write was performed, false if aborted due to local change.
 */
export async function safeWriteTextContent(
  deps: OverwriteGuardDeps,
  file: TFile,
  expectedMtime: number,
  newContent: string,
): Promise<boolean> {
  // Re-stat the file just before writing
  const currentStat = file.stat;
  if (currentStat.mtime !== expectedMtime) {
    // Local file changed since we decided to write — abort
    return false;
  }

  await deps.vault.modify(file, newContent);
  return true;
}

/**
 * Safely write binary content to a local file.
 *
 * @returns true if the write was performed, false if aborted.
 */
export async function safeWriteBinaryContent(
  deps: OverwriteGuardDeps,
  file: TFile,
  expectedMtime: number,
  newContent: ArrayBuffer,
): Promise<boolean> {
  const currentStat = file.stat;
  if (currentStat.mtime !== expectedMtime) {
    return false;
  }

  await deps.vault.modifyBinary(file, newContent);
  return true;
}
