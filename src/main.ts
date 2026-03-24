/**
 * CRDT Sync Plugin - Main entry point.
 *
 * Orchestrates: control surface, local store, policy engine,
 * metadata client, text sync, blob sync, settings sync,
 * and bootstrap/repair flows.
 */

import {
  type App,
  Modal,
  Notice,
  normalizePath,
  Platform,
  Plugin,
  Setting,
  SuggestModal,
  TFile,
} from "obsidian";
import * as Y from "yjs";
import { BlobClient, computeDigest } from "./blob-sync/blob-client";
import { BootstrapManager } from "./bootstrap-repair/bootstrap";
import { VaultWatcher } from "./bootstrap-repair/vault-watcher";
import {
  CrdtSyncSettingTab,
  DEFAULT_SETTINGS,
  type SyncSettings,
  validateAuthToken,
  validateServerUrl,
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
import { rescanConfigDirectory } from "./settings-sync/config-rescan";
import { SettingsClient } from "./settings-sync/settings-client";
import {
  applyMergePolicy,
  isAllowlistedSettingsFile,
} from "./settings-sync/settings-policy";
import { PluginLogger } from "./shared/logger";
import {
  conflictArtifactName,
  type EpochState,
  type MetadataCommit,
  type MetadataReject,
  type SyncStatus,
} from "./shared/types";
import { importTextViaDiff } from "./text-sync/diff-bridge";
import { HocuspocusClient } from "./text-sync/hocuspocus-client";
import { safeWriteTextContent } from "./text-sync/overwrite-guard";
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
  private settingsClient: SettingsClient | null = null;
  private bootstrapManager: BootstrapManager | null = null;
  private vaultWatcher: VaultWatcher | null = null;
  private startupPromise: Promise<void> | null = null;

  // Commit processing queue for serialized materialization
  private commitQueue: Promise<void> = Promise.resolve();

  private enqueueCommit(fn: () => Promise<void>): void {
    this.commitQueue = this.commitQueue.then(fn).catch((err) => {
      this.logger.error("Commit materialization failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

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

    this.app.workspace.onLayoutReady(() => {
      if (this.startupPromise) return;
      this.startupPromise = this.initializeRuntime().catch((err) => {
        this.logger.error("Runtime startup failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.setStatus("error");
      });
    });

    this.logger.info("Plugin loaded");
  }

  private async initializeRuntime(): Promise<void> {
    const vaultId = `${this.app.vault.getName()}-crdt-sync`;
    this.localStore = createLocalSyncStore(vaultId);
    await this.localStore.open();

    let vaultMismatch = false;
    const storedVaultId = await this.localStore.getVaultId();
    if (storedVaultId && storedVaultId !== vaultId) {
      this.logger.warn(
        "Vault identity mismatch — previous vault used this store",
        {
          stored: storedVaultId,
          current: vaultId,
        },
      );
      vaultMismatch = true;
    } else if (!storedVaultId) {
      await this.localStore.setVaultId(vaultId);
    }

    let clientId = await this.localStore.getClientId();
    if (!clientId) {
      clientId = crypto.randomUUID();
      await this.localStore.setClientId(clientId);
    }

    this.policyEngine = createFilePolicyEngine(this.app.vault.configDir);

    const authToken = this.loadAuthToken();
    const serverUrl = this.settings.serverUrl;
    const serverUrlError = serverUrl ? validateServerUrl(serverUrl) : null;
    const authTokenError = authToken ? validateAuthToken(authToken) : null;

    if (serverUrlError) {
      this.logger.warn("Invalid server URL, running offline", {
        error: serverUrlError,
      });
    }
    if (authTokenError) {
      this.logger.warn("Invalid auth token, running offline", {
        error: authTokenError,
      });
    }

    if (!serverUrl || !authToken || serverUrlError || authTokenError) {
      this.setStatus("offline");
      this.logger.info("No server configured, running in offline mode");
      return;
    }

    const httpBaseUrl = serverUrl
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:");

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

    const store = this.localStore;
    const logger = this.logger;
    const channel = this.controlChannel;
    const finalClientId = clientId;
    this.metadataClient = new MetadataClient({
      sendIntent: (intent) => channel.send(intent),
      onCommit: async (commit, wasPending) => {
        const previousFile = !wasPending
          ? await store.getFile(commit.fileId)
          : undefined;

        await store.putFile({
          fileId: commit.fileId,
          path: commit.path,
          kind: commit.kind,
          deleted: commit.deleted,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          contentAnchor: commit.contentAnchor,
          contentDigest: commit.contentDigest,
          contentSize: commit.contentSize,
        });
        await store.dequeuePending(commit.operationId);
        channel.setLastKnownRevision(commit.revision);

        if (!wasPending) {
          const prevPath = previousFile?.path;
          const prevDigest = previousFile?.contentDigest;
          this.enqueueCommit(() =>
            this.materializeCommit(commit, prevPath, prevDigest),
          );
        }
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

    const pendingIntents = await store.getAllPending();
    if (pendingIntents.length > 0) {
      this.metadataClient.restorePendingIntents(pendingIntents);
      this.logger.info("Restored pending intents", {
        count: pendingIntents.length,
      });
    }

    this.textDocManager = new TextDocManager({ logger: this.logger });

    const offlineProgress = await store.getAllOfflineProgress();
    for (const { fileId, data } of offlineProgress) {
      try {
        const entry = this.textDocManager.getOrCreate(fileId);
        Y.applyUpdate(entry.doc, data);
        this.logger.debug("Restored offline text progress", { fileId });
      } catch (err) {
        this.logger.error("Failed to restore offline text progress", {
          fileId,
          error: err instanceof Error ? err.message : String(err),
        });
        await store.deleteOfflineProgress(fileId);
      }
    }
    if (offlineProgress.length > 0) {
      this.logger.info("Restored offline text progress", {
        count: offlineProgress.length,
      });
    }

    const docsWsUrl = serverUrl.replace(/\/$/, "");
    this.hocuspocusClient = new HocuspocusClient({
      wsUrl: `${docsWsUrl}/docs`,
      authToken,
      logger: this.logger,
      docManager: this.textDocManager,
      onSynced: (fileId) => {
        this.localStore?.deleteOfflineProgress(fileId);
      },
      onRemoteTextUpdate: async (fileId, text) => {
        const fileMeta = await this.localStore?.getFile(fileId);
        if (!fileMeta || fileMeta.deleted) return;

        const echo = this.vaultWatcher?.getEchoPrevention();
        echo?.markWritten(fileMeta.path);
        const existing = this.app.vault.getAbstractFileByPath(fileMeta.path);
        if (existing instanceof TFile) {
          const written = await safeWriteTextContent(
            { vault: this.app.vault },
            existing,
            existing.stat.mtime,
            text,
          );
          if (!written) {
            const artifactPath = conflictArtifactName(
              fileMeta.path,
              Date.now(),
              "local",
            );
            try {
              await this.app.vault.create(artifactPath, text);
            } catch {
              // ignore
            }
          }
        } else if (!existing) {
          await this.ensureParentDirs(fileMeta.path);
          echo?.markWritten(fileMeta.path);
          try {
            await this.app.vault.create(fileMeta.path, text);
          } catch {
            // File may already exist
          }
        }
      },
    });

    this.blobClient = new BlobClient({
      baseUrl: httpBaseUrl,
      authToken,
      logger: this.logger,
    });

    this.settingsClient = new SettingsClient({
      baseUrl: httpBaseUrl,
      authToken,
      logger: this.logger,
    });

    this.bootstrapManager = new BootstrapManager({
      logger: this.logger,
      store: this.localStore,
      fetchCanonicalMetadata: async () => {
        if (channel.getState() !== "connected") {
          const epochState = await store.getEpochState();
          const files = await store.getAllFiles();
          return { files, epoch: epochState ?? { epoch: "", revision: 0 } };
        }

        const diag = (await channel.requestResponse(
          { action: "diagnostics.request" },
          "diagnostics.response",
        )) as { epoch: string; revision: number } | undefined;

        const epoch: EpochState = diag
          ? { epoch: diag.epoch, revision: diag.revision }
          : { epoch: "", revision: 0 };

        const requestId = crypto.randomUUID();
        const replayPromise = channel.awaitReplayComplete(requestId);
        channel.sendRaw({
          action: "metadata.subscribe",
          sinceRevision: 0,
          requestId,
        });

        await replayPromise;

        const files = await store.getAllFiles();
        return { files, epoch };
      },
      setStatus: (status) => this.setStatus(status),
      confirmDestructive: (message) =>
        new Promise<boolean>((resolve) => {
          const modal = new ConfirmModal(this.app, message, resolve);
          modal.open();
        }),
    });

    this.vaultWatcher = new VaultWatcher(this, {
      logger: this.logger,
      onFileCreate: (path, isDirectory) => {
        const normalized = normalizePath(path);
        if (isDirectory) {
          this.metadataClient?.create(normalized, "directory");
          return;
        }
        const eligibility = this.policyEngine?.checkEligibility(normalized);
        if (!eligibility?.eligible) return;
        this.metadataClient?.create(normalized, eligibility.kind);
      },
      onFileModify: async (path) => {
        const normalized = normalizePath(path);
        this.logger.debug("File modified", { path: normalized });

        const fileMeta = await this.localStore?.getFileByPath(normalized);
        if (!fileMeta) return;

        const cfgDir = this.app.vault.configDir;
        if (normalized.startsWith(`${cfgDir}/`) && this.settingsClient) {
          const configRelativePath = normalized.slice(cfgDir.length + 1);
          const policy = isAllowlistedSettingsFile(configRelativePath);
          if (policy) {
            const vaultFile = this.app.vault.getAbstractFileByPath(normalized);
            if (vaultFile instanceof TFile) {
              const content = await this.app.vault.read(vaultFile);
              const contentBytes = new TextEncoder().encode(content);
              const digest = await computeDigest(contentBytes);
              try {
                await this.settingsClient.upload(
                  configRelativePath,
                  content,
                  digest,
                );
              } catch (err) {
                this.logger.error("Settings upload failed", {
                  path: normalized,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            return;
          }
        }

        if (fileMeta.kind === "text") {
          const vaultFile = this.app.vault.getAbstractFileByPath(normalized);
          if (vaultFile instanceof TFile) {
            const content = await this.app.vault.read(vaultFile);
            const entry = this.textDocManager?.get(fileMeta.fileId);
            if (entry) {
              importTextViaDiff(entry.text, content);
            } else {
              this.textDocManager?.importText(fileMeta.fileId, content);
            }

            if (this.controlChannel?.getState() !== "connected") {
              const docEntry = this.textDocManager?.get(fileMeta.fileId);
              if (docEntry) {
                const update = Y.encodeStateAsUpdate(docEntry.doc);
                await this.localStore?.saveOfflineProgress(
                  fileMeta.fileId,
                  update,
                );
              }
            }
          }
        } else if (fileMeta.kind === "binary" && this.blobClient) {
          const vaultFile = this.app.vault.getAbstractFileByPath(normalized);
          if (vaultFile instanceof TFile) {
            const content = await this.app.vault.readBinary(vaultFile);
            const digest = await computeDigest(content);
            try {
              await this.blobClient.upload(fileMeta.fileId, content, digest);
            } catch (err) {
              this.logger.error("Blob upload failed", {
                path: normalized,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      },
      onFileDelete: async (path) => {
        const normalized = normalizePath(path);
        this.logger.debug("File deleted", { path: normalized });

        const fileMeta = await this.localStore?.getFileByPath(normalized);
        if (!fileMeta) return;

        this.metadataClient?.delete(
          fileMeta.fileId,
          fileMeta.contentAnchor,
          fileMeta.contentDigest,
        );
      },
      onFileRename: async (oldPath, newPath) => {
        const normalizedNew = normalizePath(newPath);
        this.logger.debug("File renamed", {
          oldPath,
          newPath: normalizedNew,
        });

        const fileMeta = await this.localStore?.getFileByPath(oldPath);
        if (!fileMeta) return;

        this.metadataClient?.rename(
          fileMeta.fileId,
          normalizedNew,
          fileMeta.contentAnchor,
        );
      },
    });

    this.controlChannel.connect();

    if (vaultMismatch) {
      await this.localStore.setVaultId(vaultId);
    }

    const bootstrapManager = this.bootstrapManager;
    if (!bootstrapManager) {
      this.setStatus("error");
      this.logger.error("Bootstrap manager was not initialized");
      return;
    }

    const bootstrapFn = vaultMismatch
      ? () =>
          bootstrapManager.rebootstrap({
            epoch: "vault-identity-mismatch",
            revision: 0,
          })
      : () => bootstrapManager.bootstrap();

    bootstrapFn()
      .then(async () => {
        await this.reconcileSettings();
        this.vaultWatcher?.start();
      })
      .catch((err) => {
        this.logger.error("Initial bootstrap failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.setStatus("error");
        this.vaultWatcher?.start();
      });
  }

  override async onunload(): Promise<void> {
    // Tear down in reverse order
    this.vaultWatcher?.stop();
    this.vaultWatcher?.getEchoPrevention().clear();
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
      // Connect and wait for connected state before sending messages
      if (this.controlChannel.getState() !== "connected") {
        this.controlChannel.connect();
        await this.controlChannel.waitForConnected();
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

      // Sync content for tracked files
      const files = await this.localStore?.getAllFiles();
      if (files) {
        for (const file of files) {
          if (file.deleted) continue;

          if (file.kind === "text" && this.hocuspocusClient) {
            if (!this.hocuspocusClient.isConnected(file.fileId)) {
              this.hocuspocusClient.connect(file.fileId);
            }
          } else if (file.kind === "binary" && this.blobClient) {
            // Download blobs that exist on server but not locally
            const vaultFile = this.app.vault.getAbstractFileByPath(file.path);
            if (!vaultFile) {
              try {
                const content = await this.blobClient.download(file.fileId);
                const echo = this.vaultWatcher?.getEchoPrevention();
                echo?.markWritten(file.path);
                await this.app.vault.createBinary(file.path, content);
              } catch (err) {
                this.logger.error("Blob download failed during sync", {
                  fileId: file.fileId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }
      }

      // Reconcile settings files
      await this.reconcileSettings();

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
    const fileMeta = await this.localStore?.getFileByPath(file.path);
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
          const channel = this.controlChannel;
          if (!channel) {
            new Notice("Not connected to server");
            return;
          }
          new Notice(
            `Restoring to version from ${new Date(entry.timestamp).toLocaleString()}…`,
          );
          try {
            await channel.requestResponse(
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

  /** Wait for a text doc entry to sync, with timeout. */
  private waitForSync(
    entry: { synced: boolean },
    timeoutMs = 30_000,
  ): Promise<void> {
    if (entry.synced) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Sync timeout")),
        timeoutMs,
      );
      const checkSync = () => {
        if (entry.synced) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkSync, 100);
        }
      };
      checkSync();
    });
  }

  /** Ensure all parent directories exist for a file path. */
  private async ensureParentDirs(path: string): Promise<void> {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dirPath = segments.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(dirPath)) {
        try {
          await this.app.vault.createFolder(dirPath);
        } catch {
          // Folder may already exist
        }
      }
    }
  }

  /** Materialize a remote commit into the vault. */
  private async materializeCommit(
    commit: MetadataCommit,
    previousPath?: string,
    previousDigest?: string,
  ): Promise<void> {
    const echo = this.vaultWatcher?.getEchoPrevention();
    const vault = this.app.vault;

    // Settings transport precedence: allowlisted config files use settings client
    const cfgDir = this.app.vault.configDir;
    if (commit.path.startsWith(`${cfgDir}/`) && this.settingsClient) {
      const configRelativePath = commit.path.slice(cfgDir.length + 1);
      const policy = isAllowlistedSettingsFile(configRelativePath);
      if (policy) {
        try {
          const serverResult =
            await this.settingsClient.download(configRelativePath);
          if (!serverResult) return;

          let mergedContent = serverResult.content;
          const existingFile = vault.getAbstractFileByPath(commit.path);
          if (existingFile instanceof TFile) {
            const localContent = await vault.read(existingFile);
            try {
              const localJson = JSON.parse(localContent);
              const remoteJson = JSON.parse(serverResult.content);
              mergedContent = JSON.stringify(
                applyMergePolicy(policy.policy, localJson, remoteJson),
                null,
                2,
              );
            } catch {
              mergedContent = serverResult.content;
            }
          }

          await this.ensureParentDirs(commit.path);
          echo?.markWritten(commit.path);
          if (existingFile instanceof TFile) {
            await vault.process(existingFile, () => mergedContent);
          } else {
            await vault.create(commit.path, mergedContent);
          }
        } catch (err) {
          this.logger.error("Settings materialization failed", {
            path: commit.path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
    }

    switch (commit.operationType) {
      case "create": {
        if (commit.kind === "directory") {
          echo?.markWritten(commit.path);
          try {
            await vault.createFolder(normalizePath(commit.path));
          } catch {
            // Folder may already exist
          }
          return;
        }

        if (commit.kind === "text") {
          // Connect Hocuspocus, wait for sync, extract text
          if (this.hocuspocusClient && this.textDocManager) {
            try {
              const entry = this.textDocManager.getOrCreate(commit.fileId);
              if (!this.hocuspocusClient.isConnected(commit.fileId)) {
                this.hocuspocusClient.connect(commit.fileId);
              }

              await this.waitForSync(entry);

              const text = entry.text.toString();
              await this.ensureParentDirs(commit.path);
              echo?.markWritten(commit.path);
              await vault.create(commit.path, text);
            } catch (err) {
              this.logger.error("Text create materialization failed", {
                path: commit.path,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          return;
        }

        if (commit.kind === "binary" && this.blobClient) {
          try {
            const content = await this.blobClient.download(commit.fileId);
            await this.ensureParentDirs(commit.path);
            echo?.markWritten(commit.path);
            await vault.createBinary(commit.path, content);
          } catch (err) {
            this.logger.error("Binary create materialization failed", {
              path: commit.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
        break;
      }

      case "rename":
      case "move": {
        // Use pre-commit path captured before store.putFile()
        const oldPath = previousPath;
        if (oldPath && oldPath !== commit.path) {
          const existing = vault.getAbstractFileByPath(oldPath);
          if (existing) {
            try {
              await this.ensureParentDirs(commit.path);
              echo?.markRenamed(oldPath, commit.path);
              await vault.rename(existing, commit.path);
            } catch (err) {
              this.logger.error("Rename materialization failed", {
                oldPath,
                newPath: commit.path,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        break;
      }

      case "delete": {
        const file = vault.getAbstractFileByPath(commit.path);
        if (file) {
          try {
            echo?.markDeleted(commit.path);
            await vault.delete(file);
          } catch (err) {
            this.logger.error("Delete materialization failed", {
              path: commit.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        break;
      }

      case "content-update": {
        // Text content-updates are no-ops — text flows through Y.Doc sync
        if (commit.kind === "text") return;

        if (commit.kind === "binary" && this.blobClient) {
          // Compare pre-commit digest to avoid re-downloading self-originated updates
          if (previousDigest === commit.contentDigest) return;

          const existing = vault.getAbstractFileByPath(commit.path);
          if (existing instanceof TFile) {
            try {
              const content = await this.blobClient.download(commit.fileId);
              echo?.markWritten(commit.path);
              await vault.modifyBinary(existing, content);
            } catch (err) {
              this.logger.error("Binary content-update failed", {
                path: commit.path,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          return;
        }
        break;
      }

      case "restore": {
        if (
          commit.kind === "text" &&
          this.hocuspocusClient &&
          this.textDocManager
        ) {
          // Connect and sync — server Y.Doc has restored content
          try {
            const entry = this.textDocManager.getOrCreate(commit.fileId);
            if (!this.hocuspocusClient.isConnected(commit.fileId)) {
              this.hocuspocusClient.connect(commit.fileId);
            }

            await this.waitForSync(entry);

            const text = entry.text.toString();
            await this.ensureParentDirs(commit.path);
            echo?.markWritten(commit.path);
            const existingFile = vault.getAbstractFileByPath(commit.path);
            if (existingFile instanceof TFile) {
              await vault.process(existingFile, () => text);
            } else {
              await vault.create(commit.path, text);
            }
          } catch (err) {
            this.logger.error("Text restore materialization failed", {
              path: commit.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (commit.kind === "binary" && this.blobClient) {
          try {
            const content = await this.blobClient.download(commit.fileId);
            await this.ensureParentDirs(commit.path);
            echo?.markWritten(commit.path);
            const existing = vault.getAbstractFileByPath(commit.path);
            if (existing instanceof TFile) {
              await vault.modifyBinary(existing, content);
            } else {
              await vault.createBinary(commit.path, content);
            }
          } catch (err) {
            this.logger.error("Binary restore materialization failed", {
              path: commit.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }
        break;
      }
    }
  }

  /** Reconcile allowlisted settings files with the server. */
  private async reconcileSettings(): Promise<void> {
    if (!this.settingsClient || !this.localStore) return;
    const localStore = this.localStore;

    try {
      const { files } = rescanConfigDirectory(
        this.app.vault,
        this.app.vault.configDir,
      );
      for (const { file, configRelativePath, policy } of files) {
        try {
          const serverResult =
            await this.settingsClient.download(configRelativePath);
          if (!serverResult) {
            // Server doesn't have it — upload local
            const content = await this.app.vault.read(file);
            const contentBytes = new TextEncoder().encode(content);
            const digest = await computeDigest(contentBytes);
            await this.settingsClient.upload(
              configRelativePath,
              content,
              digest,
            );
            continue;
          }

          // Compare anchors and digests to determine direction
          const localContent = await this.app.vault.read(file);
          const localBytes = new TextEncoder().encode(localContent);
          const localDigest = await computeDigest(localBytes);

          if (localDigest === serverResult.digest) continue; // In sync

          // Look up locally tracked anchor for this settings file
          const tracked = await localStore.getFileByPath(file.path);
          const localAnchor = tracked?.contentAnchor ?? 0;
          const serverAnchor = serverResult.contentAnchor ?? 0;

          if (serverAnchor > localAnchor) {
            // Server is newer — download, merge, and write locally
            let mergedContent = serverResult.content;
            try {
              const localJson = JSON.parse(localContent);
              const remoteJson = JSON.parse(serverResult.content);
              mergedContent = JSON.stringify(
                applyMergePolicy(policy.policy, localJson, remoteJson),
                null,
                2,
              );
            } catch {
              mergedContent = serverResult.content;
            }

            const echo = this.vaultWatcher?.getEchoPrevention();
            echo?.markWritten(file.path);
            await this.app.vault.process(file, () => mergedContent);

            // Upload the merged result if different from server
            const mergedBytes = new TextEncoder().encode(mergedContent);
            const mergedDigest = await computeDigest(mergedBytes);
            if (mergedDigest !== serverResult.digest) {
              await this.settingsClient.upload(
                configRelativePath,
                mergedContent,
                mergedDigest,
              );
            }
          } else if (localAnchor > serverAnchor) {
            // Local is newer — upload local content
            await this.settingsClient.upload(
              configRelativePath,
              localContent,
              localDigest,
            );
          } else {
            // Same anchor but different digests — merge both directions
            let mergedContent = serverResult.content;
            try {
              const localJson = JSON.parse(localContent);
              const remoteJson = JSON.parse(serverResult.content);
              mergedContent = JSON.stringify(
                applyMergePolicy(policy.policy, localJson, remoteJson),
                null,
                2,
              );
            } catch {
              mergedContent = serverResult.content;
            }

            const echo = this.vaultWatcher?.getEchoPrevention();
            echo?.markWritten(file.path);
            await this.app.vault.process(file, () => mergedContent);

            const mergedBytes = new TextEncoder().encode(mergedContent);
            const mergedDigest = await computeDigest(mergedBytes);
            if (mergedDigest !== serverResult.digest) {
              await this.settingsClient.upload(
                configRelativePath,
                mergedContent,
                mergedDigest,
              );
            }
          }
        } catch (err) {
          this.logger.error("Settings reconciliation failed for file", {
            path: file.path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      this.logger.error("Settings reconciliation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
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

class ConfirmModal extends Modal {
  private message: string;
  private resolve: (confirmed: boolean) => void;
  private resolved = false;

  constructor(
    app: App,
    message: string,
    resolve: (confirmed: boolean) => void,
  ) {
    super(app);
    this.message = message;
    this.resolve = resolve;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Continue")
          .setWarning()
          .onClick(() => {
            this.resolved = true;
            this.resolve(true);
            this.close();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.resolved = true;
          this.resolve(false);
          this.close();
        }),
      );
  }

  override onClose(): void {
    if (!this.resolved) {
      this.resolve(false);
    }
  }
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
