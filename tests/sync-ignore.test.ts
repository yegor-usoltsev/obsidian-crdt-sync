import { describe, expect, test } from "bun:test";
import { isIgnoredSyncPath } from "../src/sync-ignore";

describe("isIgnoredSyncPath", () => {
  test("ignores the active vault config directory", () => {
    expect(isIgnoredSyncPath(".config/workspace.json", "file", ".config")).toBe(
      true,
    );
    expect(isIgnoredSyncPath(".config/plugins", "directory", ".config")).toBe(
      true,
    );
  });

  test("does not hardcode .obsidian when the vault uses a custom config directory", () => {
    expect(
      isIgnoredSyncPath(".obsidian/workspace.json", "file", ".config"),
    ).toBe(false);
  });
});
