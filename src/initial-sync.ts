import type { ConnectionManager } from "./connection";
import type { IncomingSync } from "./incoming-sync";
import type { PluginLogger } from "./logger";
import type { MetadataMirror } from "./meta-apply";
import type { MetadataSync } from "./metadata-sync";
import type { OfflineQueue } from "./offline-queue";
import type { StatusBarManager } from "./status";
import type { VaultWatcher } from "./vault-watcher";

export class InitialSync {
  private readonly connection: Pick<
    ConnectionManager,
    "setSyncedCallback" | "waitForDocumentSync"
  >;
  private readonly vaultWatcher: Pick<VaultWatcher, "enable" | "disable">;
  private readonly incomingSync: Pick<
    IncomingSync,
    "enable" | "disable" | "flushActiveFilesToVault"
  >;
  private readonly statusBar: Pick<
    StatusBarManager,
    "setSynced" | "setSyncing" | "setError"
  >;
  private readonly metadataMirror: Pick<
    MetadataMirror,
    "enable" | "disable" | "replayAvailableEvents"
  >;
  private readonly metadataSync: Pick<
    MetadataSync,
    "onConnectionSynced" | "replayPendingContentChanges"
  >;
  private readonly offlineQueue:
    | Pick<OfflineQueue, "onSynced">
    | null
    | undefined;
  private readonly rebuildIndexes: (() => void) | undefined;
  private readonly logger: PluginLogger;
  private rerunRequested = false;
  private activeBootstrap: Promise<void> | null = null;

  constructor(
    connection: ConnectionManager,
    vaultWatcher: VaultWatcher,
    incomingSync: IncomingSync,
    statusBar: StatusBarManager,
    metadataMirror: MetadataMirror,
    metadataSync: MetadataSync,
    logger: PluginLogger,
    offlineQueue?: OfflineQueue | null,
    rebuildIndexes?: () => void,
  ) {
    this.connection = connection;
    this.vaultWatcher = vaultWatcher;
    this.incomingSync = incomingSync;
    this.statusBar = statusBar;
    this.metadataMirror = metadataMirror;
    this.metadataSync = metadataSync;
    this.logger = logger;
    this.offlineQueue = offlineQueue;
    this.rebuildIndexes = rebuildIndexes;
    this.vaultWatcher.enable();

    this.connection.setSyncedCallback(() => {
      void this.requestFullSync();
    });
  }

  requestFullSync(): Promise<void> {
    this.rerunRequested = true;

    if (!this.activeBootstrap) {
      this.activeBootstrap = this.runBootstrapLoop().finally(() => {
        this.activeBootstrap = null;
      });
    }

    return this.activeBootstrap;
  }

  private async runBootstrapLoop(): Promise<void> {
    while (this.rerunRequested) {
      this.rerunRequested = false;
      await this.runBootstrap();
    }
  }

  private async runBootstrap(): Promise<void> {
    this.logger.debug("sync bootstrap starting");
    this.metadataMirror.disable();
    this.incomingSync.disable();
    this.vaultWatcher.disable();
    this.statusBar.setSyncing();

    try {
      this.logger.debug("waiting for vault-meta sync");
      await this.connection.waitForDocumentSync("vault-meta");
      this.rebuildIndexes?.();
      this.logger.debug("replaying metadata events");
      await this.metadataMirror.replayAvailableEvents();
      this.logger.debug("waiting for vault-content sync");
      await this.connection.waitForDocumentSync("vault-content");
      this.logger.debug("replaying pending content changes");
      await this.metadataSync.replayPendingContentChanges();
      this.logger.debug("flushing active files to vault");
      await this.incomingSync.flushActiveFilesToVault();
      this.metadataSync.onConnectionSynced();
      this.offlineQueue?.onSynced();
      this.metadataMirror.enable();
      this.incomingSync.enable();
      this.vaultWatcher.enable();
      this.statusBar.setSynced();
      this.logger.info("sync bootstrap completed");
    } catch (error) {
      this.logger.error("sync bootstrap failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.statusBar.setError("sync bootstrap failed");
      this.vaultWatcher.enable();
    }
  }
}
