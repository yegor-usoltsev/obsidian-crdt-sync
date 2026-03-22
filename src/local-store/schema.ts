/**
 * IndexedDB schema for durable local sync state.
 *
 * Database: "crdt-sync-{vaultId}"
 * Stores:
 *   - meta: vault identity, epoch, revision, client identity
 *   - files: cached file registry (fileId → FileMetadata)
 *   - pending: pending metadata intents awaiting server acknowledgment
 *   - cursors: sync cursors per document/channel
 *   - offline: offline text progress (fileId → encoded updates)
 *   - blobs: blob metadata cache (fileId → digest, size)
 *   - diagnostics: repair and debug metadata
 */

const DB_VERSION = 1;
const STORE_NAMES = [
  "meta",
  "files",
  "pending",
  "cursors",
  "offline",
  "blobs",
  "diagnostics",
] as const;

export type StoreName = (typeof STORE_NAMES)[number];

/**
 * Open the local sync store database for a given vault identity.
 */
export function openSyncStore(vaultId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`crdt-sync-${vaultId}`, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
  });
}

/** Generic get from a store by key. */
export function storeGet<T>(
  db: IDBDatabase,
  store: StoreName,
  key: string,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** Generic put into a store. */
export function storePut(
  db: IDBDatabase,
  store: StoreName,
  key: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Generic delete from a store. */
export function storeDelete(
  db: IDBDatabase,
  store: StoreName,
  key: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Get all entries from a store. */
export function storeGetAll<T>(
  db: IDBDatabase,
  store: StoreName,
): Promise<{ key: string; value: T }[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const objectStore = tx.objectStore(store);
    const results: { key: string; value: T }[] = [];
    const req = objectStore.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push({ key: cursor.key as string, value: cursor.value as T });
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** Clear all entries in a store. */
export function storeClear(db: IDBDatabase, store: StoreName): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
