/** Prints a human summary of the live memory + activity log. Usage: node test/inspect.js [baseUrl] */
const base = (process.argv[2] || "http://127.0.0.1:7688").replace(/\/$/, "");

const [stats, graph, logs] = await Promise.all([
  fetch(`${base}/api/stats`).then((r) => r.json()),
  fetch(`${base}/api/graph`).then((r) => r.json()),
  fetch(`${base}/api/logs?after=0`).then((r) => r.json()),
]);

console.log(`memory: ${stats.entities} entities, ${stats.observations} facts, ${stats.relations} relations\n`);

const agents = {};
for (const e of logs.entries.filter((e) => e.kind === "agent")) {
  const m = e.message.match(/\(([^,)]+)/);
  const who = m ? m[1] : "unknown";
  agents[who] = (agents[who] || 0) + 1;
}
console.log("connections:", JSON.stringify(agents));

const tools = logs.entries.filter((e) => e.kind === "tool");
const byTool = {};
for (const t of tools) byTool[t.message.split(" ")[0]] = (byTool[t.message.split(" ")[0]] || 0) + 1;
console.log("tool calls:", JSON.stringify(byTool));
const errors = logs.entries.filter((e) => e.kind === "error");
console.log(`errors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log("  !", e.message);

console.log("\n--- entities by type ---");
const byType = {};
for (const e of graph.entities) (byType[e.type] = byType[e.type] || []).push(e);
for (const [type, list] of Object.entries(byType)) {
  console.log(`\n[${type}] (${list.length})`);
  for (const e of list) {
    console.log(`  • ${e.name}`);
    for (const o of e.observations) console.log(`      - ${o.text.length > 110 ? o.text.slice(0, 110) + "…" : o.text}`);
  }
}

console.log("\n--- relations ---");
for (const r of graph.relations) console.log(`  ${r.from} -[${r.type}]-> ${r.to}`);
