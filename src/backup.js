// Saves a full snapshot of the live memory to a JSON file.
// Usage: node src/backup.js [outfile] (default: backups/memory-<date>.json)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.GRAF_MCP_PORT || 7688;
const out =
  process.argv[2] ||
  path.join(ROOT, "backups", `memory-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

const graph = await (await fetch(`http://127.0.0.1:${port}/api/graph`)).json();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(graph, null, 2));
const facts = graph.entities.reduce((n, e) => n + e.observations.length, 0);
console.log(`backup written: ${out} (${graph.entities.length} entities, ${facts} facts, ${graph.relations.length} relations)`);
