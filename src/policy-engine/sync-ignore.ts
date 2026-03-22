import ignore from "ignore";

/** Default ignore patterns for sync. */
const DEFAULT_IGNORE_PATTERNS = [
  // OS junk
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "._*",
  "~$*",
  // Version control
  ".git/",
  ".gitignore",
  ".gitattributes",
  // Build artifacts & caches
  "node_modules/",
  ".cache/",
  "__pycache__/",
  "*.pyc",
  ".sass-cache/",
  // Temp files
  "*.tmp",
  "*.temp",
  "*.swp",
  "*.swo",
  "*~",
  // Trash
  ".trash/",
  ".Trash-*/",
];

/**
 * Creates a sync ignore checker.
 * @param configDir - The vault config directory name (default ".obsidian")
 * @param additionalPatterns - Extra ignore patterns
 */
export function createSyncIgnore(
  configDir = ".obsidian",
  additionalPatterns: string[] = [],
) {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS).add(additionalPatterns);

  return {
    /**
     * Check if a path should be ignored from sync.
     * Note: config dir paths are handled by the settings-sync allowlist,
     * not by the general ignore system.
     */
    isIgnored(path: string): boolean {
      if (!path) return true;
      return ig.ignores(path);
    },

    /**
     * Check if a path is inside the config directory.
     */
    isConfigPath(path: string): boolean {
      return path === configDir || path.startsWith(`${configDir}/`);
    },

    /**
     * Check if a path is a dot-prefixed top-level path that is not
     * the config directory itself.
     */
    isDotPrefixedExcluded(path: string): boolean {
      const firstSegment = path.split("/")[0] ?? "";
      if (!firstSegment.startsWith(".")) return false;
      // The config dir is allowlisted, everything else is excluded
      return firstSegment !== configDir;
    },
  };
}
