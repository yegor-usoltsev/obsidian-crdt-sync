import { describe, expect, it } from "bun:test";
import { EchoPrevention } from "../../src/bootstrap-repair/echo-prevention";

describe("echo-prevention", () => {
  it("suppresses echoed writes", () => {
    const ep = new EchoPrevention();
    ep.markWritten("test.md");
    expect(ep.consumeWrite("test.md")).toBe(true);
    expect(ep.consumeWrite("test.md")).toBe(false); // consumed
  });

  it("suppresses echoed deletes", () => {
    const ep = new EchoPrevention();
    ep.markDeleted("test.md");
    expect(ep.consumeDelete("test.md")).toBe(true);
    expect(ep.consumeDelete("test.md")).toBe(false);
  });

  it("suppresses echoed renames", () => {
    const ep = new EchoPrevention();
    ep.markRenamed("old.md", "new.md");
    expect(ep.consumeRename("old.md", "new.md")).toBe(true);
    expect(ep.consumeRename("old.md", "new.md")).toBe(false);
  });

  it("does not suppress non-echoed events", () => {
    const ep = new EchoPrevention();
    expect(ep.consumeWrite("test.md")).toBe(false);
    expect(ep.consumeDelete("test.md")).toBe(false);
    expect(ep.consumeRename("a.md", "b.md")).toBe(false);
  });

  it("does not suppress rename with wrong target", () => {
    const ep = new EchoPrevention();
    ep.markRenamed("old.md", "expected.md");
    expect(ep.consumeRename("old.md", "different.md")).toBe(false);
  });

  it("clears all state", () => {
    const ep = new EchoPrevention();
    ep.markWritten("a.md");
    ep.markDeleted("b.md");
    ep.markRenamed("c.md", "d.md");
    ep.clear();
    expect(ep.consumeWrite("a.md")).toBe(false);
    expect(ep.consumeDelete("b.md")).toBe(false);
    expect(ep.consumeRename("c.md", "d.md")).toBe(false);
  });
});
