/**
 * Client transport configuration validation.
 * Remote: requires secure transport (wss://)
 * Loopback: allows insecure (ws://) for 127.0.0.1, ::1, localhost
 */

export interface TransportConfig {
  wsUrl: string;
  httpBaseUrl: string;
  isSecure: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Validate and derive transport configuration from a server URL.
 * Returns config or an error message.
 */
export function validateTransportConfig(
  serverUrl: string,
): TransportConfig | { error: string } {
  if (!serverUrl) return { error: "Server URL is required" };
  if (serverUrl.length > 2048)
    return { error: "URL too long (max 2048 characters)" };

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return { error: "Invalid URL format" };
  }

  // Normalize hostname: strip brackets from IPv6 (e.g., [::1] → ::1)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const isLoopback = LOOPBACK_HOSTS.has(hostname);

  if (parsed.protocol === "wss:") {
    // Secure WebSocket — always allowed
    const httpBase = `https://${parsed.host}${parsed.pathname}`.replace(
      /\/$/,
      "",
    );
    return {
      wsUrl: serverUrl,
      httpBaseUrl: httpBase,
      isSecure: true,
    };
  }

  if (parsed.protocol === "ws:") {
    if (!isLoopback) {
      return {
        error:
          "Insecure ws:// only allowed for loopback addresses (localhost, 127.0.0.1, ::1). Use wss:// for remote servers.",
      };
    }
    const httpBase = `http://${parsed.host}${parsed.pathname}`.replace(
      /\/$/,
      "",
    );
    return {
      wsUrl: serverUrl,
      httpBaseUrl: httpBase,
      isSecure: false,
    };
  }

  return { error: "URL must use wss:// or ws:// protocol" };
}
