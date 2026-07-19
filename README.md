# GrafMCP — Graph Memory for Code Agents

A local MCP server that gives code agents (**Claude Code**, **Antigravity**, and any other MCP client) a **shared, persistent graph memory**, backed by [Kuzu](https://kuzudb.com/) — an embedded database purpose-built for graph storage and graph search — plus a live **web dashboard** showing the memory graph and an activity log.

Typical use: long multi-session work where context must survive — e.g. writing a long story with many interlocking plot threads. The agent stores characters, chapters, plot threads and decisions as **entities**, attaches **facts** to them, and links them with typed **relations** (`foreshadows`, `suspects`, `part_of`, …). Next session — even from a different agent — it recalls and expands that graph instead of starting cold.

## Architecture

```text
Claude Code ──stdio──► bridge (src/index.js) ─┐
                                              ├─HTTP─► daemon (src/daemon.js)
Antigravity ──stdio──► bridge (src/index.js) ─┘        ├─ Kuzu graph DB   (data/graph.kuzu)
                                                       ├─ MCP endpoint    (POST /mcp)
Browser ── http://127.0.0.1:7688 ──────────────────────┴─ Dashboard + API
```

Both agents launch the same tiny **stdio bridge**. The first bridge to start spawns one shared background **daemon**; every later bridge just connects to it. That is what lets multiple agents use **one** memory graph at the same time — an embedded DB allows only a single writer process, and here only the daemon ever touches the database. The daemon keeps running after agents disconnect (the dashboard stays available); stop it any time with `npm run stop`.

## Database

The storage engine is **Kuzu** (v0.11) — an *embedded* graph database, i.e. a library inside the daemon process, no separate DB server to install. It uses a property-graph model queried with **Cypher**, and is columnar and vectorized under the hood, optimized precisely for graph search: multi-hop joins, relation traversal, pattern matching. The schema is two node tables (`Entity`, `Observation`) and two relationship tables (`HAS_OBSERVATION`, `RELATES`).

All data lives in **one folder**: `data/graph.kuzu` (plus `data/activity.jsonl` for the log history). Back up = copy the folder; reset = delete it (with the daemon stopped).

## Requirements

- Node.js ≥ 20 (tested on Node 24, Windows 11)
- `npm install` already done in this folder (deps: `@modelcontextprotocol/sdk`, `kuzu`, `zod`)

## Setup

> **On this machine everything below is already configured.** Restart Claude Code / Antigravity (or reload their MCP servers) and the `graf-memory` tools appear.

### Claude Code

User scope (available in every project) — one command:

```bash
claude mcp add --scope user graf-memory -- node "C:/Users/Kuba/Desktop/GrafMCP_For_WorksSpace/src/index.js"
```

Or per-project: copy [.mcp.json](.mcp.json) into the project root. Verify with `/mcp` inside Claude Code — you should see `graf-memory` with 12 tools.

### Antigravity

Open the Agent panel → **⋯** → **MCP Servers** → **Manage MCP Servers** → **View raw config**, and add the `graf-memory` block (on this machine the file is `C:\Users\Kuba\.gemini\antigravity\mcp_config.json`):

```json
{
  "mcpServers": {
    "graf-memory": {
      "command": "node",
      "args": ["C:/Users/Kuba/Desktop/GrafMCP_For_WorksSpace/src/index.js"]
    }
  }
}
```

Then click **Refresh** in the MCP servers panel.

### Any other MCP client

Point it at `node <this folder>/src/index.js` over stdio, or — if it supports Streamable HTTP — directly at `http://127.0.0.1:7688/mcp` (the daemon must already be running for the HTTP variant).

## The tools

| Tool | What it does | Example arguments |
| --- | --- | --- |
| `remember` | Store facts about an entity (creates it if new) | `{ "entity": "Aria Voss", "entity_type": "character", "observations": ["Captain of the Kestrel"] }` |
| `connect` | Create a directed, typed relation between two entities | `{ "from": "Chapter 1", "to": "The Betrayal", "relation_type": "foreshadows" }` |
| `recall` | Keyword search over names, types and facts | `{ "query": "consortium" }` |
| `expand` | Graph traversal: entity + everything within N hops (1–3) | `{ "entity": "Aria Voss", "depth": 2 }` |
| `find_nodes` | Search nodes by **name** only (case-insensitive "like") — returns each match's node **id** | `{ "query": "aria" }` |
| `search_facts` | Search nodes by **fact content** — returns matching nodes with the specific facts that matched | `{ "query": "consortium" }` |
| `get_node` | Fetch one node by numeric **id** or exact **name**, with its facts and relations | `{ "id": 7 }` or `{ "name": "Aria Voss" }` |
| `tree` | Hierarchical tree rooted at an entity, following relations `out`/`in`/`both` | `{ "entity": "Chapter 1", "depth": 2 }` |
| `read_graph` | Overview of the whole memory: all entities and relations | `{}` |
| `forget` | Delete an entity (by name **or** `node_id`), a relation, or a single fact | `{ "entity": "Chapter 1" }` or `{ "node_id": 7 }` |
| `list_workspaces` | List every workspace in use, with entity counts | `{}` |
| `cleanup` | Remove exact-duplicate facts and orphaned records | `{ "workspace": "wh40k-titanfall" }` |

`recall` answers *"what do I know about X?"*; `expand` answers *"what is connected to X?"* — that second question is what a graph database is optimized for, and why this beats a flat notes file for interlocking stories. `find_nodes` is the narrow name-only lookup, `search_facts` is its mirror over fact content (which nodes *mention* something), `get_node` pulls one node straight by its id/name, and `tree` reads a structure top-down (chapters → scenes → beats). (`recall` is the broad one — it spans names, types **and** facts at once.)

Every tool except `list_workspaces` also takes an optional **`workspace`** argument — see *Workspaces* below. Omit it and the tool uses this project's automatic workspace (its folder name).

## The resources

The same read-only views are also exposed as **MCP resources**, addressable by URI. Clients that support resources (e.g. `ReadMcpResourceTool`, or a resource picker) can pull graph context by URI without a tool round-trip. All URIs use the `graf://` scheme and mirror the tools:

| URI | Returns | Equivalent tool |
| --- | --- | --- |
| `graf://workspaces` | Every workspace with an entity count | `list_workspaces` |
| `graf://workspaces/<workspace>/graph` | Full overview of one workspace (entities + relations) | `read_graph` |
| `graf://workspaces/<workspace>/entity/<name>` | One entity with its facts and direct relations | `recall` (single hit) |
| `graf://workspaces/<workspace>/expand/<name>?depth=<1-3>` | An entity plus everything within N hops (`depth` optional, default 1) | `expand` |

`<workspace>` and `<name>` are path segments, so **URL-encode** anything with spaces or slashes (`B1.5 The Unintended Shadow` → `B1.5%20The%20Unintended%20Shadow`). Example — the depth-2 neighborhood of chapter B1.5 in the `the-frontier` workspace:

```text
graf://workspaces/the-frontier/expand/B1.5%20The%20Unintended%20Shadow?depth=2
```

The first three are resource **templates** plus one static resource (`graf://workspaces`); all responses are `application/json` with the same body shape the matching tool returns.

## Dashboard

Open **<http://127.0.0.1:7688>** (it starts automatically with the daemon; light and dark theme follow your OS).

- **Workspace chooser** (first screen) — the dashboard always shows exactly one workspace. On load it asks which one: pick from the list (with entity counts), open a new/empty one by name, or **🗑 delete** a workspace right there. Reopen it any time with the **Workspaces…** button in the header; the header select switches directly.
- **🗑 Delete workspace button** (header) — deletes the current workspace with everything in it (entities, facts, relations), after a confirmation. Also available per-row in the workspace chooser. There is no undo — see *Backup & restore*.
- **＋ New node button** (header) — create a node (name, type, workspace, optional first fact) straight from the dashboard.
- **Clean up button** (header) — runs the `cleanup` maintenance pass against the current workspace and reports how many duplicate/orphaned records it removed. Same thing `npm run cleanup` does from the terminal.
- **Graph view** — force-directed layout of the memory. Node color = entity type (legend top-left), node size grows with fact count. **Click a legend row to hide/show that entity type** — a quick filter for large graphs (hidden types show struck-through). Drag nodes, pan the background, zoom with the mouse wheel, hover for a tooltip, click to inspect. Auto-fits the whole graph until you pan/zoom/drag; the **Fit** button (top-right of the canvas) snaps back.
- **Activity log** — live feed of every tool call and every dashboard edit, with arguments, duration and errors. Also appended to `data/activity.jsonl`.
- **Entities** — filterable list of everything stored; shows each entity's workspace when viewing *All workspaces*.
- **Details** — the selected node's id, facts (with ids) and relations, plus a full **node editor**: rename the node or change its type (**✎ Edit**), delete it (**🗑 Delete node**), add a fact / click a fact to edit it / delete a fact (**×**), and add or remove relations to other entities. Every edit is written through `POST /api/edit` and shows up in the activity log.
- **Tree** — at the bottom of *Details*, a collapsible tree rooted at the selected node, following relations `out` / `in` / `both` (toggle). Click any node in the tree to jump to it. This is the dashboard twin of the `tree` tool.

## Logging & debugging

Everything the server does lands in the **Activity log** (dashboard, with filter chips), in `data/activity.jsonl`, and on the daemon's stderr. Log kinds:

| Kind | What it records |
| --- | --- |
| `server` | daemon lifecycle (start, shutdown) |
| `agent` | an MCP client connected — the line names the agent, e.g. `graf-bridge (Claude Code, pid 1234)` |
| `tool` | every tool call: name, duration, arguments, and a preview of the result |
| `error` | failed tool calls, with the message |
| `debug` | every raw MCP request method — only when `GRAF_MCP_DEBUG=1` |
| `note` | lines injected from outside via `POST /api/log` |

**To check the connection works:** restart the agent, open the dashboard → *Activity log* → *Agents* filter — a `client connected: graf-bridge (Claude Code…)` (or `(Antigravity…)`) line appears the moment the agent starts the server. Then ask the agent to call any tool and watch the `tool` line arrive with its arguments and result.

**Verbose mode** — add `GRAF_MCP_DEBUG` to the agent's MCP config to also see every MCP request (`mcp initialize`, `mcp tools/list`, `mcp tools/call`, …):

```json
"graf-memory": {
  "command": "node",
  "args": ["C:/Users/Kuba/Desktop/GrafMCP_For_WorksSpace/src/index.js"],
  "env": { "GRAF_MCP_DEBUG": "1" }
}
```

Scripting endpoints: `GET /api/logs?after=<seq>` returns entries as JSON; `POST /api/log` with `{"kind":"note","message":"..."}` writes a line into the log (handy to mark test runs). The agent side of the pipe (bridge stderr: daemon spawning, reconnects) shows up in the agent's own MCP logs — in Claude Code check `/mcp` → graf-memory.

## Example: a long story with interlocking plot threads

Tell your agent (Claude Code or Antigravity) something like:

> Use the graf-memory tools while we write this story. Store every character, location, chapter and plot thread as entities with facts, and connect them (introduces, foreshadows, pays_off, appears_in, suspects…). Before writing each chapter, `expand` the chapter's characters and threads to depth 2 and stay consistent with what's stored. After each chapter, store what changed.

What this looks like in tool calls:

1. `remember {entity: "Aria Voss", entity_type: "character", observations: ["Captain of the salvage ship Kestrel", "Hides a debt to the Consortium"]}`
2. `remember {entity: "The Betrayal", entity_type: "plot_thread", observations: ["Someone on the crew sells the route to pirates", "Must pay off by chapter 9"]}`
3. `connect {from: "Chapter 1", to: "The Betrayal", relation_type: "foreshadows"}`
4. Next session, possibly in the *other* agent: `recall {query: "betrayal"}` → `expand {entity: "The Betrayal", depth: 2}` — and the agent has the thread, who's involved, and where it was planted.

Suggested entity types (free-form, they just color the dashboard): `character`, `location`, `plot_thread`, `chapter`, `event`, `decision`, `fact`. The same pattern works for code projects: `module`, `bug`, `decision`, `requirement`.

## Making agents use memory automatically

Agents only use tools they're reminded of. Add this to `CLAUDE.md` (Claude Code) or your rules/`AGENTS.md` (Antigravity):

```markdown
## Persistent memory
You have graph memory via the graf-memory MCP tools.
- Always pass workspace: "wh40k-titanfall" on every graf-memory call for this project.
- Start of a task: `recall` keywords from the request; `expand` (depth 2) the most relevant hit.
- When you learn a durable fact, decision, or plot point: `remember` it on the right entity.
- When two things are related: `connect` them with a snake_case verb.
- Never store secrets or credentials. Use `forget` when something becomes wrong.
- After a long session, call `cleanup` to remove any duplicate facts you left behind.
```

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `GRAF_MCP_PORT` | `7688` | Daemon port (MCP endpoint + dashboard) |
| `GRAF_MCP_DB` | `<this folder>/data/graph.kuzu` | Kuzu database location |
| `GRAF_MCP_WORKSPACE` | *(the launch folder's name)* | Overrides the automatic per-folder workspace. Set it to a fixed name to pin a project's workspace, or to `default` to restore the old single shared memory. |

Set them in the agent's MCP config (`env` block) — the bridge passes them to the daemon it spawns. Different port + different DB path = a second, fully independent memory (e.g. one per project).

## Workspaces

One daemon, one database, one dashboard — but memory is split into named **workspaces** so unrelated projects (a novel, a codebase, another novel) don't mix entities or collide on names. Two different workspaces can each have their own entity called "Chapter 1" without conflict; everything is tagged, not duplicated.

### Automatic per-folder workspace (the default)

**Each agent's workspace is chosen automatically, at startup, from the folder it was launched in** — the bridge uses the launch directory's name (its `cwd` basename) as the workspace and injects it into every tool call that doesn't name one. So a project is isolated by default with **no per-call `workspace` argument and no `CLAUDE.md` boilerplate**: an agent working in `C:/dev/wh40k-titanfall` automatically reads and writes the `wh40k-titanfall` workspace, and its memory never leaks into another project's.

Consequences:

- **Different folders → separate memory.** Two projects can't see or overwrite each other's entities, even though they share one daemon and database.
- **Same folder → shared memory.** Claude Code and Antigravity launched in the *same* project folder land in the *same* workspace, so they still collaborate on one graph — just scoped to that project.
- **Override with `GRAF_MCP_WORKSPACE`** in the agent's MCP `env` block: set a fixed name to pin the workspace regardless of folder, or set it to `default` to restore the old behavior where everything shares one `default` workspace.
- **Per-call override still wins.** Any tool call that passes an explicit `workspace` uses that one, ignoring the folder default.

You can still address workspaces by hand when you want to:

- `remember {entity: "Julius", entity_type: "character", observations: [...], workspace: "wh40k-titanfall"}`
- `recall {query: "julius", workspace: "wh40k-titanfall"}`
- `expand {entity: "Julius", depth: 2, workspace: "wh40k-titanfall"}`

Pass `workspace: "all"` on `recall`, `read_graph`, `find_nodes`, `search_facts` or `get_node` to search across every workspace at once (not valid on write tools, nor on `expand`/`tree` — they need one concrete workspace to start from). `list_workspaces` shows what already exists.

**Pinning a workspace name explicitly:** if you don't want the folder-name default, either set `GRAF_MCP_WORKSPACE` in the MCP config, or put the workspace name in that project's `CLAUDE.md` / `AGENTS.md` (e.g. `Always pass workspace: "wh40k-titanfall" to graf-memory tools.`). There's no per-connection "current workspace" state on the daemon (it's stateless per request) — the workspace travels with each call; the bridge's folder-name injection is what makes that automatic without you repeating it.

The dashboard always shows one workspace at a time: the chooser on load (or the **Workspaces…** button) picks which, and workspaces can be deleted from there or with the header's **🗑 Delete workspace** button. (Tools can still pass `workspace: "all"` — only the dashboard's all-at-once view is gone.)

### Full physical isolation (separate database)

Workspaces share one Kuzu database file — enough for keeping projects from colliding, but a bad `forget` or a corrupted database still affects everyone. For a project that needs a genuinely separate database (its own file, its own backup schedule, its own crash blast radius), give it its own port + DB path in its `.mcp.json` instead:

```json
{
  "mcpServers": {
    "graf-memory": {
      "command": "node",
      "args": ["C:/Users/Kuba/Desktop/GrafMCP_For_WorksSpace/src/index.js"],
      "env": {
        "GRAF_MCP_PORT": "7690",
        "GRAF_MCP_DB": "C:/path/to/that-project/.graf-memory/graph.kuzu"
      }
    }
  }
}
```

That project gets its own daemon, database and dashboard (`http://127.0.0.1:7690`), fully separate from the shared one. The same `env` block works in Antigravity's `mcp_config.json`.

## Docker

The daemon can run as a container instead of a local process ([Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml)). The image runs `src/daemon.js` with the MCP endpoint + dashboard on port 7688 and the database on a named volume `graf-data` — memory survives container rebuilds.

> On this machine there is no Docker Desktop; Docker lives **inside WSL Debian**, so prefix commands with `wsl -d Debian --`. The image `graf-mcp` is already built and was tested end-to-end (tool calls over HTTP + data persisted across a container restart).

```bash
# build and start (from this folder; inside WSL use the /mnt/c/... path)
docker compose up -d --build

# check
curl http://127.0.0.1:7688/api/health
node test/http-check.js write   # MCP round-trip against the container

# stop / logs
docker compose down
docker logs -f graf-memory
```

How agents connect to the containerized daemon — two options:

1. **Keep the stdio configs unchanged.** The bridge health-checks port 7688 first and uses whatever daemon answers — including the container. Caveat: if the container is down, the bridge silently starts a *local* daemon and your writes land in `data/` instead of the Docker volume — two diverging memories. Use `restart: unless-stopped` (already in the compose file) to avoid that.
2. **Connect over HTTP directly** (no bridge, container must be running):
   - Claude Code: `claude mcp add --scope user --transport http graf-memory http://127.0.0.1:7688/mcp`
   - Antigravity raw config: `"graf-memory": { "serverUrl": "http://127.0.0.1:7688/mcp" }`

**WSL caveat:** with Docker inside WSL (no Docker Desktop), the container only runs while the WSL VM does — Windows shuts the VM down a minute after its last console closes, killing the container (it comes back automatically on the next `wsl` command thanks to the restart policy). If you want the containerized daemon always-on, keep a WSL window open, set `vmIdleTimeout` in `.wslconfig`, or just use the local (non-Docker) daemon — that is the more practical default on this machine.

## Cleaning up duplicate memory

Long sessions — especially an agent re-storing the same fact across many `remember` calls — can leave exact duplicates behind. The `cleanup` tool (and the dashboard's **Clean up** button, and `npm run cleanup`) removes:

- **duplicate facts** — the same text stored twice on the same entity, keeping the earliest copy
- **orphaned fact records** — an `Observation` left with no owning entity (defensive; normal deletes always cascade, this only catches the abnormal case)

It never touches distinct facts, entities, or relations — safe to run any time. Scope it to one workspace or omit to clean everything:

```bash
npm run cleanup                        # clean every workspace
npm run cleanup -- wh40k-titanfall     # clean just that one
```

If an agent has been through a very long or chaotic session, running this afterward (or asking the agent to call the `cleanup` tool itself) is good hygiene. It's not a substitute for backups — see below.

## Backup & restore

The database is a working file, not an archive — a runaway agent can `forget` things it shouldn't (this has happened). Snapshot it periodically, especially after a long or heavily-automated session:

```bash
npm run backup                                                   # writes backups/memory-<timestamp>.json
npm run stop                                                     # restore needs exclusive access to the DB
npm run restore -- backups/memory-2026-07-17T22-47-22-411Z.json
```

`backup` reads the live daemon over HTTP (no need to stop it). `restore` writes directly to the database files, so the daemon must be stopped first; start it again afterward with `npm start` or by reconnecting an agent.

## Daemon management

| Action | Command |
| --- | --- |
| Start manually (foreground) | `npm start` |
| Stop | `npm run stop` |
| Test everything end-to-end | `npm test` |
| Snapshot memory to JSON | `npm run backup` |
| Restore a snapshot (daemon stopped) | `npm run restore -- <file>` |
| Remove duplicate/orphaned records | `npm run cleanup [-- <workspace>]` |
| Reset memory completely | `npm run stop`, then delete the `data/` folder |

You normally never start the daemon yourself — the first agent that connects does.

## Troubleshooting

- **Tools don't appear in the agent** — restart the agent / refresh its MCP servers; check the config path points at `src/index.js`; run `npm test` here to confirm the server itself is healthy.
- **Dashboard "daemon offline"** — no daemon running; connect an agent or run `npm start`.
- **`daemon did not become ready`** — something else owns port 7688 (`netstat -ano | findstr 7688`); either free it or set `GRAF_MCP_PORT` to another port in *both* agents' configs.
- **Database locked / won't open** — a stray daemon is holding it: `npm run stop` (or kill the `node` process from the dashboard footer's pid), then retry.
- **After updating this code** — bridges auto-restart an outdated daemon on next connect (version check); or just `npm run stop`.

---

## Szybki start (PL)

**GrafMCP** to lokalny serwer MCP dający agentom (Claude Code, Antigravity) **wspólną, trwałą pamięć grafową** na bazie Kuzu (baza zoptymalizowana pod wyszukiwanie grafowe) + **dashboard** na <http://127.0.0.1:7688> (podgląd grafu i log działań na żywo).

Na tym komputerze wszystko jest już skonfigurowane — wystarczy zrestartować Claude Code i Antigravity. Agent dostaje 12 narzędzi: `remember` (zapisz fakty), `connect` (połącz encje relacją), `recall` (szukaj po nazwach, typach i faktach), `expand` (pobierz sąsiedztwo w grafie), `find_nodes` (szukaj węzłów po nazwie), `search_facts` (szukaj węzłów po treści faktów), `get_node` (pobierz węzeł po id lub nazwie), `tree` (drzewo relacji), `read_graph` (całość), `forget` (usuń — encję, także po `node_id`), `list_workspaces` (lista przestrzeni roboczych), `cleanup` (usuń duplikaty). Agenci uruchomieni w **tym samym folderze** dzielą jedną pamięć; uruchomieni w różnych folderach mają pamięć oddzielną.

Przykład — długa historia z wieloma wątkami: poproś agenta, by każdą postać, rozdział i wątek zapisywał jako encję z faktami i łączył je relacjami (`foreshadows`, `appears_in`…), a przed pisaniem kolejnego rozdziału wywoływał `expand` na bohaterach rozdziału. Zarządzanie: `npm start` / `npm run stop` / `npm test`; pełny reset = stop + usunięcie folderu `data/`.

Baza danych: **Kuzu** — wbudowana (embedded) grafowa baza z językiem Cypher; wszystkie dane w folderze `data/`. **Przestrzeń robocza jest wybierana automatycznie z nazwy folderu, w którym startuje agent** (`cwd`), więc każdy projekt ma osobną pamięć bez podawania parametru `workspace` — dwa projekty mogą mieć encję o tej samej nazwie bez konfliktu. Można to nadpisać zmienną `GRAF_MCP_WORKSPACE` (stała nazwa albo `default`, by wrócić do jednej wspólnej pamięci) albo podając `workspace` w wywołaniu. Węzły można też tworzyć i edytować bezpośrednio w dashboardzie (przycisk **＋ New node**, edycja nazwy/typu/faktów/relacji w panelu *Details*, widok *Tree*). Pełna fizyczna izolacja (osobna baza) nadal możliwa przez własny `GRAF_MCP_PORT`/`GRAF_MCP_DB`. Duplikaty faktów po długiej sesji usuwa `npm run cleanup` lub przycisk **Clean up** w dashboardzie. Wersja w kontenerze: `wsl -d Debian -- docker compose up -d --build` (sekcja *Docker*).
