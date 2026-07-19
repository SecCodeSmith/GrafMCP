// Restores a memory snapshot (made by src/backup.js or /api/graph) into the
// database. The daemon must be STOPPED first (npm run stop) — this process
// needs exclusive access to the database files.
// Usage: node src/restore.js <snapshot.json>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphDB } from "./db.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2];
if (!file) {
  console.error("usage: node src/restore.js <snapshot.json>");
  process.exit(1);
}
const snap = JSON.parse(fs.readFileSync(file, "utf8"));
const dbPath = process.env.GRAF_MCP_DB || path.join(ROOT, "data", "graph.kuzu");

const db = new GraphDB(dbPath);
await db.init();

let facts = 0;
for (const e of snap.entities) {
  await db.q(
    `MERGE (x:Entity {name: $name})
     SET x.type = $type, x.created = $created, x.updated = $updated`,
    { name: e.name, type: e.type || "note", created: e.created || "", updated: e.updated || "" }
  );
  for (const o of e.observations || []) {
    await db.q(
      `MATCH (x:Entity {name: $name})
       CREATE (o:Observation {text: $text, created: $created}), (x)-[:HAS_OBSERVATION]->(o)`,
      { name: e.name, text: o.text, created: o.created || "" }
    );
    facts++;
  }
}
for (const r of snap.relations) {
  await db.q(
    `MATCH (a:Entity {name: $from}), (b:Entity {name: $to})
     MERGE (a)-[rel:RELATES {type: $type}]->(b)
     ON CREATE SET rel.created = $created`,
    { from: r.from, to: r.to, type: r.type, created: r.created || "" }
  );
}
console.log(`restored into ${dbPath}: ${snap.entities.length} entities, ${facts} facts, ${snap.relations.length} relations`);
process.exit(0);
