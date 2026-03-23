/**
 * Vault watcher: listens to vault events, debounces, suppresses echoes,
 * and deduplicates directory rename/delete child operations.
 *
 * Uses plugin.registerEvent() for automatic cleanup on unload.
 * Defers event registration behind workspace.onLayoutReady() to skip
 * the startup create event flood.
 */

import type { Plugin, TAbstractFile, Vault, Workspace } from "obsidian";
import type { PluginLogger } from "../shared/logger";
import { DEBOUNCE } from "./bootstrap";
import { EchoPrevention } from "./echo-prevention";

export interface VaultWatcherDeps {
  logger: PluginLogger;
  onFileCreate(path: string): void;
  onFileModify(path: string): void;
  onFileDelete(path: string): void;
  onFileRename(oldPath: string, newPath: string): void;
}

export class VaultWatcher {
  private deps: VaultWatcherDeps;
  private echo = new EchoPrevention();
  private vault: Vault;
  private plugin: Plugin;
  private workspace: Workspace;

  // Debounce state
  private createTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private modifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Directory operation dedup: tracks paths covered by directory ops
  private recentDirOps = new Set<string>();
  private dirOpTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(plugin: Plugin, deps: VaultWatcherDeps) {
    this.plugin = plugin;
    this.vault = plugin.app.vault;
    this.workspace = plugin.app.workspace;
    this.deps = deps;
  }

  /** Get the echo prevention instance for marking remote writes. */
  getEchoPrevention(): EchoPrevention {
    return this.echo;
  }

  /** Start watching vault events (deferred behind onLayoutReady). */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.workspace.onLayoutReady(() => {
      this.registerEvents();
      this.deps.logger.debug("Vault watcher started (layout ready)");
    });
  }

  /** Stop watching vault events. */
  stop(): void {
    this.started = false;

    // Clear all timers
    for (const timer of this.createTimers.values()) clearTimeout(timer);
    for (const timer of this.modifyTimers.values()) clearTimeout(timer);
    this.createTimers.clear();
    this.modifyTimers.clear();
    if (this.dirOpTimer) clearTimeout(this.dirOpTimer);

    this.echo.clear();
    this.deps.logger.debug("Vault watcher stopped");
  }

  private registerEvents(): void {
    // Use plugin.registerEvent() for automatic cleanup on unload
    this.plugin.registerEvent(
      this.vault.on(
        "create",
        this.handleCreate as (...data: unknown[]) => unknown,
      ),
    );
    this.plugin.registerEvent(
      this.vault.on(
        "modify",
        this.handleModify as (...data: unknown[]) => unknown,
      ),
    );
    this.plugin.registerEvent(
      this.vault.on(
        "delete",
        this.handleDelete as (...data: unknown[]) => unknown,
      ),
    );
    this.plugin.registerEvent(
      this.vault.on(
        "rename",
        this.handleRename as (...data: unknown[]) => unknown,
      ),
    );
  }

  private handleCreate = (file: TAbstractFile): void => {
    if (!this.started) return;
    const path = file.path;
    if (this.echo.consumeWrite(path)) return;

    // Settle: wait for creation to stabilize
    const existing = this.createTimers.get(path);
    if (existing) clearTimeout(existing);

    this.createTimers.set(
      path,
      setTimeout(() => {
        this.createTimers.delete(path);
        this.deps.onFileCreate(path);
      }, DEBOUNCE.createSettle),
    );
  };

  private handleModify = (file: TAbstractFile): void => {
    if (!this.started) return;
    const path = file.path;
    if (this.echo.consumeWrite(path)) return;
    if (this.isChildOfRecentDirOp(path)) return;

    // Debounce: coalesce rapid modifications
    const existing = this.modifyTimers.get(path);
    if (existing) clearTimeout(existing);

    this.modifyTimers.set(
      path,
      setTimeout(() => {
        this.modifyTimers.delete(path);
        this.deps.onFileModify(path);
      }, DEBOUNCE.modifyDebounce),
    );
  };

  private handleDelete = (file: TAbstractFile): void => {
    if (!this.started) return;
    const path = file.path;
    if (this.echo.consumeDelete(path)) return;
    if (this.isChildOfRecentDirOp(path)) return;

    // If this is a directory, track it to suppress child events
    if ("children" in file) {
      this.trackDirOp(path);
    }

    this.deps.onFileDelete(path);
  };

  private handleRename = (file: TAbstractFile, oldPath: string): void => {
    if (!this.started) return;
    const newPath = file.path;
    if (this.echo.consumeRename(oldPath, newPath)) return;
    if (this.isChildOfRecentDirOp(oldPath)) return;

    // If this is a directory, track it to suppress child events
    if ("children" in file) {
      this.trackDirOp(oldPath);
    }

    this.deps.onFileRename(oldPath, newPath);
  };

  /** Track a directory operation to suppress duplicate child events. */
  private trackDirOp(dirPath: string): void {
    this.recentDirOps.add(dirPath);

    // Clear after a short window (events settle within a few hundred ms)
    if (this.dirOpTimer) clearTimeout(this.dirOpTimer);
    this.dirOpTimer = setTimeout(() => {
      this.recentDirOps.clear();
      this.dirOpTimer = null;
    }, 500);
  }

  /** Check if a path is a child of a recently processed directory operation. */
  private isChildOfRecentDirOp(path: string): boolean {
    for (const dirPath of this.recentDirOps) {
      if (path.startsWith(`${dirPath}/`)) return true;
    }
    return false;
  }
}
