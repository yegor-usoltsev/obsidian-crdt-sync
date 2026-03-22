import { describe, expect, it } from "bun:test";
import { validateTransportConfig } from "../../src/shared/transport-config";

describe("transport-config", () => {
  it("accepts wss:// for remote servers", () => {
    const result = validateTransportConfig("wss://sync.example.com/ws");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.isSecure).toBe(true);
      expect(result.wsUrl).toBe("wss://sync.example.com/ws");
      expect(result.httpBaseUrl).toBe("https://sync.example.com/ws");
    }
  });

  it("accepts ws:// for localhost", () => {
    const result = validateTransportConfig("ws://localhost:3000");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.isSecure).toBe(false);
    }
  });

  it("accepts ws:// for 127.0.0.1", () => {
    const result = validateTransportConfig("ws://127.0.0.1:3000");
    expect("error" in result).toBe(false);
  });

  it("accepts ws:// for ::1", () => {
    const result = validateTransportConfig("ws://[::1]:3000");
    expect("error" in result).toBe(false);
  });

  it("rejects ws:// for remote host", () => {
    const result = validateTransportConfig("ws://remote-server.com");
    expect("error" in result).toBe(true);
  });

  it("rejects empty URL", () => {
    const result = validateTransportConfig("");
    expect("error" in result).toBe(true);
  });

  it("rejects invalid URL", () => {
    const result = validateTransportConfig("not-a-url");
    expect("error" in result).toBe(true);
  });

  it("rejects http:// protocol", () => {
    const result = validateTransportConfig("http://example.com");
    expect("error" in result).toBe(true);
  });

  it("rejects URL over 2048 chars", () => {
    const result = validateTransportConfig(
      `wss://example.com/${"a".repeat(2048)}`,
    );
    expect("error" in result).toBe(true);
  });
});
