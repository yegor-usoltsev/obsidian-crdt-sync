import type { FileKind } from "../shared/types";

/** Known text file extensions (lowercase, no dot). */
const TEXT_EXTENSIONS = new Set([
  // Markdown & notes
  "md",
  "markdown",
  "txt",
  "text",
  "rtf",
  // Web
  "html",
  "htm",
  "xhtml",
  "xml",
  "svg",
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  // Programming
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "env",
  // Scripting
  "py",
  "rb",
  "pl",
  "pm",
  "lua",
  "sh",
  "bash",
  "zsh",
  "fish",
  "bat",
  "cmd",
  "ps1",
  "psm1",
  // Compiled
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cxx",
  "hxx",
  "cs",
  "java",
  "kt",
  "kts",
  "scala",
  "go",
  "rs",
  "swift",
  "m",
  "mm",
  "d",
  "zig",
  "nim",
  "v",
  "ex",
  "exs",
  "erl",
  "hrl",
  "hs",
  "lhs",
  "ml",
  "mli",
  "fs",
  "fsx",
  "fsi",
  "clj",
  "cljs",
  "cljc",
  "edn",
  "r",
  "R",
  "jl",
  "dart",
  "groovy",
  "gradle",
  // Data & config
  "csv",
  "tsv",
  "sql",
  "graphql",
  "gql",
  "proto",
  "thrift",
  "avsc",
  // Docs
  "tex",
  "latex",
  "bib",
  "org",
  "rst",
  "adoc",
  "asciidoc",
  "wiki",
  "mediawiki",
  // Misc text
  "log",
  "diff",
  "patch",
  "gitignore",
  "gitattributes",
  "editorconfig",
  "dockerignore",
  "makefile",
  "cmake",
  "dockerfile",
  "vagrantfile",
  "gemfile",
  "rakefile",
  "podfile",
  "sbt",
  "cabal",
  "opam",
  "nix",
  "dhall",
  "hcl",
  "tf",
  "tfvars",
  "plist",
  "manifest",
  "lock",
  "sum",
]);

/** Known binary file extensions (lowercase, no dot). */
const BINARY_EXTENSIONS = new Set([
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "avif",
  "tiff",
  "tif",
  "psd",
  "ai",
  "eps",
  "raw",
  "cr2",
  "nef",
  "heic",
  "heif",
  // Audio
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "wma",
  "aiff",
  "opus",
  // Video
  "mp4",
  "avi",
  "mov",
  "mkv",
  "wmv",
  "flv",
  "webm",
  "m4v",
  "3gp",
  // Archives
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "zst",
  "lz4",
  // Documents
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "epub",
  // Executables & libraries
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "lib",
  "wasm",
  "class",
  "pyc",
  "pyo",
  // Fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  // Database
  "sqlite",
  "sqlite3",
  "db",
  "mdb",
  // Other binary
  "bin",
  "dat",
  "iso",
  "dmg",
  "img",
  "deb",
  "rpm",
  "apk",
  "ipa",
]);

/**
 * Detect file kind by extension. Returns undefined if unknown.
 */
export function detectKindByExtension(path: string): FileKind | undefined {
  const lastDot = path.lastIndexOf(".");
  if (lastDot < 0) return undefined;
  const ext = path.slice(lastDot + 1).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  return undefined;
}

/**
 * Detect if content is binary by checking for null bytes and invalid UTF-8.
 * Checks the first 8KB of content.
 */
export function detectKindByContent(content: ArrayBuffer): FileKind {
  const bytes = new Uint8Array(content, 0, Math.min(content.byteLength, 8192));
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return "binary";
  }
  return "text";
}

/**
 * Determine file kind using extension first, then content sniffing fallback.
 */
export function classifyFileKind(
  path: string,
  content?: ArrayBuffer,
): FileKind {
  const byExt = detectKindByExtension(path);
  if (byExt !== undefined) return byExt;
  if (content) return detectKindByContent(content);
  // Default to text for unknown extensions without content
  return "text";
}
