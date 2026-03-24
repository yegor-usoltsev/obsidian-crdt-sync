/**
 * Settings sync policy: allowlist, merge rules, and config directory handling.
 */

/** Merge policy for a settings file. */
export type MergePolicy =
  | "shallow-merge"
  | "replace"
  | "union-by-id"
  | "snapshot";

/** A settings file entry in the allowlist. */
export interface SettingsFilePolicy {
  /** Glob-like pattern relative to config dir. */
  pattern: string;
  /** Merge policy to apply. */
  policy: MergePolicy;
  /** Human-readable description. */
  description: string;
}

/** Day-one settings allowlist with merge policies. */
export const SETTINGS_ALLOWLIST: SettingsFilePolicy[] = [
  { pattern: "app.json", policy: "shallow-merge", description: "App settings" },
  {
    pattern: "types.json",
    policy: "replace",
    description: "Custom file types",
  },
  {
    pattern: "appearance.json",
    policy: "shallow-merge",
    description: "Appearance settings",
  },
  {
    pattern: "hotkeys.json",
    policy: "replace",
    description: "Hotkey bindings",
  },
  {
    pattern: "core-plugins.json",
    policy: "union-by-id",
    description: "Core plugin enablement",
  },
  {
    pattern: "core-plugins-migration.json",
    policy: "replace",
    description: "Core plugins migration state",
  },
  {
    pattern: "community-plugins.json",
    policy: "union-by-id",
    description: "Community plugin enablement",
  },
  {
    pattern: "plugins/*/data.json",
    policy: "replace",
    description: "Plugin data",
  },
  {
    pattern: "plugins/*/manifest.json",
    policy: "snapshot",
    description: "Plugin package manifest",
  },
  {
    pattern: "plugins/*/main.js",
    policy: "snapshot",
    description: "Plugin package code",
  },
  {
    pattern: "plugins/*/styles.css",
    policy: "snapshot",
    description: "Plugin package styles",
  },
  {
    pattern: "themes/*/manifest.json",
    policy: "snapshot",
    description: "Theme manifest",
  },
  {
    pattern: "themes/*/theme.css",
    policy: "snapshot",
    description: "Theme stylesheet",
  },
  {
    pattern: "snippets/*.css",
    policy: "snapshot",
    description: "CSS snippets",
  },
];

/** Workspace files explicitly excluded from sync. */
const WORKSPACE_EXCLUSIONS = ["workspace.json", "workspace-mobile.json"];

/**
 * Check if a config-relative path is in the settings sync allowlist.
 * @param configRelativePath - Path relative to the config directory
 */
export function isAllowlistedSettingsFile(
  configRelativePath: string,
): SettingsFilePolicy | undefined {
  // Check workspace exclusions first
  if (WORKSPACE_EXCLUSIONS.includes(configRelativePath)) return undefined;

  for (const entry of SETTINGS_ALLOWLIST) {
    if (matchSettingsPattern(entry.pattern, configRelativePath)) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Apply a merge policy to local and remote JSON values.
 */
export function applyMergePolicy(
  policy: MergePolicy,
  local: unknown,
  remote: unknown,
): unknown {
  switch (policy) {
    case "replace":
    case "snapshot":
      return remote;

    case "shallow-merge":
      if (isPlainObject(local) && isPlainObject(remote)) {
        return { ...local, ...remote };
      }
      return remote;

    case "union-by-id": {
      if (!Array.isArray(local) || !Array.isArray(remote)) {
        return remote;
      }
      const set = new Set<string>([...local, ...remote]);
      return Array.from(set).sort();
    }
  }
}

/** Match a simple glob pattern with single * wildcards. */
function matchSettingsPattern(pattern: string, path: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === path;

  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < parts.length guarantees defined
    const part = parts[i]!;
    if (i === 0) {
      if (!path.startsWith(part)) return false;
      pos = part.length;
    } else if (i === parts.length - 1) {
      if (!path.endsWith(part)) return false;
      if (path.length - part.length < pos) return false;
    } else {
      const idx = path.indexOf(part, pos);
      if (idx < 0) return false;
      pos = idx + part.length;
    }
  }
  return true;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
