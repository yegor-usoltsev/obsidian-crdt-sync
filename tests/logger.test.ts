import { describe, expect, test } from "bun:test";
import { PluginLogger } from "../src/logger";

describe("PluginLogger", () => {
  test("suppresses debug, info, and warn when disabled, but always emits error", () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const logs: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];

    console.log = ((...args: unknown[]) => {
      logs.push(args.join(" "));
    }) as typeof console.log;
    console.warn = ((...args: unknown[]) => {
      warns.push(args.join(" "));
    }) as typeof console.warn;
    console.error = ((...args: unknown[]) => {
      errors.push(args.join(" "));
    }) as typeof console.error;

    try {
      const logger = new PluginLogger();
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }

    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[crdt-sync] error");
  });

  test("logs merged trace context when enabled", () => {
    const originalLog = console.log;
    const entries: string[] = [];

    console.log = ((...args: unknown[]) => {
      entries.push(args.join(" "));
    }) as typeof console.log;

    try {
      const logger = new PluginLogger(true, {
        component: "plugin",
        clientId: "client-1",
      }).child({
        fileId: "file-1",
      });
      logger.debug("queued metadata op", {
        clientOpId: "op-1",
        path: "note.md",
      });
    } finally {
      console.log = originalLog;
    }

    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("[crdt-sync] queued metadata op");
    expect(entries[0]).toContain('"component":"plugin"');
    expect(entries[0]).toContain('"clientId":"client-1"');
    expect(entries[0]).toContain('"fileId":"file-1"');
    expect(entries[0]).toContain('"clientOpId":"op-1"');
    expect(entries[0]).toContain('"path":"note.md"');
  });
});
