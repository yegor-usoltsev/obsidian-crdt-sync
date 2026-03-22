import { describe, expect, it } from "bun:test";
import {
  createFilePolicyEngine,
  SIZE_LIMITS,
} from "../../src/policy-engine/file-policy";

describe("file-policy", () => {
  const engine = createFilePolicyEngine(".obsidian");

  describe("checkEligibility", () => {
    it("rejects empty paths", () => {
      const result = engine.checkEligibility("");
      expect(result.eligible).toBe(false);
    });

    it("rejects absolute paths", () => {
      expect(engine.checkEligibility("/etc/passwd").eligible).toBe(false);
      expect(engine.checkEligibility("C:\\file.txt").eligible).toBe(false);
    });

    it("rejects path traversal", () => {
      expect(engine.checkEligibility("../secret.txt").eligible).toBe(false);
      expect(engine.checkEligibility("dir/../secret.txt").eligible).toBe(false);
    });

    it("rejects OS junk files", () => {
      expect(engine.checkEligibility(".DS_Store").eligible).toBe(false);
      expect(engine.checkEligibility("Thumbs.db").eligible).toBe(false);
    });

    it("rejects dot-prefixed top-level paths (except config dir)", () => {
      expect(engine.checkEligibility(".git/config").eligible).toBe(false);
      expect(engine.checkEligibility(".hidden/file.md").eligible).toBe(false);
    });

    it("allows config dir paths", () => {
      const result = engine.checkEligibility(".obsidian/app.json");
      expect(result.eligible).toBe(true);
    });

    it("rejects node_modules under config dir", () => {
      expect(
        engine.checkEligibility(
          ".obsidian/plugins/test/node_modules/pkg/index.js",
        ).eligible,
      ).toBe(false);
    });

    it("rejects oversized files", () => {
      const result = engine.checkEligibility(
        "bigfile.bin",
        SIZE_LIMITS.content + 1,
      );
      expect(result.eligible).toBe(false);
    });

    it("allows normal vault files", () => {
      const result = engine.checkEligibility("notes/daily/2024-01-01.md");
      expect(result.eligible).toBe(true);
      if (result.eligible) {
        expect(result.kind).toBe("text");
      }
    });

    it("classifies binary files correctly", () => {
      const result = engine.checkEligibility("images/photo.png");
      expect(result.eligible).toBe(true);
      if (result.eligible) {
        expect(result.kind).toBe("binary");
      }
    });
  });

  describe("isConfigPath", () => {
    it("detects config dir", () => {
      expect(engine.isConfigPath(".obsidian")).toBe(true);
      expect(engine.isConfigPath(".obsidian/app.json")).toBe(true);
    });

    it("rejects non-config paths", () => {
      expect(engine.isConfigPath("notes/file.md")).toBe(false);
    });
  });
});
