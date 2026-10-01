import { redactUrl } from "./util.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  stream?: NodeJS.WritableStream;
}

function coerceLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
    return value;
  }
  return "info";
}

const REDACT_KEY = /(url|token|password|secret|passwd|pwd)/i;

/** Recursively redact credential-looking values before they hit the log stream. */
function redactValue(key: string, value: unknown): unknown {
  if (typeof value === "string" && REDACT_KEY.test(key)) {
    if (key.toLowerCase().includes("url")) return redactUrl(value);
    return "***";
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value instanceof Error) return serializeError(value);
  return value;
}

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") out.code = code;
  if (err.stack) out.stack = err.stack;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) out.cause = serializeError(cause);
  return out;
}

function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactValue(key, value);
  }
  return out;
}

class LoggerImpl implements Logger {
  readonly #level: LogLevel;
  readonly #json: boolean;
  readonly #stream: NodeJS.WritableStream;
  readonly #base: Record<string, unknown>;

  constructor(level: LogLevel, json: boolean, stream: NodeJS.WritableStream, base: Record<string, unknown>) {
    this.#level = level;
    this.#json = json;
    this.#stream = stream;
    this.#base = base;
  }

  child(fields: Record<string, unknown>): Logger {
    return new LoggerImpl(this.#level, this.#json, this.#stream, { ...this.#base, ...fields });
  }

  #write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;
    const merged = { ...this.#base, ...redactFields(fields) };
    if (this.#json) {
      const record = { time: new Date().toISOString(), level, msg: message, ...merged };
      this.#stream.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const time = new Date().toISOString().slice(11, 19);
    const extras = Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    this.#stream.write(`${time} ${level.toUpperCase().padEnd(5)} ${message}${extras ? ` ${extras}` : ""}\n`);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.#write("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.#write("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.#write("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.#write("error", message, fields);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? coerceLevel(process.env.LOG_LEVEL);
  const json = options.json ?? process.env.LOG_FORMAT === "json";
  const stream = options.stream ?? process.stderr;
  return new LoggerImpl(level, json, stream, {});
}
