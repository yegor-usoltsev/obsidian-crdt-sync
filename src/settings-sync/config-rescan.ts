/**
 * Config directory rescan: dedicated discovery for allowlisted settings files.
 * Supplements vault events which may not reliably cover config-dir changes.
 */

import type { TFile, Vault } from "obsidian";
import {
  isAllowlistedSettingsFile,
  type SettingsFilePolicy,
} from "./settings-policy";

export interface ConfigRescanResult {
  /** Allowlisted files found in the config directory. */
  files: {
    file: TFile;
    configRelativePath: string;
    policy: SettingsFilePolicy;
  }[];
}

/**
 * Scan the config directory for allowlisted settings files.
 * @param vault - The Obsidian vault
 * @param configDir - The config directory name (default ".obsidian")
 */
export function rescanConfigDirectory(
  vault: Vault,
  configDir = ".obsidian",
): ConfigRescanResult {
  const files: ConfigRescanResult["files"] = [];

  const allFiles = vault.getFiles();
  for (const file of allFiles) {
    if (!file.path.startsWith(`${configDir}/`)) continue;

    const configRelativePath = file.path.slice(configDir.length + 1);
    const policy = isAllowlistedSettingsFile(configRelativePath);
    if (policy) {
      files.push({ file, configRelativePath, policy });
    }
  }

  return { files };
}
