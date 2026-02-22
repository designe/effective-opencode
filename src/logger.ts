/**
 * Logger utility for effective-opencode plugin.
 *
 * Writes to both console AND a dedicated log file so that plugin logs
 * are always available even when opencode's server log doesn't capture
 * plugin console output.
 *
 * Log file location: ~/.local/share/opencode/effective-opencode.log
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_PREFIX = "[effective-opencode]";

// ── File logging setup ──────────────────────────────────────────────
const LOG_DIR = join(homedir(), ".local", "share", "opencode");
const LOG_FILE = join(LOG_DIR, "effective-opencode.log");

let fileLoggingEnabled = true;

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  fileLoggingEnabled = false;
}

function writeToFile(line: string): void {
  if (!fileLoggingEnabled) return;
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // If file write fails once, disable to avoid repeated errors
    fileLoggingEnabled = false;
  }
}

// ── Formatting ──────────────────────────────────────────────────────

/**
 * Check if a log level should be displayed
 */
function shouldLog(level: LogLevel): boolean {
  const envLevel = (process.env.OPENCODE_LOG_LEVEL ?? "info") as LogLevel;
  return LOG_LEVELS[level] >= LOG_LEVELS[envLevel];
}

/**
 * Serialize data for file logging (handles objects, errors, etc.)
 */
function serializeData(data: unknown): string {
  if (data === undefined || data === null || data === "") return "";
  if (data instanceof Error) {
    return ` ${data.message}${data.stack ? "\n" + data.stack : ""}`;
  }
  if (typeof data === "object") {
    try {
      return " " + JSON.stringify(data);
    } catch {
      return ` [unserializable: ${typeof data}]`;
    }
  }
  return " " + String(data);
}

/**
 * Format a log message with timestamp and prefix
 */
function formatMessage(level: LogLevel, context: string, message: string): string {
  const timestamp = new Date().toISOString();
  return `${timestamp} ${LOG_PREFIX} [${context}] ${level.toUpperCase()}: ${message}`;
}

export const logger = {
  debug(context: string, message: string, data?: unknown): void {
    const formatted = formatMessage("debug", context, message);
    // Always write debug to file (file is the primary debug channel)
    writeToFile(formatted + serializeData(data));
    if (shouldLog("debug")) {
      console.debug(formatted, data ?? "");
    }
  },

  info(context: string, message: string, data?: unknown): void {
    const formatted = formatMessage("info", context, message);
    writeToFile(formatted + serializeData(data));
    if (shouldLog("info")) {
      console.info(formatted, data ?? "");
    }
  },

  warn(context: string, message: string, data?: unknown): void {
    const formatted = formatMessage("warn", context, message);
    writeToFile(formatted + serializeData(data));
    if (shouldLog("warn")) {
      console.warn(formatted, data ?? "");
    }
  },

  error(context: string, message: string, error?: unknown): void {
    const formatted = formatMessage("error", context, message);
    const serialized = serializeData(error);
    writeToFile(formatted + serialized);
    if (shouldLog("error")) {
      const errorMsg = serialized.trim();
      const stack = error instanceof Error ? error.stack : undefined;
      console.error(formatted, errorMsg);
      if (stack && shouldLog("debug")) {
        console.debug(stack);
      }
    }
  },
};

/**
 * Create a context-bound logger for a specific module
 */
export function createContextLogger(context: string) {
  return {
    debug: (message: string, data?: unknown) => logger.debug(context, message, data),
    info: (message: string, data?: unknown) => logger.info(context, message, data),
    warn: (message: string, data?: unknown) => logger.warn(context, message, data),
    error: (message: string, error?: unknown) => logger.error(context, message, error),
  };
}

/** Path to the plugin log file (for display to user) */
export const LOG_FILE_PATH = LOG_FILE;
