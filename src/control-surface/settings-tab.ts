/**
 * Plugin settings tab: server URL, auth secret, debug logging,
 * and manual sync/repair actions.
 */

import {
  type App,
  Notice,
  PluginSettingTab,
  SecretComponent,
  Setting,
} from "obsidian";
import type CrdtSyncPlugin from "../main";
import { validateAuthToken, validateServerUrl } from "../shared/validation";

export { validateAuthToken, validateServerUrl };

export interface SyncSettings {
  serverUrl: string;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "",
  debugLogging: false,
};

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
            if (value) {
              const error = validateServerUrl(value);
              if (error) {
                new Notice(error);
                return;
              }
            }
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Authentication token stored in Obsidian secret storage.")
      .addComponent((el) => {
        const secret = new SecretComponent(this.app, el);
        const token = this.plugin.loadAuthToken();
        if (token) secret.setValue(token);
        secret.onChange((value) => {
          if (value) {
            const error = validateAuthToken(value);
            if (error) {
              new Notice(error);
              return;
            }
          }
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
