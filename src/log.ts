import { escapeControls } from "./catalog/text.js";

export type Level = "error" | "warn" | "info" | "debug";
const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const COUNTS = [
  "documents",
  "notIndexed",
  "collisions",
  "encodedFolders",
  "admitted",
  "refused",
  "degraded",
  "ms",
] as const;

/**
 * The closed allowlist of fields per event. Nothing outside it is written, so no question, path argument, title,
 * body or snippet can reach the log through any event.
 */
const ALLOWED: Record<string, readonly string[]> = {
  "serve.start": ["company", "source", "lock", "dev", "node", "configRule", "note"],
  "serve.refusing": ["problem", "detail"],
  "serve.shutdown": ["reason"],
  "engine.reset": ["detail"],
  "load.done": COUNTS,
  "load.fatal": ["rule", "path", "detail"],
  "refresh.done": COUNTS,
  "refresh.fatal": ["rule", "path", "detail"],
  "refresh.failed": ["error"],
  "load.served-previous": ["commit", "refused"],
  "poller.tick": ["outcome", "ms", "error"],
  "source.recloned": ["reason"],
  "tool.call": ["tool", "ms", "hits", "engineQueries", "rowsFetched", "error"],
  "transport.error": ["error"],
  console: ["method", "text"],
};

export type Fields = Record<string, string | number | boolean | readonly string[] | undefined>;

/** The most characters a free-text field keeps; one error message cannot flood the log. */
export const LOG_VALUE_CAP = 2_000;
const clipValue = (value: string): string =>
  value.length <= LOG_VALUE_CAP ? value : `${value.slice(0, LOG_VALUE_CAP)}…`;

export interface Log {
  error(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  debug(event: string, fields?: Fields): void;
}

/** JSON lines on a stream, one object per line: `time`, `level`, `event`, then the event's allowed fields, control characters escaped. */
export function createLog(
  stream: { write(text: string): void },
  level: Level,
  clock: () => Date = () => new Date(),
): Log {
  const threshold = ORDER[level];
  const write = (at: Level, event: string, fields: Fields = {}): void => {
    if (ORDER[at] > threshold) return;
    const record: Record<string, unknown> = { time: clock().toISOString(), level: at, event };
    const allowed = ALLOWED[event] ?? [];
    for (const key of allowed) {
      const value = fields[key];
      if (value === undefined) continue;
      record[key] =
        typeof value === "string"
          ? escapeControls(clipValue(value))
          : Array.isArray(value)
            ? value.map((v) => escapeControls(clipValue(String(v))))
            : value;
    }
    stream.write(`${JSON.stringify(record)}\n`);
  };
  return {
    error: (event, fields) => write("error", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    info: (event, fields) => write("info", event, fields),
    debug: (event, fields) => write("debug", event, fields),
  };
}
