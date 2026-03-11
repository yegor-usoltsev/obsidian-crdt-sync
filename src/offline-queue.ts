import { fromBase64, toBase64 } from "lib0/buffer";
import type { Component, Debouncer } from "obsidian";
import * as Y from "yjs";
import type { PluginLogger } from "./logger";
import { createDebounce } from "./obsidian-debounce";

export interface PendingUpdate {
  update: string;
  timestamp: number;
}

const MAX_ENTRIES = 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const SAVE_DEBOUNCE_MS = 1000;

export class OfflineQueue {
  private pendingUpdates: PendingUpdate[];
  private updateHandler: (update: Uint8Array, origin: unknown) => void;
  private saveDebounced: Debouncer<[], void>;

  constructor(
    private readonly ydoc: Y.Doc,
    initialUpdates: PendingUpdate[],
    private readonly persistFn: (updates: PendingUpdate[]) => Promise<void>,
    private readonly isOnlineFn: () => boolean,
    private readonly logger: PluginLogger,
    owner?: Pick<Component, "register">,
  ) {
    this.pendingUpdates = [...initialUpdates];
    this.saveDebounced = createDebounce(
      () => void this.persistFn(this.pendingUpdates),
      SAVE_DEBOUNCE_MS,
      true,
    );

    this.restoreFromQueue();

    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin !== "local") return;
      this.pendingUpdates.push({
        update: toBase64(update),
        timestamp: Date.now(),
      });
      this.compact();
      if (this.isOnlineFn()) {
        this.saveDebounced();
      } else {
        this.flush();
      }
    };
    this.ydoc.on("update", this.updateHandler);
    owner?.register(() => this.destroy());
  }

  private restoreFromQueue(): void {
    if (this.pendingUpdates.length === 0) return;
    try {
      Y.applyUpdate(
        this.ydoc,
        Y.mergeUpdates(
          this.pendingUpdates.map(({ update }) => fromBase64(update)),
        ),
      );
    } catch (err) {
      this.logger.error("failed to restore offline queue", {
        error: String(err),
      });
      this.pendingUpdates = [];
    }
  }

  onSynced(): void {
    this.pendingUpdates = [];
    this.saveDebounced();
  }

  getPendingUpdates(): PendingUpdate[] {
    return [...this.pendingUpdates];
  }

  flush(): void {
    this.saveDebounced.cancel();
    void this.persistFn(this.pendingUpdates);
  }

  private compact(): void {
    if (
      this.pendingUpdates.length <= MAX_ENTRIES &&
      this.pendingUpdates.reduce((sum, { update }) => sum + update.length, 0) <=
        MAX_BYTES
    ) {
      return;
    }

    try {
      const mergedBase64 = toBase64(
        Y.mergeUpdates(
          this.pendingUpdates.map(({ update }) => fromBase64(update)),
        ),
      );
      if (mergedBase64.length > MAX_BYTES) {
        this.pendingUpdates = this.pendingUpdates.slice(
          Math.floor(this.pendingUpdates.length / 2),
        );
        return;
      }

      this.pendingUpdates = [{ update: mergedBase64, timestamp: Date.now() }];
    } catch (err) {
      this.logger.error("failed to compact offline queue", {
        error: String(err),
      });
    }
  }

  destroy(): void {
    this.ydoc.off("update", this.updateHandler);
    this.saveDebounced.cancel();
    void this.persistFn(this.pendingUpdates);
  }
}
