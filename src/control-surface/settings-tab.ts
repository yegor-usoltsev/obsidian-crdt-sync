/**
 * Plugin settings tab: server URL, auth secret, debug logging,
 * and manual sync/repair actions.
 */

import { type App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type CrdtSyncPlugin from "../main";

export interface SyncSettings {
  serverUrl: string;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "",
  debugLogging: false,
};

/**
 * Validate a server URL for sync.
 * Remote: must be wss://
 * Loopback: ws:// allowed for 127.0.0.1, ::1, localhost
 */
export function validateServerUrl(url: string): string | null {
  if (!url) return "Server URL is required";
  if (url.length > 2048) return "URL too long (max 2048 characters)";

  try {
    const parsed = new URL(url);
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1";
    if (parsed.protocol === "wss:") return null;
    if (parsed.protocol === "ws:" && isLoopback) return null;
    if (parsed.protocol === "ws:") {
      return "Insecure ws:// only allowed for loopback addresses (localhost, 127.0.0.1, ::1)";
    }
    return "URL must use wss:// (or ws:// for loopback only)";
  } catch {
    return "Invalid URL format";
  }
}

/**
 * Validate an auth token.
 * Must be at least 32 characters.
 */
export function validateAuthToken(token: string): string | null {
  if (!token) return "Auth token is required";
  if (token.length < 32) return "Auth token must be at least 32 characters";
  if (token.length > 1024) return "Auth token too long (max 1024 characters)";
  return null;
}

export class CrdtSyncSettingTab extends PluginSettingTab {
  plugin: CrdtSyncPlugin;

  constructor(app: App, plugin: CrdtSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("WebSocket URL of your sync server (wss://...)")
      .addText((text) =>
        text
          .setPlaceholder("wss://your-server.example.com")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auth secret")
      .setDesc("Authentication token (stored in secure storage)")
      .addComponent((el) => {
        const secret = new SecretComponent(this.app, el);
        const token = this.plugin.loadAuthToken();
        if (token) secret.setValue(token);
        secret.onChange((value) => {
          this.plugin.saveAuthToken(value);
        });
        return secret;
      });

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Enable verbose debug logging to the developer console")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setHeading().setName("Actions");

    new Setting(containerEl)
      .setName("Run full sync")
      .setDesc("Manually trigger a full synchronization")
      .addButton((btn) =>
        btn.setButtonText("Sync now").onClick(() => {
          this.plugin.triggerFullSync();
        }),
      );

    new Setting(containerEl)
      .setName("Rebootstrap")
      .setDesc("Rebuild local sync state from the server (destructive)")
      .addButton((btn) =>
        btn
          .setButtonText("Rebootstrap")
          .setWarning()
          .onClick(() => {
            this.plugin.triggerRebootstrap();
          }),
      );
  }
}
