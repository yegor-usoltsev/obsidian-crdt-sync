import { describe, expect, it } from "bun:test";
import {
  DEBOUNCE,
  resyncCooldownMs,
  retryBackoffMs,
} from "../../src/bootstrap-repair/bootstrap";

describe("bootstrap", () => {
  describe("retryBackoffMs", () => {
    it("starts at 5s for first failure", () => {
      expect(retryBackoffMs(0)).toBe(5000);
    });

    it("doubles each failure", () => {
      expect(retryBackoffMs(1)).toBe(10000);
      expect(retryBackoffMs(2)).toBe(20000);
      expect(retryBackoffMs(3)).toBe(40000);
    });

    it("caps at 5 minutes", () => {
      expect(retryBackoffMs(10)).toBe(300_000);
      expect(retryBackoffMs(20)).toBe(300_000);
    });
  });

  describe("resyncCooldownMs", () => {
    it("returns 10s for small files", () => {
      expect(resyncCooldownMs(1024)).toBe(10_000);
      expect(resyncCooldownMs(10 * 1024)).toBe(10_000);
    });

    it("returns 20s for medium files", () => {
      expect(resyncCooldownMs(50 * 1024)).toBe(20_000);
      expect(resyncCooldownMs(100 * 1024)).toBe(20_000);
    });

    it("returns 30s for large files", () => {
      expect(resyncCooldownMs(200 * 1024)).toBe(30_000);
      expect(resyncCooldownMs(1024 * 1024)).toBe(30_000);
    });
  });

  describe("DEBOUNCE", () => {
    it("has correct create settle time", () => {
      expect(DEBOUNCE.createSettle).toBe(350);
    });

    it("has correct modify debounce time", () => {
      expect(DEBOUNCE.modifyDebounce).toBe(300);
    });
  });
});
