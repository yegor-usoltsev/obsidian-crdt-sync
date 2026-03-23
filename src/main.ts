/**
 * CRDT Sync Plugin - Main entry point.
 *
 * Orchestrates: control surface, local store, policy engine,
 * metadata client, text sync, blob sync, settings sync,
 * and bootstrap/repair flows.
 */

import {
  type App,
  Notice,
  normalizePath,
  Platform,
  Plugin,
  SuggestModal,
} from "obsidian";
import { BlobClient } from "./blob-sync/blob-client";
import { BootstrapManager } from "./bootstrap-repair/bootstrap";
import { VaultWatcher } from "./bootstrap-repair/vault-watcher";
import {
  CrdtSyncSettingTab,
  DEFAULT_SETTINGS,
  type SyncSettings,
} from "./control-surface/settings-tab";
import { StatusBarManager } from "./control-surface/status-bar";
import {
  createLocalSyncStore,
  type LocalSyncStore,
} from "./local-store/sync-store";
import {
  ControlChannel,
  type ControlChannelState,
} from "./metadata-client/control-channel";
import { MetadataClient } from "./metadata-client/metadata-client";
import {
  createFilePolicyEngine,
  type FilePolicyEngine,
} from "./policy-engine/file-policy";
import { PluginLogger } from "./shared/logger";
import type {
  EpochState,
  FileMetadata,
  MetadataCommit,
  MetadataReject,
  SyncStatus,
} from "./shared/types";
import { HocuspocusClient } from "./text-sync/hocuspocus-client";
import { TextDocManager } from "./text-sync/text-doc-manager";

const AUTH_SECRET_NAME = "crdt-sync-auth-token";

export default class CrdtSyncPlugin extends Plugin {
  settings: SyncSettings = { ...DEFAULT_SETTINGS };
  private logger!: PluginLogger;
  private statusBar: StatusBarManager | null = null;

  // Subsystems
  private localStore: LocalSyncStore | null = null;
  private policyEngine: FilePolicyEngine | null = null;
  private controlChannel: ControlChannel | null = null;
  private metadataClient: MetadataClient | null = null;
  private textDocManager: TextDocManager | null = null;
  private hocuspocusClient: HocuspocusClient | null = null;
  private blobClient: BlobClient | null = null;
  private bootstrapManager: BootstrapManager | null = null;
  private vaultWatcher: VaultWatcher | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.logger = new PluginLogger("crdt-sync", this.settings.debugLogging);

    // Status bar (desktop only)
    if (Platform.isDesktop) {
      const statusEl = this.addStatusBarItem();
      this.statusBar = new StatusBarManager(statusEl);
      this.statusBar.setClickHandler(() => {
        const status = this.statusBar?.getStatus();
        if (status === "offline" || status === "error") {
          this.triggerFullSync();
        }
      });
    }

    // Settings tab
    this.addSettingTab(new CrdtSyncSettingTab(this.app, this));

    // 1. Local sync store
    const vaultId = this.app.vault.getName() + "-crdt-sync";
    this.localStore = createLocalSyncStore(vaultId);
    await this.localStore.open();

    // Ensure clientId
    let clientId = await this.localStore.getClientId();
    if (!clientId) {
      clientId = crypto.randomUUID();
      await this.localStore.setClientId(clientId);
    }

    // 2. Policy engine
    this.policyEngine = createFilePolicyEngine();

    // 3. Wire server-connected modules if configured
    const authToken = this.loadAuthToken();
    const serverUrl = this.settings.serverUrl;

    if (serverUrl && authToken) {
      // Convert ws(s) URL to http(s) for REST endpoints
      const httpBaseUrl = serverUrl
        .replace(/^wss:/, "https:")
        .replace(/^ws:/, "http:");

      // Control channel client
      this.controlChannel = new ControlChannel({
        serverUrl,
        authToken,
        logger: this.logger,
        callbacks: {
          onCommit: (commit: MetadataCommit) => {
            this.metadataClient?.handleCommit(commit);
          },
          onReject: (reject: MetadataReject) => {
            this.metadataClient?.handleReject(reject);
          },
          onEpochChange: (epoch: EpochState) => {
            this.metadataClient?.handleEpochChange(epoch);
          },
          onStateChange: (state: ControlChannelState) => {
            if (state === "connected") {
              this.setStatus("synced");
            } else if (state === "reconnecting") {
              this.setStatus("syncing");
            } else if (state === "disconnected") {
              this.setStatus("offline");
            }
          },
        },
      });

      // Metadata client
      const store = this.localStore;
      const logger = this.logger;
      const channel = this.controlChannel;
      const finalClientId = clientId;
      this.metadataClient = new MetadataClient({
        sendIntent: (intent) => channel.send(intent),
        onCommit: async (commit) => {
          await store.putFile({
            fileId: commit.fileId,
            path: commit.path,
            kind: commit.kind,
            deleted: commit.deleted,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            contentAnchor: commit.contentAnchor,
          });
          await store.dequeuePending(commit.operationId);
          channel.setLastKnownRevision(commit.revision);
        },
        onReject: async (reject) => {
          logger.warn("Intent rejected", {
            operationId: reject.operationId,
            reason: reject.reason,
          });
          await store.dequeuePending(reject.operationId);
        },
        onEpochChange: async (epoch) => {
          await this.bootstrapManager?.rebootstrap(epoch);
        },
        generateOperationId: () => crypto.randomUUID(),
        getClientId: () => finalClientId,
        logger: this.logger,
      });

      // Restore pending intents from durable store
      const pendingIntents = await store.getAllPending();
      if (pendingIntents.length > 0) {
        this.metadataClient.restorePendingIntents(pendingIntents);
        this.logger.info("Restored pending intents", {
          count: pendingIntents.length,
        });
      }

      // Text doc manager
      this.textDocManager = new TextDocManager({ logger: this.logger });

      // Hocuspocus client (text doc sync)
      const docsWsUrl = serverUrl.replace(/\/$/, "");
      this.hocuspocusClient = new HocuspocusClient({
        wsUrl: `${docsWsUrl}/docs`,
        authToken,
        logger: this.logger,
        docManager: this.textDocManager,
      });

      // Blob client
      this.blobClient = new BlobClient({
        baseUrl: httpBaseUrl,
        authToken,
        logger: this.logger,
      });

      // Bootstrap manager
      this.bootstrapManager = new BootstrapManager({
        logger: this.logger,
        store: this.localStore,
        fetchCanonicalMetadata: async () => {
          if (!channel || channel.getState() !== "connected") {
            // Offline fallback: return local state
            const epochState = await store.getEpochState();
            const files = await store.getAllFiles();
            return { files, epoch: epochState ?? { epoch: "", revision: 0 } };
          }

          // Request server diagnostics for epoch info
          const diag = (await channel.requestResponse(
            { action: "diagnostics.request" },
            "diagnostics.response",
          )) as { epoch: string; revision: number } | undefined;

          const epoch: EpochState = diag
            ? { epoch: diag.epoch, revision: diag.revision }
            : { epoch: "", revision: 0 };

          // Subscribe from revision 0 to get all file metadata
          // The subscribe handler sends commits which populate the store
          // via the MetadataClient's onCommit callback
          const files = await store.getAllFiles();
          return { files, epoch };
        },
        setStatus: (status) => this.setStatus(status),
        confirmDestructive: async (message) => {
          new Notice(message);
          return true;
        },
      });

      // Vault watcher
      this.vaultWatcher = new VaultWatcher(this, {
        logger: this.logger,
        onFileCreate: (path) => {
          const normalized = normalizePath(path);
          const eligibility = this.policyEngine?.checkEligibility(normalized);
          if (!eligibility?.eligible) return;
          this.metadataClient?.create(normalized, eligibility.kind);
        },
        onFileModify: (path) => {
          const normalized = normalizePath(path);
          this.logger.debug("File modified", { path: normalized });
        },
        onFileDelete: (path) => {
          const normalized = normalizePath(path);
          this.logger.debug("File deleted", { path: normalized });
        },
        onFileRename: (oldPath, newPath) => {
          const normalizedNew = normalizePath(newPath);
          this.logger.debug("File renamed", {
            oldPath,
            newPath: normalizedNew,
          });
        },
      });

      // Start connection, run initial bootstrap, then start vault watcher
      this.controlChannel.connect();
      this.bootstrapManager
        .bootstrap()
        .then(() => {
          this.vaultWatcher?.start();
        })
        .catch((err) => {
          this.logger.error("Initial bootstrap failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          this.setStatus("error");
          // Start vault watcher anyway to capture local changes
          this.vaultWatcher?.start();
        });
    } else {
      // Offline mode: no server configured
      this.setStatus("offline");
      this.logger.info("No server configured, running in offline mode");
    }

    // Command palette actions
    this.addCommand({
      id: "full-sync",
      name: "Run full sync",
      callback: () => this.triggerFullSync(),
    });
    this.addCommand({
      id: "rebootstrap",
      name: "Rebootstrap sync state",
      callback: () => this.triggerRebootstrap(),
    });
    this.addCommand({
      id: "rebuild-indexes",
      name: "Rebuild local indexes",
      callback: () => this.triggerRebuildIndexes(),
    });
    this.addCommand({
      id: "restore-current-file",
      name: "Restore current file from history",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.triggerRestoreCurrentFile();
        return true;
      },
    });
    this.addCommand({
      id: "export-diagnostics",
      name: "Export sync diagnostics",
      callback: () => this.triggerExportDiagnostics(),
    });

    this.logger.info("Plugin loaded");
  }

  override async onunload(): Promise<void> {
    // Tear down in reverse order
    this.vaultWatcher?.stop();
    this.hocuspocusClient?.disconnectAll();
    this.controlChannel?.disconnect();
    this.textDocManager?.destroyAll();

    // Flush in-memory pending intents to IndexedDB before closing store
    if (this.metadataClient && this.localStore) {
      const pending = this.metadataClient.getPendingIntents();
      for (const intent of pending) {
        await this.localStore.enqueuePending(intent);
      }
    }

    this.localStore?.close();
    this.statusBar?.destroy();
    this.logger?.info("Plugin unloaded");
  }

  // Settings persistence
  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.logger?.setDebug(this.settings.debugLogging);
  }

  // Auth token in Obsidian secret storage
  loadAuthToken(): string | null {
    return this.app.secretStorage.getSecret(AUTH_SECRET_NAME) ?? null;
  }

  saveAuthToken(token: string): void {
    this.app.secretStorage.setSecret(AUTH_SECRET_NAME, token);
  }

  // --- Sync actions ---

  async triggerFullSync(): Promise<void> {
    if (!this.controlChannel || !this.metadataClient) {
      new Notice(
        "Server not configured. Set server URL and auth token in settings.",
      );
      return;
    }

    this.logger.info("Full sync triggered");
    new Notice("Full sync started");
    this.setStatus("syncing");

    try {
      // Connect if not already connected
      if (this.controlChannel.getState() !== "connected") {
        this.controlChannel.connect();
      }

      // Re-subscribe from last known revision to catch up on metadata
      this.controlChannel.sendRaw({
        action: "metadata.subscribe",
        sinceRevision: this.controlChannel.getLastKnownRevision(),
      });

      // Re-send any pending intents that may not have been acknowledged
      for (const intent of this.metadataClient.getPendingIntents()) {
        this.controlChannel.send(intent);
      }

      // Sync text docs for connected files
      const files = await this.localStore?.getAllFiles();
      if (files && this.hocuspocusClient) {
        for (const file of files) {
          if (!file.deleted && file.kind === "text") {
            if (!this.hocuspocusClient.isConnected(file.fileId)) {
              this.hocuspocusClient.connect(file.fileId);
            }
          }
        }
      }

      this.setStatus("synced");
      new Notice("Full sync complete");
    } catch (err) {
      this.logger.error("Full sync failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.setStatus("error");
      new Notice("Full sync failed");
    }
  }

  async triggerRebootstrap(): Promise<void> {
    if (!this.bootstrapManager) {
      new Notice("Server not configured.");
      return;
    }

    this.logger.info("Rebootstrap triggered");
    new Notice("Rebootstrap: rebuilding sync state from server…");

    const epochState = await this.localStore?.getEpochState();
    await this.bootstrapManager.rebootstrap(
      epochState ?? { epoch: "", revision: 0 },
    );
  }

  async triggerRebuildIndexes(): Promise<void> {
    if (!this.bootstrapManager) {
      new Notice("Server not configured.");
      return;
    }

    this.logger.info("Index rebuild triggered");
    new Notice("Rebuilding local indexes…");
    await this.bootstrapManager.rebuildIndexes();
  }

  async triggerRestoreCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file to restore");
      return;
    }

    if (
      !this.controlChannel ||
      this.controlChannel.getState() !== "connected"
    ) {
      new Notice("Not connected to server");
      return;
    }

    // Resolve fileId from local store by path
    const files = await this.localStore?.getAllFiles();
    const fileMeta = files?.find((f) => f.path === file.path && !f.deleted);
    if (!fileMeta) {
      new Notice("File not tracked by sync");
      return;
    }

    this.logger.info("Current-file restore triggered", {
      path: file.path,
      fileId: fileMeta.fileId,
    });
    new Notice(`Fetching history for ${file.name}…`);

    try {
      const entries = (await this.controlChannel.requestResponse(
        { action: "history.list", fileId: fileMeta.fileId },
        "history.list",
      )) as HistoryVersionEntry[];

      if (!entries || entries.length === 0) {
        new Notice("No history versions found");
        return;
      }

      // Present versions via SuggestModal
      const modal = new HistoryVersionModal(
        this.app,
        entries,
        async (entry) => {
          new Notice(
            `Restoring to version from ${new Date(entry.timestamp).toLocaleString()}…`,
          );
          try {
            await this.controlChannel!.requestResponse(
              {
                action: "history.restore",
                fileId: fileMeta.fileId,
                historyEntryId: entry.id,
              },
              "history.restored",
            );
            new Notice("File restored from history");
          } catch (err) {
            this.logger.error("History restore failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            new Notice("Restore failed");
          }
        },
      );
      modal.open();
    } catch (err) {
      this.logger.error("Failed to fetch history", {
        error: err instanceof Error ? err.message : String(err),
      });
      new Notice("Failed to fetch file history");
    }
  }

  async triggerExportDiagnostics(): Promise<void> {
    this.logger.info("Diagnostics export triggered");
    new Notice("Exporting diagnostics…");

    try {
      const bootstrapDiagnostics = this.bootstrapManager
        ? await this.bootstrapManager.exportDiagnostics()
        : {};

      // Compute sync deltas if connected
      let syncDeltas: Record<string, unknown> | undefined;
      if (this.controlChannel?.getState() === "connected") {
        try {
          const serverDiag = (await this.controlChannel.requestResponse(
            { action: "diagnostics.request" },
            "diagnostics.response",
            5000,
          )) as
            | { epoch: string; revision: number; activeFiles: number }
            | undefined;

          if (serverDiag) {
            const localFiles = (await this.localStore?.getAllFiles()) ?? [];
            const localActive = localFiles.filter((f) => !f.deleted).length;
            syncDeltas = {
              serverEpoch: serverDiag.epoch,
              serverRevision: serverDiag.revision,
              serverActiveFiles: serverDiag.activeFiles,
              localActiveFiles: localActive,
              fileDelta: localActive - serverDiag.activeFiles,
              revisionDelta:
                (this.controlChannel?.getLastKnownRevision() ?? 0) -
                serverDiag.revision,
            };
          }
        } catch {
          syncDeltas = { error: "Failed to fetch server diagnostics" };
        }
      }

      // Gather pending intent details with retry state
      const pendingDetails =
        this.metadataClient?.getPendingIntents().map((intent) => ({
          operationId: intent.operationId,
          type: intent.type,
          path: intent.path ?? intent.newPath,
          fileId: intent.fileId,
        })) ?? [];

      const diagnostics = {
        exportedAt: new Date().toISOString(),
        pluginVersion: this.manifest.version,
        settings: {
          serverUrl: this.settings.serverUrl
            ? "(configured)"
            : "(not configured)",
          debugLogging: this.settings.debugLogging,
        },
        syncStatus: this.statusBar?.getStatus() ?? "offline",
        controlChannelState: this.controlChannel?.getState() ?? "disconnected",
        lastKnownRevision: this.controlChannel?.getLastKnownRevision() ?? 0,
        pendingIntents: {
          count: pendingDetails.length,
          details: pendingDetails,
        },
        connectedTextDocs: this.hocuspocusClient?.getConnectedFileIds() ?? [],
        syncDeltas: syncDeltas ?? null,
        ...bootstrapDiagnostics,
      };

      const content = JSON.stringify(diagnostics, null, 2);
      const fileName = `sync-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

      await this.app.vault.create(fileName, content);
      new Notice(`Diagnostics exported to ${fileName}`);
    } catch (err) {
      this.logger.error("Diagnostics export failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      new Notice("Diagnostics export failed");
    }
  }

  setStatus(status: SyncStatus): void {
    this.statusBar?.update(status);
  }
}

interface HistoryVersionEntry {
  id: number;
  operationType: string;
  path: string;
  timestamp: number;
  revision: number;
  contentDigest: string | null;
}

class HistoryVersionModal extends SuggestModal<HistoryVersionEntry> {
  private entries: HistoryVersionEntry[];
  private onSelect: (entry: HistoryVersionEntry) => void;

  constructor(
    app: App,
    entries: HistoryVersionEntry[],
    onSelect: (entry: HistoryVersionEntry) => void,
  ) {
    super(app);
    this.entries = entries;
    this.onSelect = onSelect;
    this.setPlaceholder("Select a version to restore");
  }

  getSuggestions(query: string): HistoryVersionEntry[] {
    const lower = query.toLowerCase();
    if (!lower) return this.entries;
    return this.entries.filter(
      (e) =>
        new Date(e.timestamp).toLocaleString().toLowerCase().includes(lower) ||
        e.operationType.toLowerCase().includes(lower),
    );
  }

  renderSuggestion(entry: HistoryVersionEntry, el: HTMLElement): void {
    const date = new Date(entry.timestamp).toLocaleString();
    el.createEl("div", { text: `${entry.operationType} — ${date}` });
    el.createEl("small", {
      text: `rev ${entry.revision}${entry.contentDigest ? ` · ${entry.contentDigest.slice(0, 8)}…` : ""}`,
    });
  }

  onChooseSuggestion(entry: HistoryVersionEntry): void {
    this.onSelect(entry);
  }
}
