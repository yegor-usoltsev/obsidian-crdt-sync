import type { TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { basename } from "pathe";

export type FileKind = "text" | "binary" | "directory";
export const MAX_SYNC_FILE_BYTES = 90 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "base",
  "bash",
  "bat",
  "c",
  "canvas",
  "cc",
  "cfg",
  "cjs",
  "cmd",
  "conf",
  "cpp",
  "css",
  "csv",
  "fish",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "less",
  "log",
  "lua",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "php",
  "ps1",
  "py",
  "r",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svg",
  "text",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const BINARY_EXTENSIONS = new Set([
  "3gp",
  "7z",
  "aac",
  "avi",
  "avif",
  "bin",
  "bmp",
  "bz2",
  "class",
  "dat",
  "dll",
  "doc",
  "docx",
  "dylib",
  "epub",
  "exe",
  "flac",
  "gif",
  "gz",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "m4a",
  "m4v",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "odp",
  "ods",
  "odt",
  "ogg",
  "ogv",
  "opus",
  "otf",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "rar",
  "so",
  "tar",
  "tif",
  "tiff",
  "ttf",
  "wasm",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "xz",
  "zip",
]);

function detectFileKindByName(filename: string): FileKind | null {
  const base = basename(filename).toLowerCase();
  const parts = base.split(".").filter(Boolean).reverse();

  for (const ext of parts) {
    if (TEXT_EXTENSIONS.has(ext)) return "text";
    if (BINARY_EXTENSIONS.has(ext)) return "binary";
  }

  return null;
}

function detectFileKindByContent(data: ArrayBuffer | Uint8Array): FileKind {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (bytes.length === 0) return "text";

  if (hasUtf8Bom(bytes)) return "text";
  if (hasUtf16Bom(bytes)) return "text";

  if (containsZeroByte(bytes)) return "binary";

  const samples = getSamples(bytes, 24);
  for (const sample of samples) {
    if (!looksLikeText(sample)) return "binary";
  }

  return "text";
}

async function detectFileKind(
  filename: string,
  read: () => Promise<ArrayBuffer | Uint8Array>,
): Promise<FileKind> {
  const byName = detectFileKindByName(filename);
  if (byName !== null) return byName;

  const data = await read();
  return detectFileKindByContent(data);
}

export async function detectVaultFileKind(
  vault: Vault,
  file: TAbstractFile,
): Promise<FileKind> {
  if (isVaultFolder(file)) {
    return "directory";
  }
  if (!isVaultFile(file)) {
    throw new Error(`Unsupported vault entry "${file.path}"`);
  }

  return detectFileKind(file.name, () => vault.readBinary(file));
}

export function coerceFileKind(value: unknown): FileKind | undefined {
  return value === "text" || value === "binary" || value === "directory"
    ? value
    : undefined;
}

export function isVaultFile(value: unknown): value is TFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "extension" in value &&
    typeof value.extension === "string"
  );
}

export function isVaultEntry(value: unknown): value is TFile | TFolder {
  return isVaultFile(value) || isVaultFolder(value);
}

function isVaultFolder(value: unknown): value is TFolder {
  return (
    typeof value === "object" &&
    value !== null &&
    "children" in value &&
    Array.isArray(value.children)
  );
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  );
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff))
  );
}

function containsZeroByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x00) return true;
  }
  return false;
}

function getSamples(bytes: Uint8Array, size: number): Uint8Array[] {
  if (bytes.length <= size) return [bytes];

  const start = bytes.subarray(0, size);
  const middleStart = Math.max(
    0,
    Math.floor(bytes.length / 2) - Math.floor(size / 2),
  );
  const middle = bytes.subarray(
    middleStart,
    Math.min(bytes.length, middleStart + size),
  );
  const endStart = Math.max(0, bytes.length - size);
  const end = bytes.subarray(endStart);

  return [start, middle, end];
}

function looksLikeText(sample: Uint8Array): boolean {
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === undefined) {
      continue;
    }
    const isAllowedControl =
      b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c;

    if (!isAllowedControl && b < 0x20) {
      return false;
    }
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}
