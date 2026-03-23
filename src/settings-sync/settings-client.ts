/**
 * HTTP client for settings snapshot upload/download.
 */

import type { PluginLogger } from "../shared/logger";

export interface SettingsClientConfig {
  baseUrl: string;
  authToken: string;
  logger: PluginLogger;
}

export class SettingsClient {
  private config: SettingsClientConfig;

  constructor(config: SettingsClientConfig) {
    this.config = config;
  }

  async upload(
    configPath: string,
    content: string,
    digest: string,
  ): Promise<void> {
    const url = `${this.config.baseUrl}/settings/${encodeURIComponent(configPath)}`;
    const body = new TextEncoder().encode(content);

    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.config.authToken}`,
        "X-Content-Digest": digest,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
      },
      body,
    });

    if (!resp.ok) {
      throw new Error(
        `Settings upload failed: ${resp.status} ${resp.statusText}`,
      );
    }
  }

  async download(configPath: string): Promise<{
    content: string;
    digest: string;
    contentAnchor: number;
  } | null> {
    const url = `${this.config.baseUrl}/settings/${encodeURIComponent(configPath)}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.authToken}`,
      },
    });

    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(
        `Settings download failed: ${resp.status} ${resp.statusText}`,
      );
    }

    const content = await resp.text();
    const digest = resp.headers.get("X-Content-Digest") ?? "";
    const contentAnchor = Number(resp.headers.get("X-Content-Anchor") ?? "0");

    return { content, digest, contentAnchor };
  }
}
