export type StatusTone = "synced" | "syncing" | "offline" | "error";

export interface StatusSnapshot {
  detail: string;
  text: string;
  tone: StatusTone;
}

export class StatusBarManager {
  private snapshot: StatusSnapshot = {
    text: "CRDT Sync: offline",
    detail: "Not connected to the sync server.",
    tone: "offline",
  };

  constructor(private readonly el: HTMLElement) {
    el.addClass("mod-clickable", "crdt-sync-status");
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    this.setOffline();
  }

  setSynced(): void {
    this.setState(
      "CRDT Sync: connected",
      "Vault is synced and up to date.",
      "synced",
    );
  }

  setSyncing(): void {
    this.setState(
      "CRDT Sync: syncing",
      "Synchronizing vault changes.",
      "syncing",
    );
  }

  setOffline(): void {
    this.setState(
      "CRDT Sync: offline",
      "Not connected to the sync server.",
      "offline",
    );
  }

  setError(msg: string): void {
    this.setState("CRDT Sync: error", `Sync error: ${msg}.`, "error");
  }

  getSnapshot(): StatusSnapshot {
    return this.snapshot;
  }

  private setState(text: string, detail: string, tone: StatusTone): void {
    this.snapshot = { text, detail, tone };
    this.el.setText(text);
    this.el.ariaLabel = `${detail} Click to run a full sync.`;
    this.el.setAttribute("title", `${detail} Click to run a full sync.`);
    this.el.dataset.crdtSyncTone = tone;
  }
}
