// CLI wrapper around POST /api/cleanup. Usage: node src/cleanup-cli.js [workspace]
// Omit workspace to clean every workspace.
const port = process.env.GRAF_MCP_PORT || 7688;
const workspace = process.argv[2];

const res = await fetch(`http://127.0.0.1:${port}/api/cleanup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(workspace ? { workspace } : {}),
});
if (!res.ok) {
  console.error(`cleanup failed: HTTP ${res.status} (is the daemon running? try 'npm start')`);
  process.exit(1);
}
const r = await res.json();
console.log(
  `cleanup (workspace: ${r.workspace}): removed ${r.duplicateObservationsRemoved} duplicate fact(s), ${r.orphanObservationsRemoved} orphan record(s)`
);
