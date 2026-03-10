export class StatusBarManager {
  constructor(private readonly el: HTMLElement) {
    this.setOffline();
  }

  setSynced(): void {
    this.el.setText("Sync: ok");
  }

  setSyncing(): void {
    this.el.setText("Sync: syncing");
  }

  setOffline(): void {
    this.el.setText("Sync: offline");
  }

  setError(msg: string): void {
    this.el.setText(`Sync: error — ${msg}`);
  }
}
