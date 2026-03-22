import { describe, expect, it } from "bun:test";
import { createSyncIgnore } from "../../src/policy-engine/sync-ignore";

describe("sync-ignore", () => {
  const ig = createSyncIgnore(".obsidian");

  it("ignores .DS_Store", () => {
    expect(ig.isIgnored(".DS_Store")).toBe(true);
  });

  it("ignores Thumbs.db", () => {
    expect(ig.isIgnored("Thumbs.db")).toBe(true);
  });

  it("ignores .git/", () => {
    expect(ig.isIgnored(".git/config")).toBe(true);
  });

  it("ignores node_modules/", () => {
    expect(ig.isIgnored("node_modules/package/index.js")).toBe(true);
  });

  it("does not ignore normal files", () => {
    expect(ig.isIgnored("notes/hello.md")).toBe(false);
  });

  it("detects config paths", () => {
    expect(ig.isConfigPath(".obsidian/app.json")).toBe(true);
    expect(ig.isConfigPath("notes/file.md")).toBe(false);
  });

  it("detects dot-prefixed exclusions", () => {
    expect(ig.isDotPrefixedExcluded(".hidden/file")).toBe(true);
    expect(ig.isDotPrefixedExcluded(".obsidian/app.json")).toBe(false);
    expect(ig.isDotPrefixedExcluded("normal/file")).toBe(false);
  });
});
