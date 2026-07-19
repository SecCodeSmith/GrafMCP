import fs from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 1000;

export function createLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "activity.jsonl");
  const entries = [];
  let seq = 0;
  let writeFailed = false;

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
    process.stderr.write(`[graf-mcp] ${entry.ts} ${kind}: ${message}\n`);
    return entry;
  }

  function since(afterSeq) {
    return entries.filter((e) => e.seq > afterSeq);
  }

  return { log, since, get lastSeq() { return seq; }, logFile };
}
