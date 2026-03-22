/**
 * Hocuspocus client integration for text document replication.
 * Manages per-file HocuspocusProvider instances keyed by file identity.
 */

import { HocuspocusProvider } from "@hocuspocus/provider";
import type { PluginLogger } from "../shared/logger";
import type { FileId } from "../shared/types";
import type { TextDocManager } from "./text-doc-manager";

export interface HocuspocusClientDeps {
  wsUrl: string;
  authToken: string;
  logger: PluginLogger;
  docManager: TextDocManager;
}

export class HocuspocusClient {
  private deps: HocuspocusClientDeps;
  private providers = new Map<FileId, HocuspocusProvider>();

  constructor(deps: HocuspocusClientDeps) {
    this.deps = deps;
  }

  /** Connect a text document to the server for replication. */
  connect(fileId: FileId): HocuspocusProvider {
    let provider = this.providers.get(fileId);
    if (provider) return provider;

    const entry = this.deps.docManager.getOrCreate(fileId);

    provider = new HocuspocusProvider({
      url: this.deps.wsUrl,
      name: fileId, // document name = file identity
      document: entry.doc,
      token: this.deps.authToken,
      onSynced: () => {
        entry.synced = true;
        this.deps.logger.debug("Text doc synced", { fileId });
      },
      onDisconnect: () => {
        this.deps.logger.debug("Text doc disconnected", { fileId });
      },
    });

    this.providers.set(fileId, provider);
    return provider;
  }

  /** Disconnect a text document from the server. */
  disconnect(fileId: FileId): void {
    const provider = this.providers.get(fileId);
    if (provider) {
      provider.disconnect();
      provider.destroy();
      this.providers.delete(fileId);
    }
  }

  /** Disconnect all providers. */
  disconnectAll(): void {
    for (const [_fileId, provider] of this.providers) {
      provider.disconnect();
      provider.destroy();
    }
    this.providers.clear();
  }

  /** Check if a file is connected. */
  isConnected(fileId: FileId): boolean {
    return this.providers.has(fileId);
  }

  /** Get all connected file IDs. */
  getConnectedFileIds(): FileId[] {
    return Array.from(this.providers.keys());
  }
}
