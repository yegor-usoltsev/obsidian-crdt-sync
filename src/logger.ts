type LogLevel = "debug" | "info" | "warn" | "error";
type LogContext = Record<string, unknown>;

export class PluginLogger {
  private readonly state: { enabled: boolean };

  constructor(
    enabled = false,
    private readonly defaultContext: LogContext = {},
    state?: { enabled: boolean },
  ) {
    this.state = state ?? { enabled };
  }

  setEnabled(enabled: boolean): void {
    this.state.enabled = enabled;
  }

  child(defaultContext: LogContext): PluginLogger {
    return new PluginLogger(
      false,
      {
        ...this.defaultContext,
        ...defaultContext,
      },
      this.state,
    );
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }

  private write(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (!this.state.enabled && level !== "warn" && level !== "error") return;
    const mergedContext = Object.fromEntries(
      Object.entries({
        ...this.defaultContext,
        ...context,
      }).filter(([, value]) => value !== undefined),
    );
    const line = Object.keys(mergedContext).length
      ? `[crdt-sync] ${message} ${JSON.stringify(mergedContext)}`
      : `[crdt-sync] ${message}`;
    (level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log)(line);
  }
}
