/**
 * Quick check against a running daemon/container over Streamable HTTP.
 *
 * Usage: node test/http-check.js [write|read] [baseUrl]
 *   write — list tools and store a test fact
 *   read  — recall the test fact (e.g. after a container restart)
 * Default baseUrl: http://127.0.0.1:7688
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mode = process.argv[2] || "write";
const base = (process.argv[3] || "http://127.0.0.1:7688").replace(/\/$/, "");

const client = new Client({ name: "http-check", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));

if (mode === "write") {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log("tools:", tools.join(","));
  await client.callTool({
    name: "remember",
    arguments: { entity: "Docker Test", entity_type: "fact", observations: ["stored inside the container"] },
  });
  console.log("stored ok");
} else {
  const r = await client.callTool({ name: "recall", arguments: { query: "docker" } });
  const m = JSON.parse(r.content[0].text);
  console.log("recall:", m.matches?.[0]?.name, "-", m.matches?.[0]?.observations?.[0]?.text);
}
await client.close();
