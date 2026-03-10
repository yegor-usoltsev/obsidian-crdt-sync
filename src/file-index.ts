import type * as Y from "yjs";
import type { FileKind } from "./file-kind";
import { coerceFileKind } from "./file-kind";

export interface ActiveFileEntry {
  fileId: string;
  path: string;
  kind: FileKind;
}

function getActivePath(metadata?: Y.Map<unknown>): string | undefined {
  const path = metadata?.get("path");
  return metadata?.get("deleted") === true || typeof path !== "string" || !path
    ? undefined
    : path;
}

export function getPathForFileId(
  metaFiles: Y.Map<Y.Map<unknown>>,
  fileId: string,
): string | undefined {
  return getActivePath(metaFiles.get(fileId));
}

export function findActiveFileIdByPath(
  metaFiles: Y.Map<Y.Map<unknown>>,
  path: string,
): string | undefined {
  for (const [fileId, metadata] of metaFiles.entries()) {
    if (getActivePath(metadata) === path) {
      return fileId;
    }
  }

  return undefined;
}

export function listActiveFiles(
  metaFiles: Y.Map<Y.Map<unknown>>,
): ActiveFileEntry[] {
  const entries: ActiveFileEntry[] = [];

  for (const [fileId, metadata] of metaFiles.entries()) {
    const path = getActivePath(metadata);
    if (!path) {
      continue;
    }

    entries.push({
      fileId,
      path,
      kind: coerceFileKind(metadata.get("kind")) ?? "text",
    });
  }

  return entries;
}
