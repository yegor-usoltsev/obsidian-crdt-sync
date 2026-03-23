/**
 * WebSocket control channel client: connects to the server's /ws endpoint,
 * transports metadata intents/commits/rejects, and handles reconnection.
 */

import type { PluginLogger } from "../shared/logger";
import type {
  EpochState,
  MetadataCommit,
  MetadataIntent,
  MetadataReject,
} from "../shared/types";

export type ControlChannelState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface ControlChannelCallbacks {
  onCommit(commit: MetadataCommit): void;
  onReject(reject: MetadataReject): void;
  onEpochChange(epoch: EpochState): void;
  onStateChange(state: ControlChannelState): void;
}

export interface ControlChannelConfig {
  serverUrl: string;
  authToken: string;
  logger: PluginLogger;
  callbacks: ControlChannelCallbacks;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export class ControlChannel {
  private config: ControlChannelConfig;
  private ws: WebSocket | null = null;
  private state: ControlChannelState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKnownRevision = 0;
  private intentionalClose = false;

  constructor(config: ControlChannelConfig) {
    this.config = config;
  }

  getState(): ControlChannelState {
    return this.state;
  }

  getLastKnownRevision(): number {
    return this.lastKnownRevision;
  }

  setLastKnownRevision(revision: number): void {
    if (revision > this.lastKnownRevision) {
      this.lastKnownRevision = revision;
    }
  }

  connect(): void {
    if (this.ws) return;
    this.intentionalClose = false;
    this.doConnect();
  }

  /**
   * Wait for the channel to reach "connected" state.
   * Resolves immediately if already connected.
   * Rejects after timeoutMs or if the channel is intentionally closed.
   */
  waitForConnected(timeoutMs = 15000): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const originalOnState = this.config.callbacks.onStateChange;
      const timer = setTimeout(() => {
        this.config.callbacks.onStateChange = originalOnState;
        reject(new Error("Timed out waiting for control channel connection"));
      }, timeoutMs);

      this.config.callbacks.onStateChange = (state) => {
        originalOnState(state);
        if (state === "connected") {
          clearTimeout(timer);
          this.config.callbacks.onStateChange = originalOnState;
          resolve();
        } else if (state === "disconnected" && this.intentionalClose) {
          clearTimeout(timer);
          this.config.callbacks.onStateChange = originalOnState;
          reject(new Error("Control channel closed"));
        }
      };
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  send(intent: MetadataIntent): void {
    if (!this.ws || this.state !== "connected") {
      this.config.logger.warn(
        "Cannot send intent: control channel not connected",
      );
      return;
    }
    this.ws.send(
      JSON.stringify({ action: "metadata.intent", payload: intent }),
    );
  }

  /**
   * Send a raw JSON message over the control channel.
   * Used for non-intent messages like history.list, diagnostics.request.
   */
  sendRaw(message: Record<string, unknown>): void {
    if (!this.ws || this.state !== "connected") {
      this.config.logger.warn(
        "Cannot send message: control channel not connected",
      );
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send a request and wait for a response with the matching action.
   * Uses a unique request ID to correlate concurrent requests.
   * Times out after the specified duration (default 10s).
   */
  requestResponse(
    message: Record<string, unknown>,
    responseAction: string,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.state !== "connected") {
        reject(new Error("Control channel not connected"));
        return;
      }

      const requestId = crypto.randomUUID();
      const key = `${responseAction}:${requestId}`;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new Error(`Timeout waiting for ${responseAction}`));
      }, timeoutMs);

      this.pendingRequests.set(key, (payload: unknown) => {
        clearTimeout(timeout);
        this.pendingRequests.delete(key);
        resolve(payload);
      });

      this.ws.send(JSON.stringify({ ...message, requestId }));
    });
  }

  /**
   * Wait for a metadata.replay-complete message with the given requestId.
   * Separate from requestResponse because subscribe triggers a stream of
   * commits before the final replay-complete.
   */
  awaitReplayComplete(
    requestId: string,
    timeoutMs = 30_000,
  ): Promise<{ sinceRevision: number; currentRevision: number }> {
    return new Promise((resolve, reject) => {
      const key = `metadata.replay-complete:${requestId}`;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new Error("Timeout waiting for metadata.replay-complete"));
      }, timeoutMs);

      this.pendingRequests.set(key, (payload: unknown) => {
        clearTimeout(timeout);
        this.pendingRequests.delete(key);
        resolve(payload as { sinceRevision: number; currentRevision: number });
      });
    });
  }

  private pendingRequests = new Map<string, (payload: unknown) => void>();

  private doConnect(): void {
    const { serverUrl, authToken, logger } = this.config;

    // Convert http(s) to ws(s) if needed, append /ws path
    const wsUrl = serverUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const url = `${wsUrl}/ws?token=${encodeURIComponent(authToken)}`;

    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    const ws = new WebSocket(url);

    ws.onopen = () => {
      logger.info("Control channel connected");
      this.reconnectAttempts = 0;
      this.setState("connected");

      // Re-subscribe from last known revision
      ws.send(
        JSON.stringify({
          action: "metadata.subscribe",
          sinceRevision: this.lastKnownRevision,
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        this.handleMessage(msg);
      } catch (err) {
        logger.warn("Failed to parse control channel message", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.intentionalClose) {
        logger.info("Control channel disconnected, scheduling reconnect");
        this.setState("reconnecting");
        this.scheduleReconnect();
      } else {
        this.setState("disconnected");
      }
    };

    ws.onerror = (event) => {
      logger.warn("Control channel error", {
        error: event instanceof ErrorEvent ? event.message : "unknown",
      });
    };

    this.ws = ws;
  }

  private handleMessage(msg: {
    action: string;
    payload?: unknown;
    message?: string;
    requestId?: string;
    sinceRevision?: number;
    currentRevision?: number;
  }): void {
    // Check for pending request/response handlers (exact key match only).
    if (msg.requestId) {
      const key = `${msg.action}:${msg.requestId}`;
      const pendingHandler = this.pendingRequests.get(key);
      if (pendingHandler) {
        pendingHandler(
          msg.action === "metadata.replay-complete" ? msg : msg.payload,
        );
        return;
      }
    }

    switch (msg.action) {
      case "metadata.commit": {
        const commit = msg.payload as MetadataCommit;
        if (commit.revision > this.lastKnownRevision) {
          this.lastKnownRevision = commit.revision;
        }
        this.config.callbacks.onCommit(commit);
        break;
      }
      case "metadata.reject":
        this.config.callbacks.onReject(msg.payload as MetadataReject);
        break;
      case "metadata.epochChange":
        this.config.callbacks.onEpochChange(msg.payload as EpochState);
        break;
      case "metadata.replay-complete":
        // Handled by pendingRequests above if requestId matches.
        // If no handler registered, just ignore.
        break;
      case "pong":
        break;
      case "error":
        this.config.logger.warn("Server error", { message: msg.message });
        break;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** this.reconnectAttempts,
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempts++;
    this.config.logger.debug("Reconnecting in", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ControlChannelState): void {
    if (this.state !== state) {
      this.state = state;
      this.config.callbacks.onStateChange(state);
    }
  }
}
