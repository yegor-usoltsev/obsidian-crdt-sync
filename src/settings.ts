import { type App, ButtonComponent, PluginSettingTab, Setting } from "obsidian";
import type CrdtSyncPlugin from "./main";

export const MIN_AUTH_TOKEN_LENGTH = 32;
export const MAX_AUTH_TOKEN_LENGTH = 1024;
export const MAX_SERVER_URL_LENGTH = 2048;

export interface CrdtSyncSettings {
  serverUrl: string;
  authToken: string;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: CrdtSyncSettings = {
  serverUrl: "",
  authToken: "",
  debugLogging: false,
};

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function validateServerUrl(url: string): string | null {
  if (!url) {
    return null;
  }

  if (url.length > MAX_SERVER_URL_LENGTH) {
    return `URL is too long (max ${MAX_SERVER_URL_LENGTH} characters).`;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      return "URL must use wss:// (or ws:// for localhost only).";
    }
    if (parsed.protocol === "ws:" && !isLoopbackUrl(url)) {
      return "Insecure ws:// is only allowed for localhost. Use wss:// for remote servers.";
    }
  } catch {
    return "Invalid URL format. Example: wss://sync.example.com";
  }

  return null;
}

export function validateAuthToken(token: string): string | null {
  if (!token) {
    return null;
  }

  if (token.length < MIN_AUTH_TOKEN_LENGTH) {
    return `Token is too short (min ${MIN_AUTH_TOKEN_LENGTH} characters).`;
  }

  if (token.length > MAX_AUTH_TOKEN_LENGTH) {
    return `Token is too long (max ${MAX_AUTH_TOKEN_LENGTH} characters).`;
  }

  return null;
}

export class CrdtSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: CrdtSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("crdt-sync-settings");

    const heroEl = containerEl.createDiv({ cls: "crdt-sync-settings-hero" });
    heroEl.createEl("h2", { text: "Real-Time CRDT Sync" });
    heroEl.createEl("p", {
      text: "Keep your notes, folders, and attachments aligned across devices through your own sync server.",
    });

    const statusCardEl = containerEl.createDiv({
      cls: "crdt-sync-settings-card",
    });
    const statusHeaderEl = statusCardEl.createDiv({
      cls: "crdt-sync-settings-card-header",
    });
    statusHeaderEl.createEl("span", {
      text: "Connection status",
      cls: "crdt-sync-settings-card-label",
    });
    const statusBadgeEl = statusHeaderEl.createEl("span", {
      cls: "crdt-sync-status-badge",
    });
    const statusDetailEl = statusCardEl.createEl("p", {
      cls: "crdt-sync-settings-card-detail",
    });
    statusCardEl.createEl("p", {
      cls: "crdt-sync-settings-card-meta",
      text: "Settings reconnect automatically after you save them.",
    });

    const actionsEl = statusCardEl.createDiv({
      cls: "crdt-sync-settings-actions",
    });
    const reconnectButton = new ButtonComponent(actionsEl)
      .setButtonText("Reconnect now")
      .onClick(() => {
        this.plugin.reconnectNow();
        renderStatusCard();
      });
    const fullSyncButton = new ButtonComponent(actionsEl)
      .setCta()
      .setButtonText("Run full sync")
      .onClick(async () => {
        await this.plugin.runManualFullSync();
        renderStatusCard();
      });

    const renderStatusCard = (): void => {
      const summary = this.plugin.getConnectionSummary();
      statusCardEl.dataset.crdtSyncTone = summary.tone;
      statusBadgeEl.setText(summary.label);
      statusDetailEl.setText(summary.detail);
      reconnectButton.setDisabled(!summary.canReconnect);
      fullSyncButton.setDisabled(!summary.canRunFullSync);
    };

    renderStatusCard();

    const urlSetting = new Setting(containerEl)
      .setName("Server URL")
      .setDesc(
        "WebSocket URL of the sync server (e.g. wss://sync.example.com). " +
          "Insecure ws:// is only allowed for localhost.",
      )
      .addText((text) =>
        text
          .setPlaceholder("wss://sync.example.com")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            const error = validateServerUrl(value);
            this.showFieldError(urlSetting, error);
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
            renderStatusCard();
          }),
      );
    this.showFieldError(
      urlSetting,
      validateServerUrl(this.plugin.settings.serverUrl),
    );

    const tokenSetting = new Setting(containerEl)
      .setName("Auth token")
      .setDesc(
        "Static authentication token for the sync server (stored securely). " +
          `Must be at least ${MIN_AUTH_TOKEN_LENGTH} characters.`,
      )
      .addText((text) => {
        text
          .setPlaceholder("Enter token")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            const error = validateAuthToken(value);
            this.showFieldError(tokenSetting, error);
            this.plugin.settings.authToken = value;
            await this.plugin.saveSettings();
            renderStatusCard();
          });
        text.inputEl.type = "password";
      });
    this.showFieldError(
      tokenSetting,
      validateAuthToken(this.plugin.settings.authToken),
    );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Log sync events to the developer console.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings(false);
            renderStatusCard();
          }),
      );
  }

  private showFieldError(setting: Setting, error: string | null): void {
    const existing = setting.settingEl.querySelector(".crdt-sync-field-error");
    if (existing) {
      existing.remove();
    }

    if (!error) {
      return;
    }

    const errorEl = setting.settingEl.createDiv({
      cls: "crdt-sync-field-error",
    });
    errorEl.setText(error);
  }
}
