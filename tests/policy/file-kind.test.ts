import { describe, expect, it } from "bun:test";
import {
  classifyFileKind,
  detectKindByContent,
  detectKindByExtension,
} from "../../src/policy-engine/file-kind";

describe("file-kind", () => {
  describe("detectKindByExtension", () => {
    it("classifies .md as text", () => {
      expect(detectKindByExtension("notes/hello.md")).toBe("text");
    });

    it("classifies .png as binary", () => {
      expect(detectKindByExtension("images/photo.png")).toBe("binary");
    });

    it("classifies .json as text", () => {
      expect(detectKindByExtension("config/data.json")).toBe("text");
    });

    it("classifies .pdf as binary", () => {
      expect(detectKindByExtension("docs/paper.pdf")).toBe("binary");
    });

    it("returns undefined for unknown extensions", () => {
      expect(detectKindByExtension("file.xyz123")).toBeUndefined();
    });

    it("returns undefined for no extension", () => {
      expect(detectKindByExtension("README")).toBeUndefined();
    });
  });

  describe("detectKindByContent", () => {
    it("detects text content", () => {
      const content = new TextEncoder().encode("Hello, world!").buffer;
      expect(detectKindByContent(content)).toBe("text");
    });

    it("detects binary content (null bytes)", () => {
      const content = new Uint8Array([0x48, 0x65, 0x00, 0x6c]).buffer;
      expect(detectKindByContent(content)).toBe("binary");
    });
  });

  describe("classifyFileKind", () => {
    it("uses extension when known", () => {
      expect(classifyFileKind("test.md")).toBe("text");
      expect(classifyFileKind("test.png")).toBe("binary");
    });

    it("falls back to content sniffing for unknown extensions", () => {
      const textContent = new TextEncoder().encode("plain text").buffer;
      expect(classifyFileKind("file.xyz", textContent)).toBe("text");
    });

    it("defaults to text without content", () => {
      expect(classifyFileKind("file.xyz")).toBe("text");
    });
  });
});
