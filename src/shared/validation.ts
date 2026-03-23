/**
 * Config validation: server URL and auth token rules.
 * Pure functions — no Obsidian dependency.
 */

/**
 * Validate a server URL for sync.
 * Remote: must be wss://
 * Loopback: ws:// allowed for 127.0.0.1, ::1, localhost
 */
export function validateServerUrl(url: string): string | null {
  if (!url) return "Server URL is required";
  if (url.length > 2048) return "URL too long (max 2048 characters)";

  try {
    const parsed = new URL(url);
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1";
    if (parsed.protocol === "wss:") return null;
    if (parsed.protocol === "ws:" && isLoopback) return null;
    if (parsed.protocol === "ws:") {
      return "Insecure ws:// only allowed for loopback addresses (localhost, 127.0.0.1, ::1)";
    }
    return "URL must use wss:// (or ws:// for loopback only)";
  } catch {
    return "Invalid URL format";
  }
}

/**
 * Validate an auth token.
 * Must be at least 32 characters.
 */
export function validateAuthToken(token: string): string | null {
  if (!token) return "Auth token is required";
  if (token.length < 32) return "Auth token must be at least 32 characters";
  if (token.length > 1024) return "Auth token too long (max 1024 characters)";
  return null;
}
