/**
 * Core types shared across plugin modules.
 */

/** Stable file identity independent of path. */
export type FileId = string;

/** File kind classification. */
export type FileKind = "text" | "binary" | "directory";

/** Canonical file metadata as known to the server. */
export interface FileMetadata {
  fileId: FileId;
  path: string;
  kind: FileKind;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  contentDigest?: string;
  contentSize?: number;
  contentModTime?: number;
  contentAnchor: number;
}

/** Metadata intent types submitted by clients. */
export type MetadataIntentType = "create" | "rename" | "move" | "delete";

/** A metadata intent submitted to the server. */
export interface MetadataIntent {
  type: MetadataIntentType;
  clientId: string;
  operationId: string;
  fileId?: FileId;
  path?: string;
  newPath?: string;
  kind?: FileKind;
  contentAnchor?: number;
  contentDigest?: string;
}

/** Authoritative result from server after processing an intent. */
export interface MetadataCommit {
  operationId: string;
  fileId: FileId;
  path: string;
  kind: FileKind;
  deleted: boolean;
  contentAnchor: number;
  revision: number;
  epoch: string;
}

/** Rejection from server for an invalid intent. */
export interface MetadataReject {
  operationId: string;
  reason: string;
}

/** Server epoch and revision state. */
export interface EpochState {
  epoch: string;
  revision: number;
}

/** Sync connection status. */
export type SyncStatus = "offline" | "syncing" | "synced" | "error";

/** Conflict artifact naming. */
export function conflictArtifactName(
  basePath: string,
  timestamp: number,
  hostname: string,
): string {
  const ext = basePath.lastIndexOf(".");
  const name = ext >= 0 ? basePath.slice(0, ext) : basePath;
  const extPart = ext >= 0 ? basePath.slice(ext) : "";
  const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  return `${name}.sync-conflict-${ts}-${hostname}${extPart}`;
}
