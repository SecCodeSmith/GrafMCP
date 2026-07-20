import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GraphDB } from "./db.js";
import { createLogger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const PORT = Number(process.env.GRAF_MCP_PORT || 7688);
// inside Docker set GRAF_MCP_HOST=0.0.0.0 so published ports can reach it
const HOST = process.env.GRAF_MCP_HOST || "127.0.0.1";
// GRAF_MCP_DEBUG=1 additionally logs every MCP request method
const DEBUG = process.env.GRAF_MCP_DEBUG === "1";
// GRAF_MCP_LOG_LEVEL sets initial log level: debug, info, warning, error (default: info)
const LOG_LEVEL = process.env.GRAF_MCP_LOG_LEVEL || "info";
const DB_PATH = process.env.GRAF_MCP_DB || path.join(ROOT, "data", "graph.kuzu");
const DATA_DIR = path.join(ROOT, "data");
const UI_FILE = path.join(__dirname, "ui.html");
const STARTED = Date.now();

let db;
let logger;
let markReady;
const ready = new Promise((resolve) => (markReady = resolve));

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

function jsonContent(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// A resources/read response: the same JSON we hand back from tools, but wrapped
// in the MCP resource envelope so agents can pull graph context by URI instead
// of a tool call.
function jsonResource(uri, obj) {
  return {
    contents: [
      { uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(obj, null, 2) },
    ],
  };
}

// Decoded, non-empty path segments of a graf:// URI. The literal "workspaces"
// lives in the host, so for graf://workspaces/<ws>/<kind>/<name> this returns
// [<ws>, <kind>, ...name-parts]. Percent-decoding here means entity names with
// spaces or slashes (encoded as %20 / %2F) round-trip correctly.
function grafSegments(uri) {
  return uri.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
}

// Shared by the read_graph tool and the graf://workspaces/{ws}/graph resource.
async function graphOverview(workspace) {
  const [entities, observations, relations, stats] = await Promise.all([
    db.allEntities(workspace),
    db.allObservations(workspace),
    db.allRelations(workspace),
    db.stats(workspace),
  ]);
  const obsCount = new Map();
  for (const o of observations) {
    const k = `${o.workspace}::${o.entity}`;
    obsCount.set(k, (obsCount.get(k) || 0) + 1);
  }
  return {
    workspace,
    stats,
    entities: entities.map((e) => ({
      name: e.name,
      type: e.type,
      workspace: e.workspace,
      facts: obsCount.get(`${e.workspace}::${e.name}`) || 0,
    })),
    relations: relations.map((r) => ({ from: r.from, type: r.type, to: r.to, workspace: r.workspace })),
  };
}

const WORKSPACE_DESC =
  "Isolates memory per project so unrelated stories/codebases don't mix or " +
  "collide on entity names. Defaults to 'default' — omit this everywhere " +
  "and behavior is identical to a single shared memory. To keep a project " +
  "separate, pass the same workspace name (e.g. 'wh40k-titanfall') on every " +
  "call for that project. For read tools (recall/expand/read_graph) only, " +
  "pass 'all' to search across every workspace at once.";
const workspaceField = () => z.string().min(1).optional().describe(WORKSPACE_DESC);

function buildMcpServer() {
  const server = new McpServer({ name: "graf-memory", version: PKG.version });

  const tool = (name, config, fn) => {
    server.registerTool(name, config, async (args) => {
      const t0 = Date.now();
      try {
        const result = await fn(args ?? {});
        const preview = result?.content?.[0]?.text?.slice(0, 300);
        logger.log("tool", `${name} (${Date.now() - t0} ms)`, { args, result: preview });
        return result;
      } catch (err) {
        logger.log("error", `${name} failed: ${err.message}`, { args, stack: err.stack?.split("\n")[1]?.trim() });
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  };

  tool(
    "remember",
    {
      title: "Remember facts about an entity",
      description:
        "Store one or more facts (observations) about an entity in the persistent graph memory. " +
        "The entity is created automatically if it does not exist. Use this whenever you learn " +
        "something worth keeping across sessions: characters, plot threads, chapters, decisions, " +
        "requirements, people, files. Keep each observation to one atomic fact.",
      inputSchema: {
        entity: z.string().min(1).describe("Entity name, e.g. 'Aria Voss' or 'Chapter 3'"),
        entity_type: z
          .string()
          .optional()
          .describe("Entity category, e.g. character, location, plot_thread, chapter, decision, fact"),
        observations: z
          .array(z.string().min(1))
          .min(1)
          .describe("Facts to store, one atomic statement each"),
        workspace: workspaceField(),
      },
    },
    async ({ entity, entity_type, observations, workspace }) => {
      const added = await db.addObservations(entity, entity_type || "note", observations, workspace);
      return jsonContent({ entity, type: entity_type || "note", workspace: workspace || "default", stored: added });
    }
  );

  tool(
    "connect",
    {
      title: "Connect two entities",
      description:
        "Create a directed, typed relation between two entities in the graph memory, e.g. " +
        "'Aria Voss' -[loves]-> 'Dr. Chen', 'Chapter 2' -[foreshadows]-> 'The Betrayal'. " +
        "Missing entities are created automatically. Relations are what make the memory a graph: " +
        "connect generously so later 'expand' calls can pull in related context.",
      inputSchema: {
        from: z.string().min(1).describe("Source entity name"),
        to: z.string().min(1).describe("Target entity name"),
        relation_type: z
          .string()
          .min(1)
          .describe("Relation verb in snake_case, e.g. knows, part_of, foreshadows, depends_on"),
        from_type: z.string().optional().describe("Category for the source entity if it is new"),
        to_type: z.string().optional().describe("Category for the target entity if it is new"),
        workspace: workspaceField(),
      },
    },
    async ({ from, to, relation_type, from_type, to_type, workspace }) => {
      await db.addRelation(from, to, relation_type, from_type || "note", to_type || "note", workspace);
      return jsonContent({ created: { from, type: relation_type, to }, workspace: workspace || "default" });
    }
  );

  tool(
    "recall",
    {
      title: "Search the memory",
      description:
        "Search the graph memory by keyword (case-insensitive substring over entity names, types " +
        "and stored facts). Returns matching entities with their facts and direct relations. " +
        "Call this at the start of a task to load relevant context, e.g. recall('Aria') or " +
        "recall('chapter 3') before continuing a story.",
      inputSchema: {
        query: z.string().min(1).describe("Keyword or phrase to search for"),
        limit: z.number().int().min(1).max(50).optional().describe("Max entities to return (default 10)"),
        workspace: workspaceField(),
      },
    },
    async ({ query, limit, workspace }) => {
      const hits = (await db.search(query, workspace)).slice(0, limit || 10);
      const matches = [];
      for (const h of hits) matches.push(await db.getEntity(h.name, h.workspace));
      return jsonContent({ query, workspace: workspace || "default", matches });
    }
  );

  tool(
    "expand",
    {
      title: "Expand the neighborhood of an entity",
      description:
        "Graph traversal: return an entity plus everything connected to it within N hops " +
        "(entities, their facts, and the relations between them). This is the main way to load " +
        "full context around a topic, e.g. expand('Aria Voss', 2) returns her relationships, the " +
        "plot threads she is part of, and the chapters they appear in.",
      inputSchema: {
        entity: z.string().min(1).describe("Entity name to expand around"),
        depth: z.number().int().min(1).max(3).optional().describe("Hops to traverse, 1-3 (default 1)"),
        workspace: z
          .string()
          .min(1)
          .optional()
          .describe(WORKSPACE_DESC + " 'all' is not valid here — expand needs one concrete workspace to start from."),
      },
    },
    async ({ entity, depth, workspace }) => {
      if (workspace === "all") {
        return jsonContent({ error: "'expand' needs one concrete workspace, not 'all'. Use 'recall' to find which workspace an entity lives in." });
      }
      if (!(await db.entityExists(entity, workspace))) {
        return jsonContent({ error: `Entity '${entity}' not found in workspace '${workspace || "default"}'. Try 'recall' with workspace 'all' first.` });
      }
      const result = await db.expand(entity, depth || 1, workspace);
      return jsonContent({ workspace: workspace || "default", ...result });
    }
  );

  tool(
    "find_nodes",
    {
      title: "Search nodes by name",
      description:
        "Find entities whose NAME matches a substring (case-insensitive 'like' search over names " +
        "only — unlike 'recall', which also searches fact text). Use it to locate a node when you " +
        "know part of its name, e.g. find_nodes('aria') or find_nodes('chapter'). Returns each " +
        "match's numeric node id, name, type, workspace and fact count. '*' and '%' are accepted " +
        "as wildcards. Pass the returned id to 'get_node' or 'forget' to act on an exact node.",
      inputSchema: {
        query: z.string().min(1).describe("Substring of the entity name to match"),
        limit: z.number().int().min(1).max(100).optional().describe("Max nodes to return (default 25)"),
        workspace: workspaceField(),
      },
    },
    async ({ query, limit, workspace }) => {
      const matches = await db.findNodes(query, workspace || "default", limit || 25);
      return jsonContent({ query, workspace: workspace || "default", matches });
    }
  );

  tool(
    "search_facts",
    {
      title: "Search nodes by fact content",
      description:
        "Find entities that have a FACT (observation) mentioning a substring — the fact-text " +
        "counterpart to 'find_nodes' (which matches names only). Case-insensitive. Returns each " +
        "matching node with the specific facts that matched (and their ids), so you can see why it " +
        "was returned and act on a fact directly. Use it for questions like 'which nodes mention the " +
        "Consortium?'. '*' and '%' are accepted as wildcards.",
      inputSchema: {
        query: z.string().min(1).describe("Substring to look for inside stored facts"),
        limit: z.number().int().min(1).max(100).optional().describe("Max nodes to return (default 25)"),
        workspace: workspaceField(),
      },
    },
    async ({ query, limit, workspace }) => {
      const matches = await db.findByFact(query, workspace || "default", limit || 25);
      return jsonContent({ query, workspace: workspace || "default", matches });
    }
  );

  tool(
    "get_node",
    {
      title: "Get a node by id or exact name",
      description:
        "Fetch one entity with all its facts and direct relations, addressed by its numeric node " +
        "'id' (from find_nodes/recall/read_graph) or by its exact 'name'. Provide one of them. " +
        "Node ids are unique across the whole memory, so a lookup by id does not need a workspace.",
      inputSchema: {
        id: z.number().int().optional().describe("Numeric node id (exact)"),
        name: z.string().min(1).optional().describe("Exact entity name"),
        workspace: workspaceField(),
      },
    },
    async ({ id, name, workspace }) => {
      let found = null;
      if (id !== undefined && id !== null) found = await db.getNodeById(id, workspace || "all");
      else if (name) found = await db.getEntity(name, workspace || "default");
      else return jsonContent({ error: "Provide 'id' or 'name'." });
      return jsonContent(found || { error: `Node not found (${id !== undefined ? `id ${id}` : `name '${name}'`}).` });
    }
  );

  tool(
    "tree",
    {
      title: "See the tree under an entity",
      description:
        "Return a hierarchical tree rooted at an entity, following its relations outward up to N " +
        "hops. Unlike 'expand' (flat lists of entities and relations), this nests each related " +
        "entity under its parent — handy for reading a structure like chapters → scenes → beats. " +
        "'direction' picks which edges to follow: 'out' (default), 'in', or 'both'. Cycles are cut " +
        "(a node already shown is marked 'repeated').",
      inputSchema: {
        entity: z.string().min(1).describe("Entity name to use as the tree root"),
        depth: z.number().int().min(1).max(5).optional().describe("Hops to descend, 1-5 (default 2)"),
        direction: z
          .enum(["out", "in", "both"])
          .optional()
          .describe("Which relation edges to follow: out (default), in, or both"),
        workspace: z
          .string()
          .min(1)
          .optional()
          .describe(WORKSPACE_DESC + " 'all' is not valid here — tree needs one concrete workspace to root in."),
      },
    },
    async ({ entity, depth, direction, workspace }) => {
      if (workspace === "all") {
        return jsonContent({ error: "'tree' needs one concrete workspace, not 'all'." });
      }
      if (!(await db.entityExists(entity, workspace))) {
        return jsonContent({ error: `Entity '${entity}' not found in workspace '${workspace || "default"}'.` });
      }
      const root = await db.tree(entity, depth || 2, workspace || "default", direction || "out");
      return jsonContent({ workspace: workspace || "default", depth: depth || 2, direction: direction || "out", tree: root });
    }
  );

  tool(
    "read_graph",
    {
      title: "Read the whole memory graph",
      description:
        "Return an overview of the entire graph memory: every entity (name, type, number of facts) " +
        "and every relation. Use it to orient yourself in an unfamiliar memory or to check what is " +
        "already stored before adding more. Defaults to the 'default' workspace; pass workspace: " +
        "'all' to see every project's memory at once.",
      inputSchema: { workspace: workspaceField() },
    },
    async ({ workspace }) => jsonContent(await graphOverview(workspace || "default"))
  );

  tool(
    "list_workspaces",
    {
      title: "List memory workspaces",
      description:
        "List every workspace that currently has memory stored, with an entity count for each. " +
        "Call this if you're unsure whether this project already has an established workspace name " +
        "before starting a new one.",
      inputSchema: {},
    },
    async () => jsonContent({ workspaces: await db.listWorkspaces() })
  );

  tool(
    "cleanup",
    {
      title: "Clean up duplicate memory",
      description:
        "Maintenance pass over the graph memory: removes exact-duplicate facts (the same text " +
        "stored twice on the same entity — common after a long session of repeated 'remember' " +
        "calls) and any orphaned fact records. Never removes distinct facts, entities or relations. " +
        "Safe to call any time; omit workspace to clean everything.",
      inputSchema: { workspace: workspaceField() },
    },
    async ({ workspace }) => jsonContent(await db.cleanup(workspace || "all"))
  );

  tool(
    "get_stats",
    {
      title: "Get graph statistics",
      description:
        "Return counts of entities, observations, and relations in the workspace. Useful for " +
        "understanding the size and complexity of the stored memory.",
      inputSchema: { workspace: workspaceField() },
    },
    async ({ workspace }) => {
      const stats = await db.stats(workspace || "all");
      return jsonContent({ workspace: workspace || "all", ...stats });
    }
  );

  tool(
    "get_log_level",
    {
      title: "Get current log level",
      description:
        "Get the current log level setting. Returns the active level (debug, info, warning, or error) " +
        "and its numeric value.",
      inputSchema: {},
    },
    async () => jsonContent(logger.getLevel())
  );

  tool(
    "set_log_level",
    {
      title: "Set log level",
      description:
        "Change the logging level to control verbosity. Options: debug (most verbose), info (default), " +
        "warning, error (least verbose). Only messages at or above the current level are output.",
      inputSchema: {
        level: z
          .enum(["debug", "info", "warning", "error"])
          .describe("New log level: debug, info, warning, or error"),
      },
    },
    async ({ level }) => {
      const result = logger.setLevel(level);
      return jsonContent({
        ok: true,
        changed: result.changed,
        from: result.from,
        to: result.to,
        current: logger.getLevel(),
      });
    }
  );

  tool(
    "create_entity_direct",
    {
      title: "Create an entity directly",
      description:
        "Create or retrieve an entity with optional initial observations. Returns whether the " +
        "entity was newly created or already existed.",
      inputSchema: {
        name: z.string().min(1).describe("Entity name"),
        type: z.string().optional().describe("Entity type/category"),
        workspace: workspaceField(),
      },
    },
    async ({ name, type, workspace }) => {
      const result = await db.createEntity(name, type || "note", workspace);
      return jsonContent(result);
    }
  );

  tool(
    "set_entity_type",
    {
      title: "Change an entity's type",
      description: "Update the type/category of an existing entity.",
      inputSchema: {
        name: z.string().min(1).describe("Entity name"),
        type: z.string().min(1).describe("New type/category"),
        workspace: workspaceField(),
      },
    },
    async ({ name, type, workspace }) => {
      await db.setEntityType(name, type, workspace);
      return jsonContent({ name, type, workspace: workspace || "default" });
    }
  );

  tool(
    "rename_entity",
    {
      title: "Rename an entity",
      description:
        "Rename an entity. All its observations and relations are transferred to the new name. " +
        "Observation IDs change; entity identity transfers cleanly.",
      inputSchema: {
        old_name: z.string().min(1).describe("Current entity name"),
        new_name: z.string().min(1).describe("New entity name"),
        workspace: workspaceField(),
      },
    },
    async ({ old_name, new_name, workspace }) => {
      const result = await db.renameEntity(old_name, new_name, workspace);
      return jsonContent(result);
    }
  );

  tool(
    "update_fact",
    {
      title: "Edit a stored fact",
      description: "Update the text of a single stored observation (fact) by its ID.",
      inputSchema: {
        observation_id: z.number().int().describe("ID of the observation to edit"),
        text: z.string().min(1).describe("New fact text"),
      },
    },
    async ({ observation_id, text }) => {
      await db.updateObservation(observation_id, text);
      return jsonContent({ observation_id, text });
    }
  );

  tool(
    "delete_workspace",
    {
      title: "Delete an entire workspace",
      description:
        "Permanently delete a workspace and all its entities, observations, and relations. " +
        "Cannot be undone.",
      inputSchema: {
        workspace: z.string().min(1).describe("Workspace name to delete"),
      },
    },
    async ({ workspace }) => {
      if (!workspace || workspace === "all") {
        return jsonContent({ error: "Must specify a concrete workspace name to delete." });
      }
      const result = await db.deleteWorkspace(workspace);
      return jsonContent(result);
    }
  );

  tool(
    "delete_entity_direct",
    {
      title: "Delete an entity directly",
      description: "Delete an entity by name, along with all its observations and relations.",
      inputSchema: {
        name: z.string().min(1).describe("Entity name to delete"),
        workspace: workspaceField(),
      },
    },
    async ({ name, workspace }) => {
      await db.deleteEntity(name, workspace);
      return jsonContent({ deleted: { name, workspace: workspace || "default" } });
    }
  );

  tool(
    "delete_relation_direct",
    {
      title: "Delete a specific relation",
      description: "Delete one or more relations between two entities.",
      inputSchema: {
        from: z.string().min(1).describe("Source entity name"),
        to: z.string().min(1).describe("Target entity name"),
        relation_type: z.string().optional().describe("If provided, only delete relations of this type"),
        workspace: workspaceField(),
      },
    },
    async ({ from, to, relation_type, workspace }) => {
      await db.deleteRelation(from, to, relation_type || null, workspace);
      return jsonContent({ deleted: { from, to, relation_type: relation_type || "any", workspace: workspace || "default" } });
    }
  );

  tool(
    "forget",
    {
      title: "Delete from memory",
      description:
        "Delete something from the graph memory. Provide exactly one of: 'entity' (deletes the " +
        "entity, its facts and its relations), 'node_id' (same, but addressed by numeric node id " +
        "from find_nodes/read_graph), 'from'+'to' (deletes relations between two entities, " +
        "optionally filtered by 'relation_type'), or 'observation_id' (deletes a single fact; ids " +
        "are returned by recall/expand).",
      inputSchema: {
        entity: z.string().optional().describe("Entity to delete entirely"),
        node_id: z.number().int().optional().describe("Numeric node id of an entity to delete entirely"),
        from: z.string().optional().describe("Source entity of the relation to delete"),
        to: z.string().optional().describe("Target entity of the relation to delete"),
        relation_type: z.string().optional().describe("Only delete relations of this type"),
        observation_id: z.number().int().optional().describe("Id of a single fact to delete"),
        workspace: workspaceField(),
      },
    },
    async ({ entity, node_id, from, to, relation_type, observation_id, workspace }) => {
      if (entity) {
        await db.deleteEntity(entity, workspace);
        return jsonContent({ deleted: { entity, workspace: workspace || "default" } });
      }
      if (node_id !== undefined && node_id !== null) {
        const removed = await db.deleteEntityById(node_id, workspace || "all");
        return jsonContent(removed ? { deleted: { node_id, ...removed } } : { error: `No node with id ${node_id}.` });
      }
      if (from && to) {
        await db.deleteRelation(from, to, relation_type || null, workspace);
        return jsonContent({ deleted: { from, to, relation_type: relation_type || "any", workspace: workspace || "default" } });
      }
      if (observation_id !== undefined) {
        await db.deleteObservation(observation_id);
        return jsonContent({ deleted: { observation_id } });
      }
      return jsonContent({ error: "Provide 'entity', 'node_id', 'from'+'to', or 'observation_id'." });
    }
  );

  // -------------------------------------------------------------------------
  // MCP resources
  //
  // Read-only views of the graph, addressable by URI so an agent (or a human
  // in a client's resource picker) can pull context without a tool round-trip.
  // The URI shape mirrors the tools: graf://workspaces/<workspace>/<view>/...
  // -------------------------------------------------------------------------

  server.registerResource(
    "workspaces",
    "graf://workspaces",
    {
      title: "Memory workspaces",
      description: "Every workspace that has memory stored, with an entity count for each.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, { workspaces: await db.listWorkspaces() })
  );

  server.registerResource(
    "workspace-graph",
    new ResourceTemplate("graf://workspaces/{workspace}/graph", { list: undefined }),
    {
      title: "Workspace graph",
      description:
        "Overview of one workspace: every entity (name, type, fact count) and every relation. " +
        "URI: graf://workspaces/<workspace>/graph — e.g. graf://workspaces/the-frontier/graph.",
      mimeType: "application/json",
    },
    async (uri) => {
      const [workspace] = grafSegments(uri);
      return jsonResource(uri, await graphOverview(workspace || "default"));
    }
  );

  server.registerResource(
    "entity",
    new ResourceTemplate("graf://workspaces/{workspace}/entity/{entity}", { list: undefined }),
    {
      title: "Entity detail",
      description:
        "One entity with all its facts and direct relations. " +
        "URI: graf://workspaces/<workspace>/entity/<name> (URL-encode the name).",
      mimeType: "application/json",
    },
    async (uri) => {
      const seg = grafSegments(uri);
      const workspace = seg[0] || "default";
      const entity = seg.slice(2).join("/");
      const found = await db.getEntity(entity, workspace);
      return jsonResource(uri, found || { error: `Entity '${entity}' not found in workspace '${workspace}'.` });
    }
  );

  server.registerResource(
    "expand",
    new ResourceTemplate("graf://workspaces/{workspace}/expand/{entity}", { list: undefined }),
    {
      title: "Expand entity neighborhood",
      description:
        "An entity plus everything connected within N hops. " +
        "URI: graf://workspaces/<workspace>/expand/<name>?depth=<1-3> (depth optional, default 1).",
      mimeType: "application/json",
    },
    async (uri) => {
      const seg = grafSegments(uri);
      const workspace = seg[0] || "default";
      const entity = seg.slice(2).join("/");
      const depth = Math.trunc(Number(uri.searchParams.get("depth"))) || 1;
      if (!(await db.entityExists(entity, workspace))) {
        return jsonResource(uri, {
          error: `Entity '${entity}' not found in workspace '${workspace}'. Read graf://workspaces to list workspaces, or use the 'recall' tool to find it.`,
        });
      }
      return jsonResource(uri, { workspace, depth, ...(await db.expand(entity, depth, workspace)) });
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP handling
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

async function handleMcp(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    });
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
    return;
  }
  for (const m of Array.isArray(body) ? body : [body]) {
    if (m?.method === "initialize") {
      const ci = m.params?.clientInfo;
      logger.log("agent", `client connected: ${ci?.name ?? "unknown"} v${ci?.version ?? "?"}`);
    } else if (DEBUG && m?.method) {
      logger.log("debug", `mcp ${m.method}`);
    }
  }
  // Stateless mode: a fresh server+transport pair per request, all sharing db.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleApi(req, res, url) {
  switch (url.pathname) {
    case "/api/health":
      sendJson(res, 200, {
        ok: true,
        name: "graf-memory",
        version: PKG.version,
        pid: process.pid,
        uptime_s: Math.round((Date.now() - STARTED) / 1000),
      });
      return;
    case "/api/stats": {
      const ws = url.searchParams.get("workspace") || "all";
      sendJson(res, 200, {
        ...(await db.stats(ws)),
        workspace: ws,
        db_path: DB_PATH,
        version: PKG.version,
        pid: process.pid,
        started: new Date(STARTED).toISOString(),
        port: PORT,
      });
      return;
    }
    case "/api/workspaces":
      sendJson(res, 200, { workspaces: await db.listWorkspaces() });
      return;
    case "/api/graph": {
      const ws = url.searchParams.get("workspace") || "all";
      const [entities, observations, relations] = await Promise.all([
        db.allEntities(ws),
        db.allObservations(ws),
        db.allRelations(ws),
      ]);
      const byEntity = new Map(entities.map((e) => [`${e.workspace}::${e.name}`, { ...e, observations: [] }]));
      for (const o of observations) {
        const e = byEntity.get(`${o.workspace}::${o.entity}`);
        if (e) e.observations.push({ id: o.id, text: o.text, created: o.created });
      }
      sendJson(res, 200, { entities: [...byEntity.values()], relations });
      return;
    }
    case "/api/cleanup": {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "POST required" });
        return;
      }
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw) body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const ws = body.workspace || "all";
      const result = await db.cleanup(ws);
      logger.log("note", `cleanup (workspace: ${ws}): removed ${result.duplicateObservationsRemoved} duplicate fact(s), ${result.orphanObservationsRemoved} orphan(s)`);
      sendJson(res, 200, { workspace: ws, ...result });
      return;
    }
    case "/api/edit": {
      // Write operations for the dashboard's node editor. One POST body of the
      // shape { op, ...fields }; every op maps to a GraphDB mutation. Kept as a
      // single dispatcher (rather than a REST endpoint per verb) so the daemon
      // stays small and every edit lands in the activity log the same way.
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "POST required" });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const op = body.op;
      const ws = body.workspace || "default";
      try {
        let result;
        switch (op) {
          case "create_entity":
            result = await db.createEntity(body.name, body.type, ws);
            if (Array.isArray(body.observations) && body.observations.length) {
              await db.addObservations(body.name, body.type, body.observations.filter((t) => t && t.trim()), ws);
            }
            break;
          case "rename_entity":
            result = await db.renameEntity(body.name, body.newName, ws);
            break;
          case "set_type":
            await db.setEntityType(body.name, body.type, ws);
            result = { name: body.name, type: body.type || "note", workspace: ws };
            break;
          case "delete_entity":
            if (body.id !== undefined && body.id !== null) result = await db.deleteEntityById(body.id, ws);
            else { await db.deleteEntity(body.name, ws); result = { name: body.name, workspace: ws }; }
            break;
          case "delete_workspace":
            result = await db.deleteWorkspace(body.workspace);
            break;
          case "add_observation": {
            const added = await db.addObservations(body.entity, "note", [String(body.text || "")], ws);
            result = { entity: body.entity, added };
            break;
          }
          case "update_observation":
            await db.updateObservation(body.id, String(body.text || ""));
            result = { id: body.id };
            break;
          case "delete_observation":
            await db.deleteObservation(body.id);
            result = { id: body.id };
            break;
          case "add_relation":
            await db.addRelation(body.from, body.to, body.type, "note", "note", ws);
            result = { from: body.from, to: body.to, type: body.type, workspace: ws };
            break;
          case "delete_relation":
            await db.deleteRelation(body.from, body.to, body.relation_type || body.type || null, ws);
            result = { from: body.from, to: body.to, workspace: ws };
            break;
          default:
            sendJson(res, 400, { error: `unknown op '${op}'` });
            return;
        }
        logger.log("note", `edit: ${op}`, { args: { ...body }, result: JSON.stringify(result)?.slice(0, 200) });
        sendJson(res, 200, { ok: true, op, result });
      } catch (err) {
        logger.log("error", `edit ${op} failed: ${err.message}`, { args: body });
        sendJson(res, 400, { error: err.message });
      }
      return;
    }
    case "/api/logs": {
      const after = Number(url.searchParams.get("after") || 0);
      sendJson(res, 200, { entries: logger.since(after), last: logger.lastSeq });
      return;
    }
    case "/api/log-level": {
      if (req.method === "GET") {
        sendJson(res, 200, { ...logger.getLevel() });
        return;
      }
      if (req.method === "POST") {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        const result = logger.setLevel(body.level);
        if (result.changed) {
          logger.log("note", `log level changed: ${result.from} → ${result.to}`);
        }
        sendJson(res, 200, { ok: true, ...result, current: logger.getLevel() });
        return;
      }
      sendJson(res, 405, { error: "GET or POST required" });
      return;
    }
    case "/api/log": {
      // lets external processes (e.g. the bridge, or you via curl) write a
      // line into the activity log for debugging
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "POST required" });
        return;
      }
      let entry;
      try {
        entry = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const kind = ["agent", "debug", "note"].includes(entry.kind) ? entry.kind : "note";
      if (typeof entry.message !== "string" || !entry.message) {
        sendJson(res, 400, { error: "'message' (string) required" });
        return;
      }
      logger.log(kind, entry.message.slice(0, 500), entry.data);
      sendJson(res, 200, { ok: true });
      return;
    }
    case "/api/shutdown":
      if (req.method === "POST") {
        logger.log("server", "shutdown requested via API");
        sendJson(res, 200, { ok: true, message: "shutting down" });
        setTimeout(() => process.exit(0), 150);
      } else {
        sendJson(res, 405, { error: "POST required" });
      }
      return;
    default:
      sendJson(res, 404, { error: "not found" });
  }
}

const httpServer = http.createServer(async (req, res) => {
  try {
    await ready; // don't serve until the database is open
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
    } else if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(UI_FILE));
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    process.stderr.write(`[graf-mcp] request error: ${err.stack}\n`);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

// The port acts as the singleton mutex: if another daemon already owns it,
// this process exits quietly and the running daemon keeps serving everyone.
httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(`[graf-mcp] daemon already running on port ${PORT}, exiting\n`);
    process.exit(0);
  }
  process.stderr.write(`[graf-mcp] http error: ${err.stack}\n`);
  process.exit(1);
});

httpServer.listen({ port: PORT, host: HOST, exclusive: true }, async () => {
  try {
    logger = createLogger(DATA_DIR, LOG_LEVEL);
    db = new GraphDB(DB_PATH);
    await db.init();
    logger.log(
      "server",
      `graf-memory daemon v${PKG.version} ready — dashboard http://127.0.0.1:${PORT} db ${DB_PATH} log_level ${logger.getLevel().level}`
    );
    markReady();
  } catch (err) {
    process.stderr.write(`[graf-mcp] failed to open database: ${err.stack}\n`);
    process.exit(1);
  }
});
