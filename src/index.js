#!/usr/bin/env node
/**
 * graf-mcp stdio bridge.
 *
 * Code agents (Claude Code, Antigravity, ...) launch this over stdio. It makes
 * sure a single shared daemon (src/daemon.js) is running — the daemon owns the
 * Kuzu graph database, the MCP tools and the dashboard — and forwards every
 * MCP request to it over HTTP. This lets any number of agents share one
 * memory graph without database lock conflicts.
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const PORT = Number(process.env.GRAF_MCP_PORT || 7688);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const DAEMON = path.join(__dirname, "daemon.js");

const log = (msg) => process.stderr.write(`[graf-bridge] ${msg}\n`);

// The workspace this agent works in is derived once, at startup, from:
// 1. Command-line argument (process.argv[2]) — highest priority
// 2. GRAF_MCP_WORKSPACE env var
// 3. Folder basename (cwd) — default
// Each project gets isolated memory automatically with no per-call boilerplate.
// The reserved word "all" would mean cross-workspace, so it never becomes a default.
function deriveWorkspace() {
  // Check command-line argument first
  const argWorkspace = (process.argv[2] || "").trim();
  if (argWorkspace) return argWorkspace.replace(/::/g, "_");

  // Then env var
  const override = (process.env.GRAF_MCP_WORKSPACE || "").trim();
  if (override) return override.replace(/::/g, "_");

  // Fall back to folder name
  const base = path.basename(process.cwd()).trim().replace(/::/g, "_");
  if (!base || base === "all") return "default";
  return base;
}
const WORKSPACE = deriveWorkspace();

// Every tool takes an optional `workspace` except list_workspaces (which spans
// them all by design). For the rest, if the agent didn't name a workspace we
// fill in this bridge's folder workspace, so memory never leaks between
// projects sharing the one daemon.
const NON_WORKSPACE_TOOLS = new Set(["list_workspaces"]);
function applyWorkspace(params) {
  if (!params || NON_WORKSPACE_TOOLS.has(params.name)) return params;
  const args = { ...(params.arguments || {}) };
  if (args.workspace === undefined || args.workspace === null || args.workspace === "") {
    args.workspace = WORKSPACE;
  }
  return { ...params, arguments: args };
}

// Best-effort guess of the agent that launched this bridge, purely for the
// dashboard's "client connected" log line.
function detectAgent() {
  const keys = Object.keys(process.env);
  if (process.env.CLAUDECODE || keys.some((k) => k.startsWith("CLAUDE_CODE"))) return "Claude Code";
  if (keys.some((k) => /antigravity/i.test(k))) return "Antigravity";
  if (keys.some((k) => /gemini/i.test(k))) return "Gemini/Antigravity";
  return "MCP client";
}
const AGENT = detectAgent();

async function health(timeoutMs = 1500) {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
  });
  child.unref();
}

async function ensureDaemon() {
  let h = await health();
  if (h && h.version !== PKG.version) {
    // stale daemon from an older install: replace it
    log(`daemon v${h.version} != bridge v${PKG.version}, restarting daemon`);
    try {
      await fetch(`${BASE}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) });
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    h = await health();
  }
  if (h) return h;
  log("starting daemon...");
  spawnDaemon();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    h = await health();
    if (h) {
      log(`daemon ready (pid ${h.pid}), dashboard at ${BASE}`);
      return h;
    }
  }
  throw new Error(`graf-memory daemon did not become ready on ${BASE}`);
}

let client = null;

async function connectClient() {
  const c = new Client({
    name: `graf-bridge (${AGENT}, pid ${process.pid}, ws: ${WORKSPACE})`,
    version: PKG.version,
  });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  return c;
}

async function withDaemon(op) {
  try {
    if (!client) {
      await ensureDaemon();
      client = await connectClient();
    }
    return await op(client);
  } catch (err) {
    // daemon may have been stopped or replaced — reconnect once and retry
    log(`call failed (${err.message}), reconnecting...`);
    try {
      client?.close();
    } catch {}
    client = null;
    await ensureDaemon();
    client = await connectClient();
    return await op(client);
  }
}

const server = new Server(
  { name: "graf-memory", version: PKG.version },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () =>
  withDaemon((c) => c.listTools())
);

server.setRequestHandler(CallToolRequestSchema, async (req) =>
  withDaemon((c) => c.callTool(applyWorkspace(req.params)))
);

// Resources are owned by the daemon too; the bridge just proxies the three
// resource requests through to it, same pattern as the tool handlers above.
server.setRequestHandler(ListResourcesRequestSchema, async () =>
  withDaemon((c) => c.listResources())
);

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () =>
  withDaemon((c) => c.listResourceTemplates())
);

server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
  withDaemon((c) => c.readResource(req.params))
);

// Warm the daemon up front so the first tool listing is fast, then go stdio.
log(`workspace: ${WORKSPACE} (cwd ${process.cwd()})`);
ensureDaemon()
  .then(async () => {
    // surface the chosen workspace in the dashboard activity log too
    try {
      await fetch(`${BASE}/api/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "note",
          message: `${AGENT} bound to workspace "${WORKSPACE}"`,
          data: { cwd: process.cwd() },
        }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {}
  })
  .catch((err) => log(`warmup failed: ${err.message}`))
  .finally(async () => {
    await server.connect(new StdioServerTransport());
    log("stdio bridge connected");
  });
