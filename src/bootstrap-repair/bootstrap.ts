/**
 * Bootstrap, rebootstrap, and repair flows.
 */

import type { LocalSyncStore } from "../local-store/sync-store";
import type { PluginLogger } from "../shared/logger";
import type { EpochState, FileMetadata, SyncStatus } from "../shared/types";

/** Retry backoff: min(5 * 2^failureCount * 1000, 300000) ms */
export function retryBackoffMs(failureCount: number): number {
  return Math.min(5 * 2 ** failureCount * 1000, 300_000);
}

/** Size-tiered re-sync cooldown after successful sync. */
export function resyncCooldownMs(fileSize: number): number {
  if (fileSize <= 10 * 1024) return 10_000;
  if (fileSize <= 100 * 1024) return 20_000;
  return 30_000;
}

/** Debounce timings for vault events. */
export const DEBOUNCE = {
  /** Create events settle time (ms). */
  createSettle: 350,
  /** Modify events debounce time (ms). */
  modifyDebounce: 300,
} as const;

export interface BootstrapDeps {
  logger: PluginLogger;
  store: LocalSyncStore;
  /** Fetch canonical metadata from the server. */
  fetchCanonicalMetadata(): Promise<{
    files: FileMetadata[];
    epoch: EpochState;
  }>;
  /** Update sync status. */
  setStatus(status: SyncStatus): void;
  /** Confirm destructive action with user. */
  confirmDestructive(message: string): Promise<boolean>;
}

export class BootstrapManager {
  private deps: BootstrapDeps;

  constructor(deps: BootstrapDeps) {
    this.deps = deps;
  }

  /**
   * Initial bootstrap: resolve canonical metadata, populate local store.
   */
  async bootstrap(): Promise<void> {
    const { logger, store } = this.deps;
    logger.info("Starting bootstrap");
    this.deps.setStatus("syncing");

    const { files, epoch } = await this.deps.fetchCanonicalMetadata();

    // Check empty-vault safety
    const localFiles = await store.getAllFiles();
    if (localFiles.length > 0 && files.length === 0) {
      logger.warn("Server has empty vault but local has files - pausing");
      this.deps.setStatus("error");
      return;
    }

    // Store epoch and file registry
    await store.setEpochState(epoch);
    await store.clearFiles();
    for (const file of files) {
      await store.putFile(file);
    }

    logger.info("Bootstrap complete", {
      fileCount: files.length,
      epoch: epoch.epoch,
    });
    this.deps.setStatus("synced");
  }

  /**
   * Rebootstrap on epoch mismatch: rebuild local state from server.
   */
  async rebootstrap(newEpoch: EpochState): Promise<void> {
    const { logger, store } = this.deps;
    logger.info("Starting rebootstrap due to epoch change", {
      newEpoch: newEpoch.epoch,
    });
    this.deps.setStatus("syncing");

    const pending = await store.getAllPending();
    if (pending.length > 0) {
      const confirmed = await this.deps.confirmDestructive(
        `Rebootstrap will discard ${pending.length} pending operations. Continue?`,
      );
      if (!confirmed) {
        logger.info("Rebootstrap cancelled by user");
        this.deps.setStatus("error");
        return;
      }
    }

    await store.clearPending();
    await store.clearOfflineProgress();
    await this.bootstrap();
  }

  /**
   * Non-destructive index rebuild: rebuild file registry and path indexes
   * from durable store without discarding pending operations.
   */
  async rebuildIndexes(): Promise<void> {
    const { logger } = this.deps;
    logger.info("Rebuilding local indexes");
    this.deps.setStatus("syncing");

    const { files, epoch } = await this.deps.fetchCanonicalMetadata();
    await this.deps.store.setEpochState(epoch);
    await this.deps.store.clearFiles();
    for (const file of files) {
      await this.deps.store.putFile(file);
    }

    logger.info("Index rebuild complete", { fileCount: files.length });
    this.deps.setStatus("synced");
  }

  /**
   * Export diagnostics as a JSON object.
   */
  async exportDiagnostics(): Promise<Record<string, unknown>> {
    const { store } = this.deps;

    const [epochState, files, pending, offline] = await Promise.all([
      store.getEpochState(),
      store.getAllFiles(),
      store.getAllPending(),
      store.getAllOfflineProgress(),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      epoch: epochState,
      fileCount: files.length,
      pendingOperations: pending,
      offlineProgressEntries: offline.length,
      activeFiles: files.filter((f) => !f.deleted).length,
      deletedFiles: files.filter((f) => f.deleted).length,
    };
  }
}
