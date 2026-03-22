import type { FileKind } from "../shared/types";
import { classifyFileKind } from "./file-kind";
import { createSyncIgnore } from "./sync-ignore";

/** Size limits by file class (bytes). */
export const SIZE_LIMITS = {
  /** Metadata request payload limit. */
  metadata: 256 * 1024, // 256 KiB
  /** Maximum content payload per file. */
  content: 200 * 1024 * 1024, // 200 MiB
} as const;

/** Result of sync eligibility check. */
export type SyncEligibility =
  | { eligible: true; kind: FileKind }
  | { eligible: false; reason: string };

export interface FilePolicyEngine {
  /** Check whether a vault path is eligible for sync. */
  checkEligibility(path: string, size?: number): SyncEligibility;
  /** Classify a file's kind. */
  classifyKind(path: string, content?: ArrayBuffer): FileKind;
  /** Check if path is inside the config directory. */
  isConfigPath(path: string): boolean;
}

/**
 * Creates a file policy engine for determining sync eligibility and
 * file classification.
 */
export function createFilePolicyEngine(
  configDir = ".obsidian",
): FilePolicyEngine {
  const syncIgnore = createSyncIgnore(configDir);

  return {
    checkEligibility(path: string, size?: number): SyncEligibility {
      // Empty path
      if (!path || path.trim() === "") {
        return { eligible: false, reason: "empty path" };
      }

      // Unsafe path components
      if (hasUnsafePathComponents(path)) {
        return { eligible: false, reason: "unsafe path" };
      }

      // Absolute paths rejected
      if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        return { eligible: false, reason: "absolute path" };
      }

      // General ignore patterns
      if (syncIgnore.isIgnored(path)) {
        return { eligible: false, reason: "ignored by sync policy" };
      }

      // Dot-prefixed top-level (except config dir)
      if (syncIgnore.isDotPrefixedExcluded(path)) {
        return {
          eligible: false,
          reason: "dot-prefixed top-level path excluded",
        };
      }

      // Config dir paths: handled by settings-sync allowlist
      if (syncIgnore.isConfigPath(path)) {
        // node_modules under config dir always rejected
        if (path.includes("/node_modules/") || path.endsWith("/node_modules")) {
          return {
            eligible: false,
            reason: "node_modules under config directory",
          };
        }
        // Let settings-sync decide for allowlisted files
        return { eligible: true, kind: classifyFileKind(path) };
      }

      // Size limit check
      if (size !== undefined && size > SIZE_LIMITS.content) {
        return {
          eligible: false,
          reason: `file exceeds size limit (${size} > ${SIZE_LIMITS.content} bytes)`,
        };
      }

      const kind = classifyFileKind(path);
      return { eligible: true, kind };
    },

    classifyKind(path: string, content?: ArrayBuffer): FileKind {
      return classifyFileKind(path, content);
    },

    isConfigPath(path: string): boolean {
      return syncIgnore.isConfigPath(path);
    },
  };
}

/** Check for path traversal and invalid segments. */
function hasUnsafePathComponents(path: string): boolean {
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "..") return true;
    if (seg === ".") return true;
    if (seg === "") continue; // trailing slashes
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char detection
    if (/[\x00-\x1f\x7f]/.test(seg)) return true;
  }
  return false;
}
