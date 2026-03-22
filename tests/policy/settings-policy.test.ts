import { describe, expect, it } from "bun:test";
import {
  applyMergePolicy,
  isAllowlistedSettingsFile,
} from "../../src/settings-sync/settings-policy";

describe("settings-policy", () => {
  describe("isAllowlistedSettingsFile", () => {
    it("allows app.json", () => {
      const result = isAllowlistedSettingsFile("app.json");
      expect(result).toBeDefined();
      expect(result?.policy).toBe("shallow-merge");
    });

    it("allows types.json", () => {
      const result = isAllowlistedSettingsFile("types.json");
      expect(result).toBeDefined();
      expect(result?.policy).toBe("replace");
    });

    it("allows core-plugins.json", () => {
      const result = isAllowlistedSettingsFile("core-plugins.json");
      expect(result).toBeDefined();
      expect(result?.policy).toBe("union-by-id");
    });

    it("allows plugin data", () => {
      const result = isAllowlistedSettingsFile("plugins/myplugin/data.json");
      expect(result).toBeDefined();
      expect(result?.policy).toBe("replace");
    });

    it("allows plugin packages", () => {
      expect(
        isAllowlistedSettingsFile("plugins/myplugin/main.js")?.policy,
      ).toBe("snapshot");
      expect(
        isAllowlistedSettingsFile("plugins/myplugin/manifest.json")?.policy,
      ).toBe("snapshot");
      expect(
        isAllowlistedSettingsFile("plugins/myplugin/styles.css")?.policy,
      ).toBe("snapshot");
    });

    it("allows theme files", () => {
      expect(
        isAllowlistedSettingsFile("themes/mytheme/theme.css")?.policy,
      ).toBe("snapshot");
      expect(
        isAllowlistedSettingsFile("themes/mytheme/manifest.json")?.policy,
      ).toBe("snapshot");
    });

    it("allows snippets", () => {
      expect(isAllowlistedSettingsFile("snippets/custom.css")?.policy).toBe(
        "snapshot",
      );
    });

    it("excludes workspace.json", () => {
      expect(isAllowlistedSettingsFile("workspace.json")).toBeUndefined();
    });

    it("excludes workspace-mobile.json", () => {
      expect(
        isAllowlistedSettingsFile("workspace-mobile.json"),
      ).toBeUndefined();
    });

    it("excludes unknown config files", () => {
      expect(isAllowlistedSettingsFile("random-config.json")).toBeUndefined();
    });
  });

  describe("applyMergePolicy", () => {
    it("replace: returns remote", () => {
      expect(applyMergePolicy("replace", { a: 1 }, { b: 2 })).toEqual({ b: 2 });
    });

    it("snapshot: returns remote", () => {
      expect(applyMergePolicy("snapshot", "old", "new")).toBe("new");
    });

    it("shallow-merge: merges top-level keys", () => {
      const result = applyMergePolicy(
        "shallow-merge",
        { a: 1, b: 2 },
        { b: 3, c: 4 },
      );
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("union-by-id: unions and sorts arrays", () => {
      const result = applyMergePolicy(
        "union-by-id",
        ["alpha", "beta"],
        ["beta", "gamma"],
      );
      expect(result).toEqual(["alpha", "beta", "gamma"]);
    });

    it("union-by-id: falls back to remote for non-arrays", () => {
      expect(applyMergePolicy("union-by-id", "notarray", ["a"])).toEqual(["a"]);
    });
  });
});
