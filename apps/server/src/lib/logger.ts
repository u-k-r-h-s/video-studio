import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = "info";
let quiet = false;
export function setLogLevel(level: Level): void {
  minLevel = level;
}
/** Tests silence console output. */
export function setLogQuiet(value: boolean): void {
  quiet = value;
}

export type Fields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

/** key=value rendering: `project=abc stage=image_generation scene=scene-02 status=started`. */
export function formatFields(fields: Fields = {}): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" && /[\s"]/.test(v) ? JSON.stringify(v) : v}`)
    .join(" ");
}

export function createLogger(scope: string): Logger {
  const write = (level: Level, msg: string, fields?: Fields) => {
    if (quiet || ORDER[level] < ORDER[minLevel]) return;
    const tail = fields ? ` ${formatFields(fields)}` : "";
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

/** Append-only JSON-lines sink for a project's pipeline log. */
export class JsonlSink {
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(record: Record<string, unknown>): void {
    try {
      fs.appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
    } catch {
      /* logging must never break the pipeline */
    }
  }
}
