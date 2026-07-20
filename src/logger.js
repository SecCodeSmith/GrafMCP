import fs from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 1000;

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
};

const LOG_LEVEL_NAMES = ["debug", "info", "warning", "error"];

function parseLogLevel(level) {
  if (typeof level === "number" && level in LOG_LEVEL_NAMES) return level;
  const upper = String(level).toUpperCase();
  return LOG_LEVELS[upper] ?? LOG_LEVELS.INFO;
}

export function createLogger(logDir, initialLevel = "info") {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "activity.jsonl");
  const entries = [];
  let seq = 0;
  let writeFailed = false;
  let logLevel = parseLogLevel(initialLevel);

  function shouldLog(kind) {
    const kindLevel = LOG_LEVELS[kind.toUpperCase()] ?? LOG_LEVELS.INFO;
    return kindLevel >= logLevel;
  }

  function log(kind, message, data = undefined) {
    const entry = {
      seq: ++seq,
      ts: new Date().toISOString(),
      kind,
      message,
      ...(data !== undefined ? { data } : {}),
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    try {
      // recreate the directory if something removed it out from under us
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
      writeFailed = false;
    } catch (err) {
      // logging must never crash the server, but say so once on stderr
      if (!writeFailed) {
        writeFailed = true;
        process.stderr.write(`[graf-mcp] WARNING: cannot write ${logFile}: ${err.message}\n`);
      }
    }
    if (shouldLog(kind)) {
      process.stderr.write(`[graf-mcp] ${entry.ts} ${kind}: ${message}\n`);
    }
    return entry;
  }

  function since(afterSeq) {
    return entries.filter((e) => e.seq > afterSeq);
  }

  function setLevel(level) {
    const oldLevel = logLevel;
    logLevel = parseLogLevel(level);
    return { changed: oldLevel !== logLevel, from: LOG_LEVEL_NAMES[oldLevel], to: LOG_LEVEL_NAMES[logLevel] };
  }

  function getLevel() {
    return { level: LOG_LEVEL_NAMES[logLevel], numeric: logLevel };
  }

  return { log, since, get lastSeq() { return seq; }, logFile, setLevel, getLevel };
}
