/**
 * Structured logger with component-scoped context.
 */
export class PluginLogger {
  private debugEnabled: boolean;
  private context: string;

  constructor(context: string, debugEnabled: boolean) {
    this.context = context;
    this.debugEnabled = debugEnabled;
  }

  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  child(subContext: string): PluginLogger {
    return new PluginLogger(`${this.context}:${subContext}`, this.debugEnabled);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.debugEnabled) {
      console.debug(`[${this.context}] ${message}`, data ?? "");
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.debugEnabled) {
      console.info(`[${this.context}] ${message}`, data ?? "");
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.debugEnabled) {
      console.warn(`[${this.context}] ${message}`, data ?? "");
    }
  }

  error(message: string, data?: Record<string, unknown>): void {
    console.error(`[${this.context}] ${message}`, data ?? "");
  }
}
