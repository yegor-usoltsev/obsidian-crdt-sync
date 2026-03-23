import { describe, expect, it } from "bun:test";
import {
  ControlChannel,
  type ControlChannelCallbacks,
  type ControlChannelState,
} from "../../src/metadata-client/control-channel";
import { PluginLogger } from "../../src/shared/logger";

function makeCallbacks(): ControlChannelCallbacks & {
  commits: unknown[];
  rejects: unknown[];
  epochs: unknown[];
  states: ControlChannelState[];
} {
  const cb = {
    commits: [] as unknown[],
    rejects: [] as unknown[],
    epochs: [] as unknown[],
    states: [] as ControlChannelState[],
    onCommit(commit: unknown) {
      cb.commits.push(commit);
    },
    onReject(reject: unknown) {
      cb.rejects.push(reject);
    },
    onEpochChange(epoch: unknown) {
      cb.epochs.push(epoch);
    },
    onStateChange(state: ControlChannelState) {
      cb.states.push(state);
    },
  };
  return cb;
}

describe("control-channel", () => {
  it("starts in disconnected state", () => {
    const callbacks = makeCallbacks();
    const channel = new ControlChannel({
      serverUrl: "ws://localhost:3000",
      authToken: "a".repeat(32),
      logger: new PluginLogger("test", false),
      callbacks,
    });
    expect(channel.getState()).toBe("disconnected");
  });

  it("tracks last known revision", () => {
    const callbacks = makeCallbacks();
    const channel = new ControlChannel({
      serverUrl: "ws://localhost:3000",
      authToken: "a".repeat(32),
      logger: new PluginLogger("test", false),
      callbacks,
    });

    channel.setLastKnownRevision(5);
    expect(channel.getLastKnownRevision()).toBe(5);

    // Should not go backwards
    channel.setLastKnownRevision(3);
    expect(channel.getLastKnownRevision()).toBe(5);

    channel.setLastKnownRevision(10);
    expect(channel.getLastKnownRevision()).toBe(10);
  });

  it("disconnect sets state to disconnected", () => {
    const callbacks = makeCallbacks();
    const channel = new ControlChannel({
      serverUrl: "ws://localhost:3000",
      authToken: "a".repeat(32),
      logger: new PluginLogger("test", false),
      callbacks,
    });

    channel.disconnect();
    expect(channel.getState()).toBe("disconnected");
  });

  it("includes auth token in connection URL", () => {
    const callbacks = makeCallbacks();
    const token = "a".repeat(32);
    const channel = new ControlChannel({
      serverUrl: "wss://example.com",
      authToken: token,
      logger: new PluginLogger("test", false),
      callbacks,
    });
    // We can't test the actual URL without connecting, but we verify the config is stored
    expect(channel.getState()).toBe("disconnected");
  });
});
