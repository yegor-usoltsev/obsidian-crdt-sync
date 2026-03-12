export class StatusBarManager {
  constructor(private readonly el: HTMLElement) {
    this.setOffline();
  }

  setSynced(): void {
    this.setText("CRDT Sync: connected", "Vault is synced and up to date");
  }

  setSyncing(): void {
    this.setText("CRDT Sync: syncing", "Synchronizing vault changes");
  }

  setOffline(): void {
    this.setText("CRDT Sync: offline", "Not connected to the sync server");
  }

  setError(msg: string): void {
    this.setText(`CRDT Sync: error`, `Sync error \u2014 ${msg}`);
  }

  private setText(text: string, tooltip: string): void {
    this.el.setText(text);
    this.el.ariaLabel = tooltip;
  }
}
