/**
 * Binary blob sync client: upload/download orchestration via HTTP.
 */

import { requestUrl } from "obsidian";
import type { PluginLogger } from "../shared/logger";
import type { FileId } from "../shared/types";

export interface BlobMetadata {
  fileId: FileId;
  digest: string;
  size: number;
  contentAnchor: number;
}

export interface BlobClientDeps {
  /** Base URL for blob HTTP endpoints. */
  baseUrl: string;
  /** Auth token for requests. */
  authToken: string;
  logger: PluginLogger;
}

export class BlobClient {
  private deps: BlobClientDeps;

  constructor(deps: BlobClientDeps) {
    this.deps = deps;
  }

  /** Upload a binary blob to the server. */
  async upload(
    fileId: FileId,
    content: ArrayBuffer,
    digest: string,
  ): Promise<BlobMetadata> {
    const url = `${this.deps.baseUrl}/blobs/${encodeURIComponent(fileId)}`;
    this.deps.logger.debug("Uploading blob", {
      fileId,
      size: content.byteLength,
    });

    const response = await requestUrl({
      url,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.deps.authToken}`,
        "X-Content-Digest": digest,
      },
      contentType: "application/octet-stream",
      body: content,
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Blob upload failed: ${response.status}`);
    }

    return response.json as BlobMetadata;
  }

  /** Download a binary blob from the server. */
  async download(
    fileId: FileId,
    expectedDigest?: string,
  ): Promise<ArrayBuffer> {
    const url = `${this.deps.baseUrl}/blobs/${encodeURIComponent(fileId)}`;
    this.deps.logger.debug("Downloading blob", { fileId });

    const response = await requestUrl({
      url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.deps.authToken}`,
      },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Blob download failed: ${response.status}`);
    }

    const content = response.arrayBuffer;

    if (expectedDigest) {
      const actual = await computeDigest(content);
      if (actual !== expectedDigest) {
        throw new Error(
          `Blob digest mismatch: expected ${expectedDigest}, got ${actual}`,
        );
      }
    }

    return content;
  }

  /** Check if a blob exists on the server by digest. */
  async exists(digest: string): Promise<boolean> {
    const url = `${this.deps.baseUrl}/blobs/check/${encodeURIComponent(digest)}`;
    const response = await requestUrl({
      url,
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${this.deps.authToken}`,
      },
      throw: false,
    });
    return response.status >= 200 && response.status < 300;
  }
}

/** Compute SHA-256 digest of content. */
export async function computeDigest(
  content: ArrayBuffer | Uint8Array,
): Promise<string> {
  const buf =
    content instanceof Uint8Array ? (content.buffer as ArrayBuffer) : content;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
