import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import type { Component } from "obsidian";
import * as Y from "yjs";
import type { PluginLogger } from "./logger";
import type {
  MetadataStatelessHandler,
  MetadataStatelessMessage,
} from "./metadata-sync";
import type { StatusBarManager } from "./status";
import type { SyncedFileContent } from "./y-text-content";

type DocumentName = "vault-content" | "vault-meta";

export class ConnectionManager {
  readonly contentDoc: Y.Doc;
  readonly metaDoc: Y.Doc;
  readonly filesMap: Y.Map<SyncedFileContent>;
  readonly metaFiles: Y.Map<Y.Map<unknown>>;
  readonly metaEvents: Y.Array<Y.Map<unknown>>;
  readonly metaServerState: Y.Map<unknown>;

  private contentProvider: HocuspocusProvider;
  private metaProvider: HocuspocusProvider;
  private websocket: HocuspocusProviderWebsocket;
  private statusBar: StatusBarManager;
  private logger: PluginLogger;
  private clientId: string;
  private statelessHandlers = new Set<MetadataStatelessHandler>();
  private readonly syncWaiters: Record<
    DocumentName,
    Set<{ resolve: () => void; reject: (err: Error) => void }>
  > = {
    "vault-content": new Set(),
    "vault-meta": new Set(),
  };
  private visibilityHandler: (() => void) | null = null;
  private syncedCallback: (() => void) | null = null;
  private docSynced: Record<DocumentName, boolean> = {
    "vault-content": false,
    "vault-meta": false,
  };
  private hasReportedFullySynced = false;
  private reconnectInFlight = false;
  private readonly syncTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    serverUrl: string,
    authToken: string,
    statusBar: StatusBarManager,
    logger: PluginLogger,
    clientId: string,
    owner?: Pick<Component, "register" | "registerDomEvent">,
  ) {
    this.statusBar = statusBar;
    this.logger = logger;
    this.clientId = clientId;
    this.contentDoc = new Y.Doc();
    this.metaDoc = new Y.Doc();
    this.filesMap = this.contentDoc.getMap<SyncedFileContent>("files");
    this.metaFiles = this.metaDoc.getMap<Y.Map<unknown>>("files");
    this.metaEvents = this.metaDoc.getArray<Y.Map<unknown>>("events");
    this.metaServerState = this.metaDoc.getMap<unknown>("serverState");

    this.websocket = new HocuspocusProviderWebsocket({
      url: serverUrl,
      delay: 1000,
      factor: 2,
      maxDelay: 30000,
      jitter: true,
      maxAttempts: 0,
    });

    this.contentProvider = this.createProvider({
      authToken,
      documentName: "vault-content",
      document: this.contentDoc,
    });
    this.metaProvider = this.createProvider({
      authToken,
      documentName: "vault-meta",
      document: this.metaDoc,
      onStateless: (payload) => {
        try {
          const msg = JSON.parse(payload) as MetadataStatelessMessage;
          for (const handler of this.statelessHandlers) {
            handler(msg);
          }
        } catch {
          this.logger.warn("ignored malformed stateless message", {
            documentName: "vault-meta",
          });
        }
      },
    });
    this.contentProvider.attach();
    this.metaProvider.attach();
    this.setupVisibilityListener(owner);
    owner?.register(() => this.destroy());
  }

  private setupVisibilityListener(
    owner?: Pick<Component, "registerDomEvent">,
  ): void {
    if (typeof document === "undefined") return;

    if (owner?.registerDomEvent) {
      owner.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible") {
          this.requestReconnect("visibility");
        }
      });
      return;
    }

    this.visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        this.requestReconnect("visibility");
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private createProvider({
    authToken,
    documentName,
    document,
    onStateless,
  }: {
    authToken: string;
    documentName: DocumentName;
    document: Y.Doc;
    onStateless?: (payload: string) => void;
  }): HocuspocusProvider {
    return new HocuspocusProvider({
      websocketProvider: this.websocket,
      name: documentName,
      document,
      token: authToken,
      onStatus: ({ status }) => this.handleStatusChange(documentName, status),
      onSynced: () => {
        this.handleSynced(documentName);
      },
      onAuthenticationFailed: ({ reason }) => {
        this.logger.warn("authentication failed", { documentName, reason });
        this.statusBar.setError(`auth failed: ${reason}`);
        this.failAllSyncWaiters(new Error(`Authentication failed: ${reason}`));
      },
      onStateless: onStateless
        ? ({ payload }) => {
            onStateless(payload);
          }
        : undefined,
    });
  }

  private handleStatusChange(
    documentName: DocumentName,
    status: WebSocketStatus,
  ): void {
    this.logger.debug("connection status changed", { documentName, status });

    if (status !== WebSocketStatus.Connected) {
      this.resetSyncState();
    }

    if (status === WebSocketStatus.Connecting) {
      this.statusBar.setSyncing();
      return;
    }

    if (status === WebSocketStatus.Disconnected) {
      this.statusBar.setOffline();
      return;
    }

    if (this.areAllDocsSynced()) {
      this.statusBar.setSynced();
    } else {
      this.statusBar.setSyncing();
    }
  }

  private failAllSyncWaiters(error: Error): void {
    for (const name of ["vault-content", "vault-meta"] as DocumentName[]) {
      for (const waiter of this.syncWaiters[name]) {
        waiter.reject(error);
      }
      this.syncWaiters[name].clear();
    }
  }

  private handleSynced(documentName: DocumentName): void {
    this.logger.debug("document synced", { documentName });
    this.docSynced[documentName] = true;
    for (const waiter of this.syncWaiters[documentName]) {
      waiter.resolve();
    }
    this.syncWaiters[documentName].clear();

    if (!this.areAllDocsSynced()) {
      this.statusBar.setSyncing();
      return;
    }

    this.statusBar.setSynced();
    if (this.hasReportedFullySynced) return;

    this.hasReportedFullySynced = true;
    this.syncedCallback?.();
  }

  private areAllDocsSynced(): boolean {
    return this.docSynced["vault-content"] && this.docSynced["vault-meta"];
  }

  private resetSyncState(): void {
    this.docSynced["vault-content"] = false;
    this.docSynced["vault-meta"] = false;
    this.hasReportedFullySynced = false;
  }

  requestReconnect(reason: "visibility" | "manual"): void {
    const status = this.websocket.status;
    if (this.reconnectInFlight || status !== WebSocketStatus.Disconnected) {
      return;
    }

    this.reconnectInFlight = true;

    Promise.resolve(this.websocket.connect())
      .catch((error) => {
        this.logger.warn("reconnect request failed", {
          reason,
          error: String(error),
        });
      })
      .finally(() => {
        this.reconnectInFlight = false;
      });
  }

  get status(): WebSocketStatus {
    return this.websocket.status;
  }

  addStatelessHandler(handler: MetadataStatelessHandler): () => void {
    this.statelessHandlers.add(handler);

    return () => {
      this.statelessHandlers.delete(handler);
    };
  }

  setSyncedCallback(cb: () => void): void {
    this.syncedCallback = cb;
  }

  waitForDocumentSync(
    documentName: DocumentName,
    timeoutMs = 30_000,
  ): Promise<void> {
    if (this.docSynced[documentName]) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.syncTimers.delete(timer);
        this.syncWaiters[documentName].delete(waiter);
        reject(
          new Error(
            `Timed out waiting for "${documentName}" sync after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.syncTimers.add(timer);

      const waiter = {
        resolve: () => {
          this.syncTimers.delete(timer);
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          this.syncTimers.delete(timer);
          clearTimeout(timer);
          reject(err);
        },
      };

      this.syncWaiters[documentName].add(waiter);
    });
  }

  sendStateless(msg: MetadataStatelessMessage): void {
    const normalized: MetadataStatelessMessage = msg.clientId
      ? msg
      : { ...msg, clientId: this.clientId };
    this.metaProvider.sendStateless(JSON.stringify(normalized));
  }

  destroy(): void {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    for (const timer of this.syncTimers) {
      clearTimeout(timer);
    }
    this.syncTimers.clear();
    this.failAllSyncWaiters(new Error("Connection destroyed"));
    this.contentProvider.destroy();
    this.metaProvider.destroy();
    this.websocket.destroy();
    this.contentDoc.destroy();
    this.metaDoc.destroy();
  }
}
