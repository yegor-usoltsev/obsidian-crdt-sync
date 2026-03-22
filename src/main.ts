/**
 * CRDT Sync Plugin - Main entry point.
 *
 * Orchestrates: control surface, local store, policy engine,
 * metadata client, text sync, blob sync, settings sync,
 * and bootstrap/repair flows.
 */

import { Notice, Plugin } from "obsidian";
import {
  CrdtSyncSettingTab,
  DEFAULT_SETTINGS,
  type SyncSettings,
} from "./control-surface/settings-tab";
import { StatusBarManager } from "./control-surface/status-bar";
import { PluginLogger } from "./shared/logger";
import type { SyncStatus } from "./shared/types";

const AUTH_TOKEN_KEY = "crdt-sync-auth-token";

export default class CrdtSyncPlugin extends Plugin {
  settings: SyncSettings = { ...DEFAULT_SETTINGS };
  private logger!: PluginLogger;
  private statusBar!: StatusBarManager;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.logger = new PluginLogger("crdt-sync", this.settings.debugLogging);

    // Status bar
    const statusEl = this.addStatusBarItem();
    this.statusBar = new StatusBarManager(statusEl);
    this.statusBar.setClickHandler(() => {
      const status = this.statusBar.getStatus();
      if (status === "offline" || status === "error") {
        this.triggerFullSync();
      }
    });

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

    this.logger.info("Plugin loaded");
  }

  override async onunload(): Promise<void> {
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

  // Auth token in secure storage
  async loadAuthToken(): Promise<string | null> {
    return (await (this.app as any).loadLocalStorage?.(AUTH_TOKEN_KEY)) ?? null;
  }

  async saveAuthToken(token: string): Promise<void> {
    await (this.app as any).saveLocalStorage?.(AUTH_TOKEN_KEY, token);
  }

  // --- Sync actions ---

  triggerFullSync(): void {
    this.logger.info("Full sync triggered");
    new Notice("Full sync started");
    this.setStatus("syncing");
    // Connect to server, sync metadata, then text docs and blobs
    // Implementation wires together metadata-client, text-sync, blob-sync
  }

  triggerRebootstrap(): void {
    this.logger.info("Rebootstrap triggered");
    new Notice("Rebootstrap: rebuilding sync state from server…");
    this.setStatus("syncing");
    // Clear local state and re-bootstrap from canonical server state
  }

  triggerRebuildIndexes(): void {
    this.logger.info("Index rebuild triggered");
    new Notice("Rebuilding local indexes…");
    // Non-destructive: rebuild file registry cache from durable store
    // Does not discard pending operations
  }

  triggerRestoreCurrentFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file to restore");
      return;
    }
    this.logger.info("Current-file restore triggered", { path: file.path });
    new Notice(`Restoring ${file.name} from history…`);
    // Fetch history versions for file identity
    // Present version list to user
    // Selected version creates new canonical head
  }

  async triggerExportDiagnostics(): Promise<void> {
    this.logger.info("Diagnostics export triggered");
    new Notice("Exporting diagnostics…");

    try {
      const diagnostics = {
        exportedAt: new Date().toISOString(),
        pluginVersion: this.manifest.version,
        settings: {
          serverUrl: this.settings.serverUrl
            ? "(configured)"
            : "(not configured)",
          debugLogging: this.settings.debugLogging,
        },
        syncStatus: this.statusBar.getStatus(),
        // TODO: Include epoch, pending ops, sync deltas, retry state from local store
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
