import { WebSocketStatus } from "@hocuspocus/provider";
import { Component, Notice, Plugin, TFile } from "obsidian";
import type * as Y from "yjs";
import { ConnectionManager } from "./connection";
import { EchoPrevention } from "./echo-prevention";
import { detectVaultFileKind, MAX_SYNC_FILE_BYTES } from "./file-kind";
import { IncomingSync } from "./incoming-sync";
import { InitialSync } from "./initial-sync";
import { PluginLogger } from "./logger";
import { createObsidianVaultFacade, MetadataMirror } from "./meta-apply";
import { MetadataSync } from "./metadata-sync";
import { createDebounce } from "./obsidian-debounce";
import { OfflineQueue, type PendingUpdate } from "./offline-queue";
import {
  type CrdtSyncSettings,
  CrdtSyncSettingTab,
  DEFAULT_SETTINGS,
  validateAuthToken,
  validateServerUrl,
} from "./settings";
import {
  buildIndexesFromMetaFiles,
  loadSyncState,
  type SyncState,
} from "./state";
import { StatusBarManager } from "./status";
import { isIgnoredSyncPath } from "./sync-ignore";
import { VaultWatcher } from "./vault-watcher";

const AUTH_TOKEN_SECRET_ID = "crdt-sync-auth-token";
const SYNC_STATE_SAVE_DEBOUNCE_MS = 250;

interface PersistedPluginData {
  settings?: Record<string, unknown>;
  syncState?: unknown;
  pendingUpdates?: PendingUpdate[];
  serverUrl?: unknown;
  debugLogging?: unknown;
  authToken?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default class CrdtSyncPlugin extends Plugin {
  clientId = "";
  settings!: CrdtSyncSettings;
  syncState!: SyncState;
  statusBar!: StatusBarManager;
  connection: ConnectionManager | null = null;
  echoPrevention: EchoPrevention = new EchoPrevention();
  vaultWatcher: VaultWatcher | null = null;
  incomingSync: IncomingSync | null = null;
  initialSync: InitialSync | null = null;
  offlineQueue: OfflineQueue | null = null;
  metadataSync: MetadataSync | null = null;
  metadataMirror: MetadataMirror | null = null;
  logger: PluginLogger = new PluginLogger(false, { component: "plugin" });

  private connectionScope: Component | null = null;
  private storedPendingUpdates: PendingUpdate[] = [];
  private metaFilesObserver:
    | ((
        events: Y.YEvent<Y.AbstractType<unknown>>[],
        transaction: Y.Transaction,
      ) => void)
    | null = null;
  private readonly persistSyncStateDebounced = createDebounce(
    () => {
      void this.persistPluginData();
    },
    SYNC_STATE_SAVE_DEBOUNCE_MS,
    true,
  );

  override async onload() {
    await this.loadSettings();
    this.statusBar = new StatusBarManager(this.addStatusBarItem());
    this.addSettingTab(new CrdtSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Run full sync", () => {
      void this.runManualFullSync();
    });
    this.addCommand({
      id: "run-full-sync",
      name: "Run full sync",
      callback: () => {
        void this.runManualFullSync();
      },
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        this.offlineQueue?.flush();
      }
    });

    this.initConnection();
  }

  override onunload() {
    this.destroyConnection();
  }

  async loadSettings() {
    const data = ((await this.loadData()) ?? {}) as PersistedPluginData;
    const settingsSource = isRecord(data.settings)
      ? data.settings
      : (data as Record<string, unknown>);
    const { authToken: legacyAuthToken, ...legacySettingsData } =
      settingsSource;
    const authToken = this.loadStoredAuthToken(legacyAuthToken);

    this.settings = Object.assign({}, DEFAULT_SETTINGS, legacySettingsData, {
      authToken,
    });
    this.syncState = loadSyncState(data.syncState);
    this.clientId = this.syncState.clientId;
    this.logger = new PluginLogger(this.settings.debugLogging, {
      component: "plugin",
      clientId: this.clientId,
    });
    this.storedPendingUpdates = Array.isArray(data.pendingUpdates)
      ? (data.pendingUpdates as PendingUpdate[])
      : [];

    if (!isRecord(data.settings) || !isRecord(data.syncState)) {
      await this.persistPluginData();
    }
  }

  async saveSettings(reinitConnection = true) {
    this.logger.setEnabled(this.settings.debugLogging);
    this.saveStoredAuthToken(this.settings.authToken);
    await this.persistPluginData();
    if (reinitConnection) {
      this.reinitConnection();
    }
  }

  private loadStoredAuthToken(legacyAuthToken: unknown): string {
    const storedToken =
      this.app.secretStorage.getSecret(AUTH_TOKEN_SECRET_ID) ?? "";
    if (storedToken) return storedToken;

    if (typeof legacyAuthToken === "string" && legacyAuthToken.length > 0) {
      this.app.secretStorage.setSecret(AUTH_TOKEN_SECRET_ID, legacyAuthToken);
      return legacyAuthToken;
    }

    return "";
  }

  private saveStoredAuthToken(token: string): void {
    this.app.secretStorage.setSecret(AUTH_TOKEN_SECRET_ID, token);
  }

  initConnection(): void {
    const { serverUrl, authToken } = this.settings;
    if (!serverUrl || !authToken) {
      return;
    }

    const urlError = validateServerUrl(serverUrl);
    if (urlError) {
      this.logger.warn("connection blocked by invalid server URL", {
        error: urlError,
      });
      this.statusBar?.setError("invalid server URL");
      return;
    }

    const tokenError = validateAuthToken(authToken);
    if (tokenError) {
      this.logger.warn("connection blocked by invalid auth token", {
        error: tokenError,
      });
      this.statusBar?.setError("invalid auth token");
      return;
    }

    this.connectionScope = this.addChild(new Component());
    this.connection = new ConnectionManager(
      serverUrl,
      authToken,
      this.statusBar,
      this.logger.child({ component: "connection" }),
      this.clientId,
      this.connectionScope,
    );
    this.observeMetaFiles();

    const pendingUpdates = this.storedPendingUpdates;
    this.storedPendingUpdates = [];
    this.offlineQueue = new OfflineQueue(
      this.connection.contentDoc,
      pendingUpdates,
      async (updates) => {
        this.storedPendingUpdates = [...updates];
        await this.persistPluginData();
      },
      () => this.connection?.status === WebSocketStatus.Connected,
      this.logger.child({ component: "offline-queue" }),
      this.connectionScope,
    );

    this.metadataMirror = new MetadataMirror({
      vaultFacade: createObsidianVaultFacade(this.app.vault),
      connection: this.connection,
      echoPrevention: this.echoPrevention,
      localClientId: this.clientId,
      getSyncState: () => this.syncState,
      updateSyncState: (updater) => {
        this.syncState = updater(this.syncState);
        this.scheduleSyncStatePersist();
      },
      notify: (message) => {
        new Notice(message);
      },
      registerConflictCopy: async (path) => {
        if (!this.metadataSync) {
          return;
        }

        if (this.metadataSync.resolveFileId(path)) {
          return;
        }

        const file = this.app.vault.getAbstractFileByPath(path);
        if (
          !file ||
          (file instanceof TFile && file.stat.size > MAX_SYNC_FILE_BYTES)
        ) {
          return;
        }
        if (
          isIgnoredSyncPath(path, file instanceof TFile ? "file" : "directory")
        ) {
          return;
        }

        this.metadataSync.requestCreate(
          path,
          await detectVaultFileKind(this.app.vault, file),
        );
      },
      logger: this.logger.child({ component: "metadata-mirror" }),
      owner: this.connectionScope,
    });

    this.metadataSync = new MetadataSync({
      connection: this.connection,
      clientId: this.clientId,
      getSyncState: () => this.syncState,
      updateSyncState: (updater) => {
        this.syncState = updater(this.syncState);
        this.scheduleSyncStatePersist();
      },
      readLocalFile: async (path, kind) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.stat.size > MAX_SYNC_FILE_BYTES) {
          return null;
        }

        return kind === "text"
          ? this.app.vault.cachedRead(file)
          : new Uint8Array(await this.app.vault.readBinary(file));
      },
      notify: (message) => {
        new Notice(message);
      },
      persistSyncStateNow: async () => {
        await this.persistPluginData();
      },
      reconcileRejectedOperation: async (message, pendingOperation) => {
        await this.metadataMirror?.reconcileRejectedOperation(
          message,
          pendingOperation,
        );
      },
      owner: this.connectionScope,
    });

    this.vaultWatcher = new VaultWatcher(
      this.app.vault,
      this.connection,
      this.echoPrevention,
      this.metadataSync,
      this.logger.child({ component: "vault-watcher" }),
      this.connectionScope,
    );

    this.incomingSync = new IncomingSync(
      this.app.vault,
      this.connection,
      this.echoPrevention,
      this.logger.child({ component: "incoming-sync" }),
      this.connectionScope,
    );

    this.initialSync = new InitialSync(
      this.connection,
      this.vaultWatcher,
      this.incomingSync,
      this.statusBar,
      this.metadataMirror,
      this.metadataSync,
      this.logger.child({ component: "initial-sync" }),
      this.offlineQueue,
      () => {
        this.rebuildIndexesFromCanonicalMetadata();
      },
    );
  }

  destroyConnection(): void {
    this.persistSyncStateDebounced.run();
    this.unobserveMetaFiles();
    this.initialSync = null;
    if (this.offlineQueue) {
      this.storedPendingUpdates = this.offlineQueue.getPendingUpdates();
    }
    this.incomingSync = null;
    this.metadataMirror = null;
    this.metadataSync = null;
    this.vaultWatcher = null;
    this.offlineQueue = null;
    this.connection = null;
    if (this.connectionScope) {
      this.removeChild(this.connectionScope);
      this.connectionScope = null;
    }
    this.statusBar?.setOffline();
  }

  reinitConnection(): void {
    this.destroyConnection();
    this.initConnection();
  }

  private async runManualFullSync(): Promise<void> {
    if (!this.connection || !this.initialSync) {
      new Notice("CRDT Sync is not connected.");
      return;
    }

    this.connection.requestReconnect("manual");
    await this.initialSync.requestFullSync();
    new Notice("CRDT Sync full sync finished.");
  }

  private observeMetaFiles(): void {
    if (!this.connection) {
      return;
    }

    this.metaFilesObserver = () => {
      this.rebuildIndexesFromCanonicalMetadata();
    };

    this.connection.metaFiles.observeDeep(this.metaFilesObserver);
    this.connectionScope?.register(() => this.unobserveMetaFiles());
  }

  private unobserveMetaFiles(): void {
    if (this.connection && this.metaFilesObserver) {
      this.connection.metaFiles.unobserveDeep(this.metaFilesObserver);
      this.metaFilesObserver = null;
    }
  }

  private scheduleSyncStatePersist(): void {
    this.persistSyncStateDebounced();
  }

  private async persistPluginData(): Promise<void> {
    const pendingUpdates =
      this.offlineQueue?.getPendingUpdates() ?? this.storedPendingUpdates;
    const { authToken: _authToken, ...persistedSettings } = this.settings;

    await this.saveData({
      settings: persistedSettings,
      syncState: this.syncState,
      pendingUpdates,
    });
  }

  private rebuildIndexesFromCanonicalMetadata(): void {
    if (!this.connection) {
      return;
    }

    this.syncState = {
      ...this.syncState,
      ...buildIndexesFromMetaFiles(this.connection.metaFiles),
    };
    this.scheduleSyncStatePersist();
  }
}
