/**
 * Client-side metadata intent submission and authoritative result handling.
 * Communicates with the server's metadata registry via the control channel.
 */

import type { PluginLogger } from "../shared/logger";
import type {
  EpochState,
  FileId,
  FileKind,
  MetadataCommit,
  MetadataIntent,
  MetadataReject,
} from "../shared/types";

export interface MetadataClientDeps {
  /** Send an intent over the control channel. */
  sendIntent(intent: MetadataIntent): void;
  /** Called when a commit is received from the server. wasPending=true means self-originated. */
  onCommit(commit: MetadataCommit, wasPending: boolean): void;
  /** Called when a reject is received from the server. */
  onReject(reject: MetadataReject): void;
  /** Called when epoch changes (requires rebootstrap). */
  onEpochChange(epoch: EpochState): void;
  /** Generate a unique operation ID. */
  generateOperationId(): string;
  /** Get the client ID. */
  getClientId(): string;
  logger: PluginLogger;
}

export class MetadataClient {
  private deps: MetadataClientDeps;
  private pendingIntents = new Map<string, MetadataIntent>();

  constructor(deps: MetadataClientDeps) {
    this.deps = deps;
  }

  /** Submit a create intent. */
  create(path: string, kind: FileKind): MetadataIntent {
    const intent: MetadataIntent = {
      type: "create",
      clientId: this.deps.getClientId(),
      operationId: this.deps.generateOperationId(),
      path,
      kind,
    };
    this.submitIntent(intent);
    return intent;
  }

  /** Submit a rename intent. */
  rename(
    fileId: FileId,
    newPath: string,
    contentAnchor?: number,
  ): MetadataIntent {
    const intent: MetadataIntent = {
      type: "rename",
      clientId: this.deps.getClientId(),
      operationId: this.deps.generateOperationId(),
      fileId,
      newPath,
      contentAnchor,
    };
    this.submitIntent(intent);
    return intent;
  }

  /** Submit a move intent. */
  move(
    fileId: FileId,
    newPath: string,
    contentAnchor?: number,
  ): MetadataIntent {
    const intent: MetadataIntent = {
      type: "move",
      clientId: this.deps.getClientId(),
      operationId: this.deps.generateOperationId(),
      fileId,
      newPath,
      contentAnchor,
    };
    this.submitIntent(intent);
    return intent;
  }

  /** Submit a delete intent. */
  delete(
    fileId: FileId,
    contentAnchor?: number,
    contentDigest?: string,
  ): MetadataIntent {
    const intent: MetadataIntent = {
      type: "delete",
      clientId: this.deps.getClientId(),
      operationId: this.deps.generateOperationId(),
      fileId,
      contentAnchor,
      contentDigest,
    };
    this.submitIntent(intent);
    return intent;
  }

  /** Handle an authoritative commit from the server. */
  handleCommit(commit: MetadataCommit): void {
    const wasPending = this.pendingIntents.has(commit.operationId);
    this.pendingIntents.delete(commit.operationId);
    this.deps.onCommit(commit, wasPending);
  }

  /** Handle a rejection from the server. */
  handleReject(reject: MetadataReject): void {
    const intent = this.pendingIntents.get(reject.operationId);
    this.pendingIntents.delete(reject.operationId);
    this.deps.logger.warn("Metadata intent rejected", {
      operationId: reject.operationId,
      reason: reject.reason,
      intent: intent?.type,
    });
    this.deps.onReject(reject);
  }

  /** Handle an epoch change event from the server. */
  handleEpochChange(epoch: EpochState): void {
    this.deps.logger.info("Epoch changed, rebootstrap required", { epoch });
    this.deps.onEpochChange(epoch);
  }

  /** Get all pending intents (for persistence/diagnostics). */
  getPendingIntents(): MetadataIntent[] {
    return Array.from(this.pendingIntents.values());
  }

  /** Restore pending intents from durable store. */
  restorePendingIntents(intents: MetadataIntent[]): void {
    for (const intent of intents) {
      this.pendingIntents.set(intent.operationId, intent);
    }
  }

  private submitIntent(intent: MetadataIntent): void {
    this.pendingIntents.set(intent.operationId, intent);
    this.deps.logger.debug("Submitting metadata intent", {
      type: intent.type,
      operationId: intent.operationId,
    });
    this.deps.sendIntent(intent);
  }
}
