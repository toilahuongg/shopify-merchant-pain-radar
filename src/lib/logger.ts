/** Structured JSON logging. Never logs secrets. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LogRecord {
  level: LogLevel;
  scope: string;
  event: string;
  ts: number;
  [field: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

/** Field names that must never be written to logs, even accidentally. */
const SECRET_FIELD_PATTERN =
  /(api[_-]?key|authorization|token|secret|password|bearer|webhook)/i;

function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "error" || record.level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_FIELD_PATTERN.test(key) ? "[redacted]" : value;
  }
  return out;
}

/** Redacts secret-looking substrings from free text (e.g. error messages). */
export function redactText(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
}

export interface LoggerOptions {
  sink?: LogSink;
  now?: () => number;
  secrets?: string[];
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => Date.now());
  const secrets = options.secrets ?? [];

  const write = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    const redacted = redactFields(fields);
    for (const [key, value] of Object.entries(redacted)) {
      if (typeof value === "string") redacted[key] = redactText(value, secrets);
    }
    sink({ level, scope, event, ts: now(), ...redacted });
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (childScope) => createLogger(`${scope}.${childScope}`, options),
  };
}

/** Collects log records in memory (tests / digest diagnostics). */
export function createMemorySink(): { sink: LogSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: (record) => records.push(record), records };
}
