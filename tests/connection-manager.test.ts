import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { ConnectionManager } from "../src/connection";
import { PluginLogger } from "../src/logger";
import { getBinaryContent, writeBinaryContent } from "../src/y-text-content";

const TEST_TOKEN = "test-token";
const TIMEOUT = 8_000;

class TestStatusBar {
  current = "offline";
  errors: string[] = [];

  setSynced(): void {
    this.current = "synced";
  }

  setSyncing(): void {
    this.current = "syncing";
  }

  setOffline(): void {
    this.current = "offline";
  }

  setError(message: string): void {
    this.current = "error";
    this.errors.push(message);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startTestServer(
  authenticatedDocs: string[],
): Promise<{ server: Server; url: string }> {
  const port = await getFreePort();
  const server = new Server({
    name: "obsidian-crdt-sync-test",
    quiet: true,
    async onAuthenticate({ token, documentName }) {
      if (token !== TEST_TOKEN) {
        throw new Error("Unauthorized");
      }
      authenticatedDocs.push(documentName);
    },
  });

  await server.listen(port);

  return {
    server,
    url: `ws://127.0.0.1:${port}`,
  };
}

function createConnection(url: string): {
  connection: ConnectionManager;
  statusBar: TestStatusBar;
} {
  const statusBar = new TestStatusBar();
  const connection = new ConnectionManager(
    url,
    TEST_TOKEN,
    statusBar as never,
    new PluginLogger(false),
    crypto.randomUUID(),
  );

  return { connection, statusBar };
}

function contentText(
  connection: ConnectionManager,
  fileId: string,
): string | undefined {
  return connection.filesMap.get(fileId)?.toString();
}

function metaFilePath(
  connection: ConnectionManager,
  fileId: string,
): string | undefined {
  return connection.metaFiles.get(fileId)?.get("path") as string | undefined;
}

function waitFor(condition: () => boolean, timeout = TIMEOUT): Promise<void> {
  if (condition()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeout) {
        clearInterval(timer);
        reject(new Error(`Timed out after ${timeout}ms`));
      }
    }, 25);
  });
}

async function waitForConnectionSync(
  connection: ConnectionManager,
): Promise<void> {
  const internals = connection as unknown as {
    contentProvider: HocuspocusProvider;
    metaProvider: HocuspocusProvider;
  };

  await waitFor(() => {
    return (
      internals.contentProvider.isSynced && internals.metaProvider.isSynced
    );
  });
}

let server: Server;
let url: string;
let authenticatedDocs: string[];
const activeConnections: ConnectionManager[] = [];
const activeProviders: HocuspocusProvider[] = [];
const activeWebsockets: HocuspocusProviderWebsocket[] = [];

beforeEach(async () => {
  authenticatedDocs = [];
  const started = await startTestServer(authenticatedDocs);
  server = started.server;
  url = started.url;
});

afterEach(async () => {
  for (const connection of activeConnections) {
    try {
      connection.destroy();
    } catch {}
  }
  activeConnections.length = 0;

  for (const provider of activeProviders) {
    try {
      provider.destroy();
    } catch {}
  }
  activeProviders.length = 0;

  for (const websocket of activeWebsockets) {
    try {
      websocket.destroy();
    } catch {}
  }
  activeWebsockets.length = 0;

  await server.destroy();
});

describe("ConnectionManager", () => {
  test(
    "uses one shared websocket and syncs both vault-content and vault-meta",
    async () => {
      const first = createConnection(url);
      const second = createConnection(url);
      activeConnections.push(first.connection, second.connection);

      await Promise.all([
        waitForConnectionSync(first.connection),
        waitForConnectionSync(second.connection),
      ]);

      const firstInternals = first.connection as unknown as {
        websocket: HocuspocusProviderWebsocket;
        contentProvider: HocuspocusProvider;
        metaProvider: HocuspocusProvider;
      };

      expect(
        firstInternals.contentProvider.configuration.websocketProvider,
      ).toBe(firstInternals.websocket);
      expect(firstInternals.metaProvider.configuration.websocketProvider).toBe(
        firstInternals.websocket,
      );
      expect(firstInternals.contentProvider.configuration.name).toBe(
        "vault-content",
      );
      expect(firstInternals.metaProvider.configuration.name).toBe("vault-meta");

      first.connection.contentDoc.transact(() => {
        const text = new Y.Text();
        text.insert(0, "hello from content");
        first.connection.filesMap.set("file-1", text);
      }, "local");

      first.connection.metaDoc.transact(() => {
        const metadata = new Y.Map<unknown>();
        metadata.set("path", "note.md");
        metadata.set("deleted", false);
        first.connection.metaFiles.set("file-1", metadata);

        const event = new Y.Map<unknown>();
        event.set("type", "file.create");
        event.set("fileId", "file-1");
        first.connection.metaEvents.push([event]);

        first.connection.metaServerState.set("serverEpoch", 1);
      }, "local");

      await waitFor(() => {
        return (
          contentText(second.connection, "file-1") === "hello from content" &&
          metaFilePath(second.connection, "file-1") === "note.md" &&
          second.connection.metaEvents.length === 1 &&
          second.connection.metaServerState.get("serverEpoch") === 1
        );
      });

      expect(second.statusBar.current).toBe("synced");
    },
    TIMEOUT,
  );

  test(
    "reconnect restores both docs",
    async () => {
      const source = createConnection(url);
      const initialPeer = createConnection(url);
      activeConnections.push(source.connection, initialPeer.connection);

      await Promise.all([
        waitForConnectionSync(source.connection),
        waitForConnectionSync(initialPeer.connection),
      ]);

      source.connection.contentDoc.transact(() => {
        const text = new Y.Text();
        text.insert(0, "restored content");
        source.connection.filesMap.set("file-reconnect", text);
      }, "local");

      source.connection.metaDoc.transact(() => {
        const metadata = new Y.Map<unknown>();
        metadata.set("path", "reconnect.md");
        source.connection.metaFiles.set("file-reconnect", metadata);
        source.connection.metaServerState.set("serverEpoch", 2);
      }, "local");

      await waitFor(() => {
        return (
          contentText(initialPeer.connection, "file-reconnect") ===
            "restored content" &&
          metaFilePath(initialPeer.connection, "file-reconnect") ===
            "reconnect.md" &&
          initialPeer.connection.metaServerState.get("serverEpoch") === 2
        );
      });

      initialPeer.connection.destroy();
      activeConnections.splice(
        activeConnections.indexOf(initialPeer.connection),
        1,
      );

      const reconnectedPeer = createConnection(url);
      activeConnections.push(reconnectedPeer.connection);
      await waitForConnectionSync(reconnectedPeer.connection);

      expect(contentText(reconnectedPeer.connection, "file-reconnect")).toBe(
        "restored content",
      );
      expect(metaFilePath(reconnectedPeer.connection, "file-reconnect")).toBe(
        "reconnect.md",
      );
      expect(
        reconnectedPeer.connection.metaServerState.get("serverEpoch"),
      ).toBe(2);
    },
    TIMEOUT,
  );

  test("syncs a 16 MB binary file over the shared websocket", async () => {
    const source = createConnection(url);
    const peer = createConnection(url);
    activeConnections.push(source.connection, peer.connection);

    await Promise.all([
      waitForConnectionSync(source.connection),
      waitForConnectionSync(peer.connection),
    ]);

    const binary = new Uint8Array(16 * 1024 * 1024);
    for (let i = 0; i < binary.length; i += 4096) {
      binary[i] = i % 251;
    }

    expect(
      writeBinaryContent(
        source.connection.contentDoc,
        source.connection.filesMap,
        "video-1",
        binary,
      ),
    ).toBe(true);

    await waitFor(() => {
      const received = getBinaryContent(peer.connection.filesMap, "video-1");
      return received !== null && received.length === binary.length;
    }, 30_000);

    expect(getBinaryContent(peer.connection.filesMap, "video-1")).toEqual(
      binary,
    );
  }, 30_000);

  test(
    "coalesces repeated visibility reconnect requests while a reconnect is already in flight",
    async () => {
      const originalDocument = globalThis.document;
      const visibilityListeners = new Set<() => void>();
      const fakeDocument = {
        visibilityState: "hidden",
        addEventListener(eventName: string, listener: () => void) {
          if (eventName === "visibilitychange") {
            visibilityListeners.add(listener);
          }
        },
        removeEventListener(eventName: string, listener: () => void) {
          if (eventName === "visibilitychange") {
            visibilityListeners.delete(listener);
          }
        },
      };
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: fakeDocument,
      });

      const testConnection = createConnection(url);
      activeConnections.push(testConnection.connection);

      try {
        await waitForConnectionSync(testConnection.connection);

        const internals = testConnection.connection as unknown as {
          websocket: HocuspocusProviderWebsocket & {
            status: WebSocketStatus;
            connect: () => Promise<void>;
          };
        };
        let resolveConnect: () => void = () => {
          throw new Error("Expected reconnect resolver to be set");
        };
        let connectCalls = 0;
        const originalConnect = internals.websocket.connect.bind(
          internals.websocket,
        );
        const originalStatus = internals.websocket.status;

        Object.defineProperty(internals.websocket, "status", {
          configurable: true,
          writable: true,
          value: WebSocketStatus.Disconnected,
        });
        internals.websocket.connect = (() => {
          connectCalls += 1;
          return new Promise<void>((resolve) => {
            resolveConnect = resolve;
          });
        }) as typeof internals.websocket.connect;

        fakeDocument.visibilityState = "visible";
        for (const listener of visibilityListeners) {
          listener();
        }
        for (const listener of visibilityListeners) {
          listener();
        }

        expect(connectCalls).toBe(1);

        resolveConnect();
        await Bun.sleep(0);

        for (const listener of visibilityListeners) {
          listener();
        }

        expect(connectCalls).toBe(2);

        internals.websocket.connect = originalConnect;
        Object.defineProperty(internals.websocket, "status", {
          configurable: true,
          writable: true,
          value: originalStatus,
        });

        testConnection.connection.destroy();
        activeConnections.splice(
          activeConnections.indexOf(testConnection.connection),
          1,
        );
      } finally {
        if (originalDocument === undefined) {
          delete (globalThis as Record<string, unknown>).document;
        } else {
          Object.defineProperty(globalThis, "document", {
            configurable: true,
            value: originalDocument,
          });
        }
      }
    },
    TIMEOUT,
  );

  test(
    "auth runs for both documents on the shared websocket",
    async () => {
      const websocket = new HocuspocusProviderWebsocket({
        url,
        maxAttempts: 1,
      });
      activeWebsockets.push(websocket);

      const contentProvider = new HocuspocusProvider({
        websocketProvider: websocket,
        name: "vault-content",
        document: new Y.Doc(),
        token: TEST_TOKEN,
      });
      const metaProvider = new HocuspocusProvider({
        websocketProvider: websocket,
        name: "vault-meta",
        document: new Y.Doc(),
        token: TEST_TOKEN,
      });
      activeProviders.push(contentProvider, metaProvider);

      contentProvider.attach();
      metaProvider.attach();

      await waitFor(() => {
        return (
          authenticatedDocs.includes("vault-content") &&
          authenticatedDocs.includes("vault-meta")
        );
      });

      expect(authenticatedDocs).toContain("vault-content");
      expect(authenticatedDocs).toContain("vault-meta");
    },
    TIMEOUT,
  );
});
