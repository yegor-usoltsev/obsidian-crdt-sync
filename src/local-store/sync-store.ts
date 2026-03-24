/**
 * High-level local sync store operations built on IndexedDB schema.
 */

import type { EpochState, FileMetadata, MetadataIntent } from "../shared/types";
import {
  openSyncStore,
  storeClear,
  storeDelete,
  storeGet,
  storeGetAll,
  storePut,
} from "./schema";

export interface LocalSyncStore {
  /** Open and initialize the store. */
  open(): Promise<void>;
  /** Close the store. */
  close(): void;

  // Vault identity & epoch
  getVaultId(): Promise<string | undefined>;
  setVaultId(id: string): Promise<void>;
  getEpochState(): Promise<EpochState | undefined>;
  setEpochState(state: EpochState): Promise<void>;
  getClientId(): Promise<string | undefined>;
  setClientId(id: string): Promise<void>;

  // File registry cache
  getFile(fileId: string): Promise<FileMetadata | undefined>;
  getFileByPath(path: string): Promise<FileMetadata | undefined>;
  putFile(meta: FileMetadata): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
  getAllFiles(): Promise<FileMetadata[]>;
  clearFiles(): Promise<void>;

  // Pending metadata intents
  enqueuePending(intent: MetadataIntent): Promise<void>;
  dequeuePending(operationId: string): Promise<void>;
  getAllPending(): Promise<MetadataIntent[]>;
  clearPending(): Promise<void>;

  // Offline text progress
  saveOfflineProgress(fileId: string, data: Uint8Array): Promise<void>;
  getOfflineProgress(fileId: string): Promise<Uint8Array | undefined>;
  deleteOfflineProgress(fileId: string): Promise<void>;
  getAllOfflineProgress(): Promise<{ fileId: string; data: Uint8Array }[]>;
  clearOfflineProgress(): Promise<void>;
}

export function createLocalSyncStore(vaultId: string): LocalSyncStore {
  let db: IDBDatabase | null = null;

  function requireDb(): IDBDatabase {
    if (!db) throw new Error("Sync store not open");
    return db;
  }

  return {
    async open() {
      db = await openSyncStore(vaultId);
    },

    close() {
      db?.close();
      db = null;
    },

    // Vault identity & epoch
    getVaultId: () => storeGet(requireDb(), "meta", "vaultId"),
    setVaultId: (id) => storePut(requireDb(), "meta", "vaultId", id),
    getEpochState: () => storeGet(requireDb(), "meta", "epochState"),
    setEpochState: (s) => storePut(requireDb(), "meta", "epochState", s),
    getClientId: () => storeGet(requireDb(), "meta", "clientId"),
    setClientId: (id) => storePut(requireDb(), "meta", "clientId", id),

    // File registry
    getFile: (fileId) => storeGet(requireDb(), "files", fileId),
    async getFileByPath(path: string) {
      const entries = await storeGetAll<FileMetadata>(requireDb(), "files");
      return entries.find((e) => e.value.path === path && !e.value.deleted)
        ?.value;
    },
    putFile: (meta) => storePut(requireDb(), "files", meta.fileId, meta),
    deleteFile: (fileId) => storeDelete(requireDb(), "files", fileId),
    async getAllFiles() {
      const entries = await storeGetAll<FileMetadata>(requireDb(), "files");
      return entries.map((e) => e.value);
    },
    clearFiles: () => storeClear(requireDb(), "files"),

    // Pending
    enqueuePending: (intent) =>
      storePut(requireDb(), "pending", intent.operationId, intent),
    dequeuePending: (opId) => storeDelete(requireDb(), "pending", opId),
    async getAllPending() {
      const entries = await storeGetAll<MetadataIntent>(requireDb(), "pending");
      return entries.map((e) => e.value);
    },
    clearPending: () => storeClear(requireDb(), "pending"),

    // Offline progress
    saveOfflineProgress: (fileId, data) =>
      storePut(requireDb(), "offline", fileId, data),
    getOfflineProgress: (fileId) => storeGet(requireDb(), "offline", fileId),
    deleteOfflineProgress: (fileId) =>
      storeDelete(requireDb(), "offline", fileId),
    async getAllOfflineProgress() {
      const entries = await storeGetAll<Uint8Array>(requireDb(), "offline");
      return entries.map((e) => ({ fileId: e.key, data: e.value }));
    },
    clearOfflineProgress: () => storeClear(requireDb(), "offline"),
  };
}
