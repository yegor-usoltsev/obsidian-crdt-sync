/**
 * HTTP client for settings snapshot upload/download.
 */

import { requestUrl } from "obsidian";
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

    const resp = await requestUrl({
      url,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.config.authToken}`,
        "X-Content-Digest": digest,
      },
      contentType: "application/octet-stream",
      body: body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ),
      throw: false,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Settings upload failed: ${resp.status}`);
    }
  }

  async download(configPath: string): Promise<{
    content: string;
    digest: string;
    contentAnchor: number;
  } | null> {
    const url = `${this.config.baseUrl}/settings/${encodeURIComponent(configPath)}`;

    const resp = await requestUrl({
      url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.authToken}`,
      },
      throw: false,
    });

    if (resp.status === 404) return null;
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Settings download failed: ${resp.status}`);
    }

    const digest = getHeader(resp.headers, "X-Content-Digest") ?? "";
    const contentAnchor = Number(
      getHeader(resp.headers, "X-Content-Anchor") ?? "0",
    );

    return { content: resp.text, digest, contentAnchor };
  }
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | null {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) {
      return value;
    }
  }
  return null;
}
