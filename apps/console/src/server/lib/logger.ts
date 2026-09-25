type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.LOG_LEVEL as Level) ?? "info";

export function setLogLevel(level: Level) {
  threshold = level;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serialize(value: unknown): unknown {
  if (value instanceof Error)
    return { message: value.message, name: value.name, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Minimal structured JSON logger (one line per event on stdout/stderr). */
export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[level] < order[threshold]) return;
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level, msg, ...base };
    for (const [k, v] of Object.entries(fields ?? {})) entry[k] = serialize(v);
    const line = JSON.stringify(entry);
    if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export const logger = createLogger({ service: "edgeweir-console" });
