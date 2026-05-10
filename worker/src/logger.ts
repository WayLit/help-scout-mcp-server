/**
 * Structured logger.
 *
 * Workers captures `console.error` / `console.log` automatically — `wrangler tail`
 * picks them up in real time, and Logpush can ship them off-platform. Emit JSON
 * so downstream tooling can filter/aggregate.
 *
 * `LOG_LEVEL` env var follows stdio: error | warn | info | debug.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface LogContext {
  requestId?: string;
  email?: string;
  toolName?: string;
  duration?: number;
  [key: string]: unknown;
}

class Logger {
  private currentLevel: LogLevel = "info";

  setLevel(level: string | undefined): void {
    if (level && level in LEVEL_PRIORITY) {
      this.currentLevel = level as LogLevel;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[this.currentLevel];
  }

  private log(level: LogLevel, message: string, ctx: LogContext = {}): void {
    if (!this.shouldLog(level)) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...ctx,
    };
    // Workers maps console.error → ERROR severity in Logs / Tail / Logpush.
    if (level === "error") {
      console.error(JSON.stringify(entry));
    } else if (level === "warn") {
      console.warn(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  error(message: string, ctx: LogContext = {}): void {
    this.log("error", message, ctx);
  }
  warn(message: string, ctx: LogContext = {}): void {
    this.log("warn", message, ctx);
  }
  info(message: string, ctx: LogContext = {}): void {
    this.log("info", message, ctx);
  }
  debug(message: string, ctx: LogContext = {}): void {
    this.log("debug", message, ctx);
  }
}

export const logger = new Logger();

export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}
