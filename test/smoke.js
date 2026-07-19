/**
 * End-to-end smoke test: talks to the stdio bridge exactly like a code agent
 * (MCP client over stdio), which auto-starts the daemon, then checks the
 * dashboard HTTP API, then shuts the test daemon down.
 *
 * Usage: node test/smoke.js
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = 7699;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "graf-mcp-test-"));
const DB = path.join(TMP, "graph.kuzu");

let failures = 0;
function check(name, cond, extra = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : " — " + extra}`);
  if (!ok) failures++;
}
const text = (r) => r.content?.[0]?.text ?? "";
const parsed = (r) => JSON.parse(text(r));

async function main() {
  // make sure no daemon from a previous test run owns the port
  try { await fetch(`${BASE}/api/shutdown`, { method: "POST" }); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  // GRAF_MCP_WORKSPACE pins the bridge's auto-workspace to "default" so these
  // assertions keep their original single-memory semantics; the folder-name
  // auto-workspace behavior is covered separately in section 12.
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "src", "index.js")],
      env: { ...process.env, GRAF_MCP_PORT: String(PORT), GRAF_MCP_DB: DB, GRAF_MCP_DEBUG: "1", GRAF_MCP_WORKSPACE: "default" },
      stderr: "inherit",
    })
  );

  // 1. tools/list
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check("lists 12 tools", tools.length === 12, tools.join(","));
  check(
    "tool names",
    ["cleanup", "connect", "expand", "find_nodes", "forget", "get_node", "list_workspaces", "read_graph", "recall", "remember", "search_facts", "tree"].every((t) =>
      tools.includes(t)
    ),
    tools.join(",")
  );

  // 2. remember
  let r = await client.callTool({
    name: "remember",
    arguments: {
      entity: "Aria Voss",
      entity_type: "character",
      observations: ["Captain of the salvage ship Kestrel", "Hides a debt to the Consortium"],
    },
  });
  check("remember stores facts", parsed(r).stored?.length === 2, text(r));

  await client.callTool({
    name: "remember",
    arguments: { entity: "The Betrayal", entity_type: "plot_thread", observations: ["Someone on the crew sells the route to pirates"] },
  });

  // 3. connect
  r = await client.callTool({
    name: "connect",
    arguments: { from: "Aria Voss", to: "The Betrayal", relation_type: "suspects", to_type: "plot_thread" },
  });
  check("connect creates relation", parsed(r).created?.type === "suspects", text(r));
  await client.callTool({
    name: "connect",
    arguments: { from: "Chapter 1", to: "The Betrayal", relation_type: "foreshadows", from_type: "chapter" },
  });

  // 4. recall
  r = await client.callTool({ name: "recall", arguments: { query: "consortium" } });
  const rec = parsed(r);
  check("recall finds by fact text", rec.matches?.[0]?.name === "Aria Voss", text(r).slice(0, 200));
  check("recall returns relations", rec.matches?.[0]?.relations?.length >= 1);

  // 5. expand (2 hops: Aria -> Betrayal -> Chapter 1)
  r = await client.callTool({ name: "expand", arguments: { entity: "Aria Voss", depth: 2 } });
  const exp = parsed(r);
  check("expand reaches 2 hops", exp.entities?.length === 3 && exp.relations?.length === 2,
    `entities=${exp.entities?.length} relations=${exp.relations?.length}`);

  // 6. read_graph
  r = await client.callTool({ name: "read_graph", arguments: {} });
  const g = parsed(r);
  check("read_graph stats", g.stats?.entities === 3 && g.stats?.observations === 3 && g.stats?.relations === 2,
    JSON.stringify(g.stats));

  // 6b. find_nodes / get_node / tree (name-only search, id lookup, hierarchy)
  r = await client.callTool({ name: "find_nodes", arguments: { query: "aria" } });
  const fn = parsed(r);
  check("find_nodes matches by name", fn.matches?.length === 1 && fn.matches[0].name === "Aria Voss" && fn.matches[0].facts === 2, text(r).slice(0, 200));
  check("find_nodes exposes a numeric node id", typeof fn.matches?.[0]?.id === "number", text(r).slice(0, 120));
  const ariaId = fn.matches[0].id;
  r = await client.callTool({ name: "find_nodes", arguments: { query: "consortium" } });
  check("find_nodes searches names only (not fact text)", parsed(r).matches?.length === 0, text(r).slice(0, 120));

  // search_facts: the fact-text mirror of find_nodes
  r = await client.callTool({ name: "search_facts", arguments: { query: "consortium" } });
  const sf = parsed(r);
  check("search_facts finds nodes by fact content",
    sf.matches?.length === 1 && sf.matches[0].name === "Aria Voss" && /Consortium/i.test(sf.matches[0].matches?.[0]?.text || ""),
    text(r).slice(0, 220));
  check("search_facts returns the matching fact ids", typeof sf.matches?.[0]?.matches?.[0]?.id === "number", text(r).slice(0, 150));
  r = await client.callTool({ name: "search_facts", arguments: { query: "aria" } });
  check("search_facts matches fact text only (not names)", parsed(r).matches?.length === 0, text(r).slice(0, 150));

  r = await client.callTool({ name: "get_node", arguments: { name: "Aria Voss" } });
  check("get_node by name returns facts + relations", parsed(r).name === "Aria Voss" && parsed(r).observations?.length === 2 && parsed(r).relations?.length >= 1, text(r).slice(0, 150));
  r = await client.callTool({ name: "get_node", arguments: { id: ariaId } });
  check("get_node by id returns the same entity", parsed(r).name === "Aria Voss", text(r).slice(0, 150));
  r = await client.callTool({ name: "get_node", arguments: { id: 999999 } });
  check("get_node with a bad id returns an error field", typeof parsed(r).error === "string", text(r).slice(0, 120));

  r = await client.callTool({ name: "tree", arguments: { entity: "Aria Voss", depth: 2 } });
  const tr = parsed(r);
  check("tree roots at the entity and nests children",
    tr.tree?.name === "Aria Voss" && tr.tree?.children?.[0]?.node?.name === "The Betrayal" && tr.tree?.children?.[0]?.relation === "suspects",
    text(r).slice(0, 220));
  r = await client.callTool({ name: "tree", arguments: { entity: "Aria Voss", workspace: "all" } });
  check("tree rejects workspace 'all'", typeof parsed(r).error === "string", text(r).slice(0, 120));

  // 6c. forget by node_id (create a throwaway entity, delete it by id, restore count)
  await client.callTool({ name: "remember", arguments: { entity: "Temp Node", observations: ["scratch"] } });
  r = await client.callTool({ name: "find_nodes", arguments: { query: "temp node" } });
  const tempId = parsed(r).matches[0].id;
  r = await client.callTool({ name: "forget", arguments: { node_id: tempId } });
  check("forget deletes an entity by node_id", parsed(r).deleted?.name === "Temp Node", text(r).slice(0, 150));
  r = await client.callTool({ name: "get_node", arguments: { id: tempId } });
  check("node is gone after forget by id", typeof parsed(r).error === "string", text(r).slice(0, 120));

  // 7. second bridge concurrently (simulates Antigravity + Claude Code at once)
  const client2 = new Client({ name: "smoke-test-2", version: "1.0.0" });
  await client2.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "src", "index.js")],
      env: { ...process.env, GRAF_MCP_PORT: String(PORT), GRAF_MCP_DB: DB, GRAF_MCP_WORKSPACE: "default" },
      stderr: "inherit",
    })
  );
  r = await client2.callTool({ name: "recall", arguments: { query: "aria" } });
  check("second concurrent agent shares the same memory", parsed(r).matches?.[0]?.name === "Aria Voss");
  await client2.close();

  // 8. forget
  r = await client.callTool({ name: "forget", arguments: { entity: "Chapter 1" } });
  check("forget deletes entity", parsed(r).deleted?.entity === "Chapter 1", text(r));
  r = await client.callTool({ name: "read_graph", arguments: {} });
  check("graph shrinks after forget", parsed(r).stats?.entities === 2, text(r).slice(0, 120));

  // 9. workspaces: two projects can both have an entity called "Chapter 1"
  // without colliding, and stay invisible to each other unless asked for
  await client.callTool({
    name: "remember",
    arguments: { entity: "Chapter 1", entity_type: "chapter", observations: ["Workspace A opening"], workspace: "ws-a" },
  });
  await client.callTool({
    name: "remember",
    arguments: { entity: "Chapter 1", entity_type: "chapter", observations: ["Workspace B opening"], workspace: "ws-b" },
  });
  r = await client.callTool({ name: "recall", arguments: { query: "chapter 1", workspace: "ws-a" } });
  let wsRec = parsed(r);
  check("workspace-scoped recall finds only that workspace's entity",
    wsRec.matches?.length === 1 && wsRec.matches[0].observations[0].text === "Workspace A opening",
    text(r).slice(0, 200));
  r = await client.callTool({ name: "recall", arguments: { query: "chapter 1", workspace: "default" } });
  check("default workspace is unaffected by other workspaces", parsed(r).matches?.length === 0, text(r).slice(0, 150));
  r = await client.callTool({ name: "recall", arguments: { query: "opening", workspace: "all" } });
  check("workspace 'all' searches across every workspace", parsed(r).matches?.length === 2, text(r).slice(0, 200));
  r = await client.callTool({ name: "expand", arguments: { entity: "Chapter 1", depth: 1, workspace: "all" } });
  check("expand rejects workspace 'all' (needs one concrete workspace)", parsed(r).error?.includes("all"), text(r));
  r = await client.callTool({ name: "list_workspaces", arguments: {} });
  const wsList = parsed(r).workspaces;
  check("list_workspaces reports all three workspaces",
    ["default", "ws-a", "ws-b"].every((w) => wsList.some((x) => x.workspace === w)),
    JSON.stringify(wsList));

  // 10. cleanup: re-storing the exact same fact twice should be dedupable
  await client.callTool({
    name: "remember",
    arguments: { entity: "Chapter 1", observations: ["Workspace A opening"], workspace: "ws-a" },
  });
  r = await client.callTool({ name: "recall", arguments: { query: "chapter 1", workspace: "ws-a" } });
  check("duplicate remember call creates a duplicate fact", parsed(r).matches[0].observations.length === 2, text(r));
  r = await client.callTool({ name: "cleanup", arguments: { workspace: "ws-a" } });
  const cleaned = parsed(r);
  check("cleanup removes the duplicate fact", cleaned.duplicateObservationsRemoved === 1, JSON.stringify(cleaned));
  r = await client.callTool({ name: "recall", arguments: { query: "chapter 1", workspace: "ws-a" } });
  check("entity keeps exactly one copy of the fact after cleanup", parsed(r).matches[0].observations.length === 1, text(r));

  // 10b. resources: read-only graph views addressable by URI, proxied through
  // the bridge to the daemon exactly like tools.
  const rtemplates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  check("lists resource templates (graph, entity, expand)",
    ["graph", "entity", "expand"].every((k) => rtemplates.some((u) => u.includes(`/${k}`))),
    rtemplates.join(","));
  const rlist = (await client.listResources()).resources.map((r) => r.uri);
  check("lists the static workspaces resource", rlist.includes("graf://workspaces"), rlist.join(","));

  const rres = (r) => JSON.parse(r.contents?.[0]?.text ?? "{}");
  let rr = await client.readResource({ uri: "graf://workspaces" });
  check("resource graf://workspaces lists workspaces",
    ["default", "ws-a", "ws-b"].every((w) => rres(rr).workspaces?.some((x) => x.workspace === w)),
    rr.contents?.[0]?.text?.slice(0, 200));

  rr = await client.readResource({ uri: "graf://workspaces/default/graph" });
  check("resource .../default/graph returns the overview",
    rres(rr).stats?.entities === 2 && rres(rr).workspace === "default",
    rr.contents?.[0]?.text?.slice(0, 150));

  rr = await client.readResource({ uri: "graf://workspaces/default/entity/Aria%20Voss" });
  check("resource .../entity/<name> decodes name and returns detail",
    rres(rr).name === "Aria Voss" && rres(rr).relations?.length >= 1,
    rr.contents?.[0]?.text?.slice(0, 150));

  rr = await client.readResource({ uri: "graf://workspaces/default/expand/Aria%20Voss?depth=2" });
  check("resource .../expand/<name>?depth=2 traverses",
    rres(rr).depth === 2 && rres(rr).entities?.length === 2 && rres(rr).relations?.length === 1,
    rr.contents?.[0]?.text?.slice(0, 150));

  rr = await client.readResource({ uri: "graf://workspaces/default/expand/Aria%20Voss" });
  check("resource expand defaults to depth 1 when omitted", rres(rr).depth === 1, rr.contents?.[0]?.text?.slice(0, 120));

  rr = await client.readResource({ uri: "graf://workspaces/default/entity/Nobody" });
  check("resource for a missing entity returns an error field", typeof rres(rr).error === "string", rr.contents?.[0]?.text?.slice(0, 120));

  // resources also work from a second concurrent bridge (shared daemon)
  const client3 = new Client({ name: "smoke-test-3", version: "1.0.0" });
  await client3.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src", "index.js")],
    env: { ...process.env, GRAF_MCP_PORT: String(PORT), GRAF_MCP_DB: DB, GRAF_MCP_WORKSPACE: "default" },
    stderr: "inherit",
  }));
  rr = await client3.readResource({ uri: "graf://workspaces/ws-a/graph" });
  check("second bridge reads resources from the shared graph", rres(rr).stats?.entities === 1, rr.contents?.[0]?.text?.slice(0, 120));
  await client3.close();

  // 11. dashboard HTTP API
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("dashboard /api/health", health.ok === true, JSON.stringify(health));
  const graph = await (await fetch(`${BASE}/api/graph`)).json();
  check("dashboard /api/graph (unfiltered spans all workspaces)", graph.entities?.length === 4 && graph.relations?.length === 1,
    `entities=${graph.entities?.length} relations=${graph.relations?.length}`);
  const graphWsA = await (await fetch(`${BASE}/api/graph?workspace=ws-a`)).json();
  check("dashboard /api/graph?workspace= filters correctly", graphWsA.entities?.length === 1, JSON.stringify(graphWsA.entities?.map((e) => e.name)));
  const wsApi = await (await fetch(`${BASE}/api/workspaces`)).json();
  check("dashboard /api/workspaces", wsApi.workspaces?.length === 3, JSON.stringify(wsApi));
  const statsWsB = await (await fetch(`${BASE}/api/stats?workspace=ws-b`)).json();
  check("dashboard /api/stats?workspace= filters correctly", statsWsB.entities === 1, JSON.stringify(statsWsB));
  const cleanupResp = await (
    await fetch(`${BASE}/api/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "ws-b" }),
    })
  ).json();
  check("dashboard POST /api/cleanup", typeof cleanupResp.duplicateObservationsRemoved === "number", JSON.stringify(cleanupResp));
  await fetch(`${BASE}/api/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "note", message: "hello from smoke test" }),
  });
  const logs = await (await fetch(`${BASE}/api/logs?after=0`)).json();
  check("dashboard /api/logs records tool calls",
    logs.entries?.some((e) => e.kind === "tool" && e.message.startsWith("remember")));
  check("log records agent connections",
    logs.entries?.some((e) => e.kind === "agent" && e.message.includes("graf-bridge")),
    "no 'agent' entry found");
  check("debug logging active (GRAF_MCP_DEBUG=1)",
    logs.entries?.some((e) => e.kind === "debug" && e.message.startsWith("mcp ")),
    "no 'debug' entry found");
  check("tool log entries include result preview",
    logs.entries?.some((e) => e.kind === "tool" && typeof e.data?.result === "string"));
  check("external /api/log entry accepted",
    logs.entries?.some((e) => e.kind === "note" && e.message === "hello from smoke test"));
  const html = await (await fetch(`${BASE}/`)).text();
  check("dashboard serves UI", html.includes("GrafMCP"));
  check("dashboard UI exposes node-editing controls", html.includes("New node") && html.includes("/api/edit"));

  // 11b. dashboard write API (/api/edit) — the node editor's backend
  const editPost = (body) =>
    fetch(`${BASE}/api/edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
  let ed = await editPost({ op: "create_entity", workspace: "edit-test", name: "Node One", type: "thing", observations: ["first fact"] });
  check("/api/edit create_entity", ed.ok === true && ed.result?.created === true, JSON.stringify(ed));
  ed = await editPost({ op: "add_observation", workspace: "edit-test", entity: "Node One", text: "second fact" });
  check("/api/edit add_observation", ed.ok === true && ed.result?.added?.length === 1, JSON.stringify(ed));
  const obsId = ed.result.added[0].id;
  ed = await editPost({ op: "update_observation", id: obsId, text: "second fact (edited)" });
  check("/api/edit update_observation", ed.ok === true, JSON.stringify(ed));
  ed = await editPost({ op: "set_type", workspace: "edit-test", name: "Node One", type: "widget" });
  check("/api/edit set_type", ed.ok === true, JSON.stringify(ed));
  ed = await editPost({ op: "create_entity", workspace: "edit-test", name: "Node Two", type: "thing" });
  ed = await editPost({ op: "add_relation", workspace: "edit-test", from: "Node One", to: "Node Two", type: "links_to" });
  check("/api/edit add_relation", ed.ok === true, JSON.stringify(ed));
  ed = await editPost({ op: "rename_entity", workspace: "edit-test", name: "Node One", newName: "Node One Renamed" });
  check("/api/edit rename_entity preserves facts + relations", ed.ok === true && ed.result?.to === "Node One Renamed", JSON.stringify(ed));
  r = await client.callTool({ name: "get_node", arguments: { name: "Node One Renamed", workspace: "edit-test" } });
  const renamed = parsed(r);
  check("renamed node kept its facts (type widget, 2 facts) and relation",
    renamed.type === "widget" && renamed.observations?.length === 2 && renamed.relations?.some((x) => x.type === "links_to"),
    text(r).slice(0, 220));
  ed = await editPost({ op: "delete_entity", workspace: "edit-test", name: "Node One Renamed" });
  check("/api/edit delete_entity", ed.ok === true, JSON.stringify(ed));
  const editStats = await (await fetch(`${BASE}/api/stats?workspace=edit-test`)).json();
  check("edit-test workspace has just the remaining node after delete", editStats.entities === 1, JSON.stringify(editStats));
  ed = await editPost({ op: "bogus_op" });
  check("/api/edit rejects an unknown op", typeof ed.error === "string", JSON.stringify(ed));

  // 12. folder-name auto-workspace: with GRAF_MCP_WORKSPACE unset, the bridge
  // derives the workspace from its launch directory (cwd basename), so every
  // project gets isolated memory with no per-call workspace argument.
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "graf-proj-"));
  const projName = path.basename(projDir);
  const autoEnv = { ...process.env, GRAF_MCP_PORT: String(PORT), GRAF_MCP_DB: DB };
  delete autoEnv.GRAF_MCP_WORKSPACE;
  const client4 = new Client({ name: "smoke-test-4", version: "1.0.0" });
  await client4.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src", "index.js")],
    env: autoEnv,
    cwd: projDir,
    stderr: "inherit",
  }));
  await client4.callTool({ name: "remember", arguments: { entity: "Auto Entity", observations: ["stored without a workspace argument"] } });
  r = await client4.callTool({ name: "list_workspaces", arguments: {} });
  const autoWs = parsed(r).workspaces;
  check("auto-workspace = launch folder name", autoWs.some((w) => w.workspace === projName), `${projName} not in ${JSON.stringify(autoWs)}`);
  r = await client4.callTool({ name: "recall", arguments: { query: "auto entity" } });
  check("recall without workspace finds the folder-scoped entity", parsed(r).matches?.[0]?.name === "Auto Entity", text(r).slice(0, 150));
  r = await client4.callTool({ name: "recall", arguments: { query: "auto entity", workspace: "default" } });
  check("folder-scoped memory does not leak into the default workspace", parsed(r).matches?.length === 0, text(r).slice(0, 150));
  await client4.close();
  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}

  await client.close();
  // stop the test daemon and clean up
  try { await fetch(`${BASE}/api/shutdown`, { method: "POST" }); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
