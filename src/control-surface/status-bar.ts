/**
 * Status bar surface: offline, syncing, synced, error states.
 */

import type { SyncStatus } from "../shared/types";

const STATUS_LABELS: Record<SyncStatus, string> = {
  offline: "Sync: Offline",
  syncing: "Sync: Syncing…",
  synced: "Sync: Up to date",
  error: "Sync: Error",
};

const STATUS_DESCRIPTIONS: Record<SyncStatus, string> = {
  offline: "Sync is offline. Click to reconnect.",
  syncing: "Sync is in progress.",
  synced: "All files are up to date.",
  error: "Sync encountered an error. Click for details.",
};

export class StatusBarManager {
  private el: HTMLElement;
  private status: SyncStatus = "offline";
  private onClick: (() => void) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    this.el.addClass("crdt-sync-status");
    this.el.setAttribute("role", "status");
    this.el.tabIndex = 0;
    this.el.addEventListener("click", () => this.onClick?.());
    this.el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.onClick?.();
      }
    });
    this.update("offline");
  }

  update(status: SyncStatus): void {
    this.status = status;
    this.el.setText(STATUS_LABELS[status]);
    this.el.setAttribute("aria-label", STATUS_DESCRIPTIONS[status]);
    this.el.dataset.syncStatus = status;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  setClickHandler(handler: () => void): void {
    this.onClick = handler;
  }

  destroy(): void {
    this.onClick = null;
  }
}
