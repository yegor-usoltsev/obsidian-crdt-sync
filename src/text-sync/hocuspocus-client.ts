/**
 * Hocuspocus client integration for text document replication.
 * Manages per-file HocuspocusProvider instances keyed by file identity.
 */

import { HocuspocusProvider } from "@hocuspocus/provider";
import type { PluginLogger } from "../shared/logger";
import type { FileId } from "../shared/types";
import type { TextDocManager } from "./text-doc-manager";
import { LOCAL_ORIGIN } from "./text-doc-manager";

export interface HocuspocusClientDeps {
  wsUrl: string;
  authToken: string;
  logger: PluginLogger;
  docManager: TextDocManager;
  /** Called when a remote Y.Doc update is received (origin !== LOCAL_ORIGIN). */
  onRemoteTextUpdate?: (fileId: FileId, text: string) => Promise<void>;
  /** Called when initial sync completes for a file. */
  onSynced?: (fileId: FileId) => void;
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
      onAuthenticated: () => {
        this.deps.logger.debug("Text doc authenticated", { fileId });
      },
      onAuthenticationFailed: ({ reason }) => {
        this.deps.logger.warn("Text doc authentication failed", {
          fileId,
          reason,
        });
      },
      onStatus: ({ status }) => {
        this.deps.logger.debug("Text doc status changed", {
          fileId,
          status,
        });
      },
      onSynced: () => {
        if (entry.synced) return; // Prevent duplicate listener registration
        entry.synced = true;
        this.deps.logger.debug("Text doc synced", { fileId });

        // Notify caller (e.g., to clear offline progress)
        this.deps.onSynced?.(fileId);

        // Register Y.Doc update observer for ongoing remote changes
        if (this.deps.onRemoteTextUpdate) {
          const callback = this.deps.onRemoteTextUpdate;
          entry.doc.on("update", (_update: Uint8Array, origin: unknown) => {
            if (origin !== LOCAL_ORIGIN) {
              const text = entry.text.toString();
              callback(fileId, text).catch((err) => {
                this.deps.logger.error("Remote text update failed", {
                  fileId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          });
        }
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
      provider.destroy();
      this.providers.delete(fileId);
    }
  }

  /** Disconnect all providers. */
  disconnectAll(): void {
    for (const provider of this.providers.values()) {
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
