import { type App, PluginSettingTab, Setting } from "obsidian";
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

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc(
        "WebSocket URL of the sync server (e.g. wss://sync.example.com). " +
          "Use ws:// for localhost only.",
      )
      .addText((text) =>
        text
          .setPlaceholder("wss://sync.example.com")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc(
        "Shared secret matching AUTH_TOKEN on the server. " +
          `Must be at least ${MIN_AUTH_TOKEN_LENGTH} characters. Stored securely.`,
      )
      .addText((text) => {
        text
          .setPlaceholder("Enter token")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Log sync events to the developer console.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings(false);
          }),
      );

    const fullSyncSetting = new Setting(containerEl)
      .setName("Full sync")
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("Run")
          .onClick(async () => {
            await this.plugin.runManualFullSync();
            updateStatus();
          }),
      );

    const updateStatus = (): void => {
      const snapshot = this.plugin.statusBar.getSnapshot();
      fullSyncSetting.setDesc(snapshot.detail);
    };

    updateStatus();
  }
}
