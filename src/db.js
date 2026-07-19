import fs from "node:fs";
import path from "node:path";
import kuzu from "kuzu";

const SCHEMA = [
  `CREATE NODE TABLE IF NOT EXISTS Entity(
     name STRING,
     type STRING,
     created STRING,
     updated STRING,
     PRIMARY KEY(name)
   )`,
  `CREATE NODE TABLE IF NOT EXISTS Observation(
     id SERIAL,
     text STRING,
     created STRING,
     PRIMARY KEY(id)
   )`,
  `CREATE REL TABLE IF NOT EXISTS HAS_OBSERVATION(FROM Entity TO Observation)`,
  `CREATE REL TABLE IF NOT EXISTS RELATES(FROM Entity TO Entity, type STRING, created STRING)`,
];

// Added after the initial release; kept as a separate idempotent migration
// step (ALTER TABLE has no IF NOT EXISTS) so existing databases upgrade in
// place without touching any stored entity/observation/relation data.
const MIGRATIONS = [`ALTER TABLE Entity ADD workspace STRING DEFAULT 'default'`];

export const DEFAULT_WORKSPACE = "default";
// sentinel meaning "no workspace filter, span every workspace"
const ALL_WORKSPACES = "all";

function now() {
  return new Date().toISOString();
}

/**
 * Entities are keyed by plain display name inside the default workspace
 * (unchanged since v1.0, so upgrading never rewrites existing rows) and by
 * `${workspace}::${name}` in any other workspace, which is what gives two
 * workspaces the ability to both have e.g. an entity called "Chapter 1"
 * without colliding.
 */
function keyOf(workspace, name) {
  const ws = workspace || DEFAULT_WORKSPACE;
  return ws === DEFAULT_WORKSPACE ? name : `${ws}::${name}`;
}

function displayName(key, workspace) {
  const ws = workspace || DEFAULT_WORKSPACE;
  if (ws === DEFAULT_WORKSPACE) return key;
  const prefix = `${ws}::`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export class GraphDB {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new kuzu.Database(dbPath);
    this.conn = new kuzu.Connection(this.db);
    this.path = dbPath;
  }

  async init() {
    for (const stmt of SCHEMA) {
      const res = await this.conn.query(stmt);
      res.close();
    }
    for (const stmt of MIGRATIONS) {
      try {
        const res = await this.conn.query(stmt);
        res.close();
      } catch (err) {
        if (!/already has property/i.test(err.message)) throw err;
      }
    }
  }

  /** Run a Cypher statement, optionally with $params, and return all rows. */
  async q(cypher, params = null) {
    let result;
    if (params) {
      const prepared = await this.conn.prepare(cypher);
      result = await this.conn.execute(prepared, params);
    } else {
      result = await this.conn.query(cypher);
    }
    const rows = await result.getAll();
    result.close();
    return rows;
  }

  async upsertEntity(name, type = "note", workspace = DEFAULT_WORKSPACE) {
    const ws = workspace || DEFAULT_WORKSPACE;
    const key = keyOf(ws, name);
    await this.q(
      `MERGE (e:Entity {name: $key})
       ON CREATE SET e.type = $type, e.workspace = $ws, e.created = $now, e.updated = $now
       ON MATCH SET e.updated = $now`,
      { key, type, ws, now: now() }
    );
    if (type && type !== "note") {
      // an explicit type on a later call refines an auto-created entity
      await this.q(`MATCH (e:Entity {name: $key}) SET e.type = $type`, { key, type });
    }
  }

  async addObservations(entityName, entityType, texts, workspace = DEFAULT_WORKSPACE) {
    const ws = workspace || DEFAULT_WORKSPACE;
    await this.upsertEntity(entityName, entityType, ws);
    const key = keyOf(ws, entityName);
    const added = [];
    for (const text of texts) {
      const rows = await this.q(
        `MATCH (e:Entity {name: $key})
         CREATE (o:Observation {text: $text, created: $now}),
                (e)-[:HAS_OBSERVATION]->(o)
         RETURN o.id AS id`,
        { key, text, now: now() }
      );
      added.push({ id: Number(rows[0].id), text });
    }
    return added;
  }

  async addRelation(from, to, type, fromType = "note", toType = "note", workspace = DEFAULT_WORKSPACE) {
    const ws = workspace || DEFAULT_WORKSPACE;
    await this.upsertEntity(from, fromType, ws);
    await this.upsertEntity(to, toType, ws);
    const fromKey = keyOf(ws, from);
    const toKey = keyOf(ws, to);
    await this.q(
      `MATCH (a:Entity {name: $fromKey}), (b:Entity {name: $toKey})
       MERGE (a)-[r:RELATES {type: $type}]->(b)
       ON CREATE SET r.created = $now`,
      { fromKey, toKey, type, now: now() }
    );
  }

  async entityExists(name, workspace = DEFAULT_WORKSPACE) {
    const key = keyOf(workspace, name);
    const rows = await this.q(`MATCH (e:Entity {name: $key}) RETURN e.name AS name`, { key });
    return rows.length > 0;
  }

  async observationsOf(name, workspace = DEFAULT_WORKSPACE) {
    const key = keyOf(workspace, name);
    const rows = await this.q(
      `MATCH (e:Entity {name: $key})-[:HAS_OBSERVATION]->(o:Observation)
       RETURN o.id AS id, o.text AS text, o.created AS created
       ORDER BY o.id`,
      { key }
    );
    return rows.map((r) => ({ id: Number(r.id), text: r.text, created: r.created }));
  }

  /**
   * Directed relations touching an entity (both incoming and outgoing).
   * Both ends of a relation always live in the same workspace (connect()
   * only links within one workspace), so `workspace` applies to both sides.
   */
  async relationsOf(name, workspace = DEFAULT_WORKSPACE) {
    const key = keyOf(workspace, name);
    const out = await this.q(
      `MATCH (a:Entity {name: $key})-[r:RELATES]->(b:Entity)
       RETURN a.name AS from, r.type AS type, b.name AS to`,
      { key }
    );
    const inc = await this.q(
      `MATCH (a:Entity)-[r:RELATES]->(b:Entity {name: $key})
       RETURN a.name AS from, r.type AS type, b.name AS to`,
      { key }
    );
    return [...out, ...inc].map((r) => ({
      from: displayName(r.from, workspace),
      type: r.type,
      to: displayName(r.to, workspace),
    }));
  }

  async getEntity(name, workspace = DEFAULT_WORKSPACE) {
    const key = keyOf(workspace, name);
    const rows = await this.q(
      `MATCH (e:Entity {name: $key})
       RETURN offset(ID(e)) AS id, e.name AS name, e.type AS type, e.workspace AS workspace, e.created AS created, e.updated AS updated`,
      { key }
    );
    if (rows.length === 0) return null;
    return {
      ...rows[0],
      id: Number(rows[0].id),
      name: displayName(rows[0].name, workspace),
      observations: await this.observationsOf(name, workspace),
      relations: await this.relationsOf(name, workspace),
    };
  }

  /**
   * "Search node by id": look up one entity by its numeric node id
   * (offset(ID)). Node ids are unique across the whole Entity table, so this
   * ignores workspace unless one is given to constrain the result.
   */
  async getNodeById(id, workspace = ALL_WORKSPACES) {
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const rows = await this.q(
      `MATCH (e:Entity)
       WHERE offset(ID(e)) = $id ${scoped ? "AND e.workspace = $ws" : ""}
       RETURN e.name AS name, e.type AS type, e.workspace AS workspace, e.created AS created, e.updated AS updated`,
      scoped ? { id: Math.trunc(id), ws: workspace } : { id: Math.trunc(id) }
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const disp = displayName(row.name, row.workspace);
    return {
      id: Math.trunc(id),
      ...row,
      name: disp,
      observations: await this.observationsOf(disp, row.workspace),
      relations: await this.relationsOf(disp, row.workspace),
    };
  }

  /**
   * "Search node by name (like)": case-insensitive substring match over
   * entity names only (unlike `search`, which also scans fact text). `*` and
   * `%` in the query are treated as ordinary wildcards and stripped to the
   * bare substring. Returns id/name/type/workspace/fact-count rows.
   */
  async findNodes(query, workspace = DEFAULT_WORKSPACE, limit = 25) {
    const q = String(query || "").toLowerCase().replace(/[%*]/g, "");
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const wsClause = scoped ? "AND e.workspace = $ws" : "";
    const params = scoped ? { q, ws: workspace } : { q };
    const rows = await this.q(
      `MATCH (e:Entity)
       WHERE contains(lower(e.name), $q) ${wsClause}
       OPTIONAL MATCH (e)-[:HAS_OBSERVATION]->(o:Observation)
       WITH e, count(o) AS facts
       RETURN offset(ID(e)) AS id, e.name AS name, e.type AS type, e.workspace AS workspace, facts
       ORDER BY e.name`,
      params
    );
    return rows.slice(0, Math.max(1, Math.trunc(limit))).map((r) => ({
      id: Number(r.id),
      name: displayName(r.name, r.workspace),
      type: r.type,
      workspace: r.workspace,
      facts: Number(r.facts),
    }));
  }

  /**
   * "Search by facts": find entities that have a FACT (observation) whose text
   * matches a substring — the fact-text counterpart to `findNodes` (which
   * matches names only). Returns each matching node together with the specific
   * facts that matched, so the caller sees *why* it was returned. `*`/`%` are
   * stripped to the bare substring; scoped to one workspace unless "all".
   */
  async findByFact(query, workspace = DEFAULT_WORKSPACE, limit = 25) {
    const q = String(query || "").toLowerCase().replace(/[%*]/g, "");
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const wsClause = scoped ? "AND e.workspace = $ws" : "";
    const params = scoped ? { q, ws: workspace } : { q };
    const rows = await this.q(
      `MATCH (e:Entity)-[:HAS_OBSERVATION]->(o:Observation)
       WHERE contains(lower(o.text), $q) ${wsClause}
       RETURN offset(ID(e)) AS id, e.name AS name, e.type AS type, e.workspace AS workspace, o.id AS oid, o.text AS text
       ORDER BY e.name, o.id`,
      params
    );
    const byEntity = new Map();
    for (const r of rows) {
      const dk = `${r.workspace}::${r.name}`;
      let node = byEntity.get(dk);
      if (!node) {
        node = {
          id: Number(r.id),
          name: displayName(r.name, r.workspace),
          type: r.type,
          workspace: r.workspace,
          matches: [],
        };
        byEntity.set(dk, node);
      }
      node.matches.push({ id: Number(r.oid), text: r.text });
    }
    return [...byEntity.values()].slice(0, Math.max(1, Math.trunc(limit)));
  }

  /**
   * "See tree": a hierarchical view rooted at one entity, following relation
   * edges outward (direction 'out' | 'in' | 'both') up to `depth` hops. Unlike
   * `expand` (which returns flat entity/relation lists), this nests children
   * under their parent. Cycles are cut: a node already expanded elsewhere in
   * the tree is emitted once more with `repeated: true` and no children.
   */
  async tree(rootName, depth = 2, workspace = DEFAULT_WORKSPACE, direction = "out") {
    const maxDepth = Math.max(1, Math.min(5, Math.trunc(depth)));
    const dir = ["out", "in", "both"].includes(direction) ? direction : "out";
    const expanded = new Set();
    const build = async (name, level) => {
      const key = keyOf(workspace, name);
      const rows = await this.q(`MATCH (e:Entity {name: $key}) RETURN e.type AS type`, { key });
      if (rows.length === 0) return null;
      const facts = (await this.observationsOf(name, workspace)).length;
      const node = { name, type: rows[0].type, facts, children: [] };
      if (expanded.has(name)) { node.repeated = true; return node; }
      expanded.add(name);
      if (level >= maxDepth) return node;
      for (const r of await this.relationsOf(name, workspace)) {
        const isOut = r.from === name;
        if (dir === "out" && !isOut) continue;
        if (dir === "in" && isOut) continue;
        const childName = isOut ? r.to : r.from;
        if (childName === name) continue; // skip self-loops in the tree view
        const child = await build(childName, level + 1);
        if (child) node.children.push({ relation: r.type, direction: isOut ? "out" : "in", node: child });
      }
      return node;
    };
    return await build(rootName, 0);
  }

  /**
   * Case-insensitive substring search over entity names, types and
   * observation text, scoped to one workspace unless `workspace` is "all".
   * Returns {name, workspace} pairs (name hits ranked first).
   */
  async search(query, workspace = DEFAULT_WORKSPACE) {
    const q = query.toLowerCase();
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const wsClause = scoped ? "AND e.workspace = $ws" : "";
    const params = scoped ? { q, ws: workspace } : { q };
    const byName = await this.q(
      `MATCH (e:Entity)
       WHERE (contains(lower(e.name), $q) OR contains(lower(e.type), $q)) ${wsClause}
       RETURN e.name AS name, e.workspace AS workspace`,
      params
    );
    const byObs = await this.q(
      `MATCH (e:Entity)-[:HAS_OBSERVATION]->(o:Observation)
       WHERE contains(lower(o.text), $q) ${wsClause}
       RETURN DISTINCT e.name AS name, e.workspace AS workspace`,
      params
    );
    const seen = new Set();
    const results = [];
    for (const r of [...byName, ...byObs]) {
      const dk = `${r.workspace}::${r.name}`;
      if (!seen.has(dk)) {
        seen.add(dk);
        results.push({ name: displayName(r.name, r.workspace), workspace: r.workspace });
      }
    }
    return results;
  }

  /**
   * Breadth-first neighborhood expansion around an entity, up to `depth`
   * hops over RELATES edges. Traversal never crosses workspaces (relations
   * only ever link within one). Returns entities (with observations) and
   * the relations connecting them, all using display names.
   */
  async expand(name, depth = 1, workspace = DEFAULT_WORKSPACE) {
    depth = Math.max(1, Math.min(3, Math.trunc(depth)));
    const visited = new Set([name]);
    const relations = [];
    const relKeys = new Set();
    let frontier = [name];
    for (let hop = 0; hop < depth; hop++) {
      const next = [];
      for (const n of frontier) {
        for (const r of await this.relationsOf(n, workspace)) {
          const key = `${r.from}|${r.type}|${r.to}`;
          if (!relKeys.has(key)) {
            relKeys.add(key);
            relations.push(r);
          }
          for (const other of [r.from, r.to]) {
            if (!visited.has(other)) {
              visited.add(other);
              next.push(other);
            }
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    const entities = [];
    for (const n of visited) {
      const key = keyOf(workspace, n);
      const rows = await this.q(
        `MATCH (e:Entity {name: $key}) RETURN e.name AS name, e.type AS type`,
        { key }
      );
      if (rows.length > 0) {
        entities.push({
          name: displayName(rows[0].name, workspace),
          type: rows[0].type,
          observations: await this.observationsOf(n, workspace),
        });
      }
    }
    return { entities, relations };
  }

  async allEntities(workspace = ALL_WORKSPACES) {
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const rows = await this.q(
      `MATCH (e:Entity)
       ${scoped ? "WHERE e.workspace = $ws" : ""}
       RETURN offset(ID(e)) AS id, e.name AS name, e.type AS type, e.workspace AS workspace, e.created AS created, e.updated AS updated
       ORDER BY e.workspace, e.name`,
      scoped ? { ws: workspace } : undefined
    );
    return rows.map((r) => ({ ...r, id: Number(r.id), name: displayName(r.name, r.workspace) }));
  }

  async allObservations(workspace = ALL_WORKSPACES) {
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const rows = await this.q(
      `MATCH (e:Entity)-[:HAS_OBSERVATION]->(o:Observation)
       ${scoped ? "WHERE e.workspace = $ws" : ""}
       RETURN e.name AS entity, e.workspace AS workspace, o.id AS id, o.text AS text, o.created AS created
       ORDER BY o.id`,
      scoped ? { ws: workspace } : undefined
    );
    return rows.map((r) => ({ ...r, id: Number(r.id), entity: displayName(r.entity, r.workspace) }));
  }

  async allRelations(workspace = ALL_WORKSPACES) {
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const rows = await this.q(
      `MATCH (a:Entity)-[r:RELATES]->(b:Entity)
       ${scoped ? "WHERE a.workspace = $ws" : ""}
       RETURN a.name AS from, a.workspace AS workspace, r.type AS type, b.name AS to, r.created AS created`,
      scoped ? { ws: workspace } : undefined
    );
    return rows.map((r) => ({
      from: displayName(r.from, r.workspace),
      type: r.type,
      to: displayName(r.to, r.workspace),
      workspace: r.workspace,
      created: r.created,
    }));
  }

  /** Distinct workspaces with entity counts, e.g. for a picker UI. */
  async listWorkspaces() {
    const rows = await this.q(
      `MATCH (e:Entity) RETURN e.workspace AS workspace, count(e) AS entities ORDER BY workspace`
    );
    return rows.map((r) => ({ workspace: r.workspace, entities: Number(r.entities) }));
  }

  async deleteEntity(name, workspace = DEFAULT_WORKSPACE) {
    const key = keyOf(workspace, name);
    await this.q(
      `MATCH (e:Entity {name: $key})-[:HAS_OBSERVATION]->(o:Observation) DETACH DELETE o`,
      { key }
    );
    await this.q(`MATCH (e:Entity {name: $key}) DETACH DELETE e`, { key });
  }

  async deleteRelation(from, to, type = null, workspace = DEFAULT_WORKSPACE) {
    const fromKey = keyOf(workspace, from);
    const toKey = keyOf(workspace, to);
    if (type) {
      await this.q(
        `MATCH (a:Entity {name: $fromKey})-[r:RELATES {type: $type}]->(b:Entity {name: $toKey}) DELETE r`,
        { fromKey, toKey, type }
      );
    } else {
      await this.q(
        `MATCH (a:Entity {name: $fromKey})-[r:RELATES]->(b:Entity {name: $toKey}) DELETE r`,
        { fromKey, toKey }
      );
    }
  }

  async deleteObservation(id) {
    await this.q(`MATCH (o:Observation) WHERE o.id = $id DETACH DELETE o`, { id: Math.trunc(id) });
  }

  /** Delete an entity addressed by its numeric node id. Returns its name, or null. */
  async deleteEntityById(id, workspace = ALL_WORKSPACES) {
    const node = await this.getNodeById(id, workspace);
    if (!node) return null;
    await this.deleteEntity(node.name, node.workspace);
    return { name: node.name, workspace: node.workspace };
  }

  /** Delete one entire workspace: every entity in it, their facts and their relations. */
  async deleteWorkspace(workspace) {
    if (!workspace || workspace === ALL_WORKSPACES) throw new Error("a concrete workspace name is required");
    const [c] = await this.q(`MATCH (e:Entity) WHERE e.workspace = $ws RETURN count(e) AS c`, { ws: workspace });
    await this.q(
      `MATCH (e:Entity)-[:HAS_OBSERVATION]->(o:Observation) WHERE e.workspace = $ws DETACH DELETE o`,
      { ws: workspace }
    );
    await this.q(`MATCH (e:Entity) WHERE e.workspace = $ws DETACH DELETE e`, { ws: workspace });
    return { workspace, entitiesRemoved: Number(c.c) };
  }

  // --- edit operations (used by the dashboard's node editor) ----------------

  /** Create (or, if it already exists, keep) an entity. Returns whether it was new. */
  async createEntity(name, type = "note", workspace = DEFAULT_WORKSPACE) {
    const existed = await this.entityExists(name, workspace);
    await this.upsertEntity(name, type || "note", workspace);
    return { created: !existed, name, type: type || "note", workspace: workspace || DEFAULT_WORKSPACE };
  }

  /** Change an entity's type in place. */
  async setEntityType(name, type, workspace = DEFAULT_WORKSPACE) {
    const key = keyOf(workspace, name);
    await this.q(`MATCH (e:Entity {name: $key}) SET e.type = $type, e.updated = $now`, {
      key,
      type: type || "note",
      now: now(),
    });
  }

  /** Edit the text of a single fact. */
  async updateObservation(id, text) {
    await this.q(`MATCH (o:Observation) WHERE o.id = $id SET o.text = $text`, {
      id: Math.trunc(id),
      text,
    });
  }

  /**
   * Rename an entity. Kuzu forbids updating a primary key, so this is done as
   * copy-then-delete: a new node is created under the new name, its facts and
   * relations (in both directions) are recreated on it, and the old node is
   * removed. Observation ids change as a result; entity identity (by name)
   * transfers cleanly. Throws if the target name is taken or the source is gone.
   */
  async renameEntity(oldName, newName, workspace = DEFAULT_WORKSPACE) {
    const ws = workspace || DEFAULT_WORKSPACE;
    if (!newName || !newName.trim()) throw new Error("new name is required");
    newName = newName.trim();
    if (oldName === newName) return;
    const oldKey = keyOf(ws, oldName);
    const newKey = keyOf(ws, newName);
    const src = await this.q(`MATCH (e:Entity {name: $k}) RETURN e.type AS type, e.created AS created`, { k: oldKey });
    if (src.length === 0) throw new Error(`Entity '${oldName}' not found in workspace '${ws}'`);
    const taken = await this.q(`MATCH (e:Entity {name: $k}) RETURN e.name AS n`, { k: newKey });
    if (taken.length > 0) throw new Error(`Entity '${newName}' already exists in workspace '${ws}'`);

    const obs = await this.observationsOf(oldName, ws);
    const rels = await this.relationsOf(oldName, ws);
    await this.q(
      `CREATE (e:Entity {name: $k, type: $type, workspace: $ws, created: $created, updated: $now})`,
      { k: newKey, type: src[0].type, ws, created: src[0].created || now(), now: now() }
    );
    for (const o of obs) {
      await this.q(
        `MATCH (e:Entity {name: $k})
         CREATE (o:Observation {text: $text, created: $created}), (e)-[:HAS_OBSERVATION]->(o)`,
        { k: newKey, text: o.text, created: o.created || now() }
      );
    }
    for (const r of rels) {
      const from = r.from === oldName ? newName : r.from;
      const to = r.to === oldName ? newName : r.to;
      await this.addRelation(from, to, r.type, "note", "note", ws);
    }
    await this.deleteEntity(oldName, ws);
    return { from: oldName, to: newName, workspace: ws };
  }

  async stats(workspace = ALL_WORKSPACES) {
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const wsFilter = scoped ? "WHERE e.workspace = $ws" : "";
    const params = scoped ? { ws: workspace } : undefined;
    const [e] = await this.q(`MATCH (e:Entity) ${wsFilter} RETURN count(e) AS c`, params);
    const [o] = await this.q(
      `MATCH (e:Entity)-[:HAS_OBSERVATION]->(o:Observation) ${wsFilter} RETURN count(o) AS c`,
      params
    );
    const [r] = await this.q(
      `MATCH (e:Entity)-[rel:RELATES]->() ${wsFilter} RETURN count(rel) AS c`,
      params
    );
    return {
      entities: Number(e.c),
      observations: Number(o.c),
      relations: Number(r.c),
    };
  }

  /**
   * Safe, non-destructive-to-unique-content maintenance pass:
   *  - collapses exact-duplicate facts (same entity, byte-identical text),
   *    keeping the earliest (lowest id)
   *  - removes Observation rows left with no owning entity (defensive; the
   *    normal delete paths always cascade, but this catches any that don't)
   * Never touches distinct facts, entities or relations. Optionally scoped
   * to one workspace; omit to clean the whole database.
   */
  async cleanup(workspace = ALL_WORKSPACES) {
    const scoped = workspace && workspace !== ALL_WORKSPACES;
    const rows = await this.q(
      `MATCH (e:Entity)-[:HAS_OBSERVATION]->(o:Observation)
       ${scoped ? "WHERE e.workspace = $ws" : ""}
       RETURN e.name AS entity, o.id AS id, o.text AS text
       ORDER BY o.id`,
      scoped ? { ws: workspace } : undefined
    );
    const seen = new Set();
    const dupeIds = [];
    for (const r of rows) {
      const dk = `${r.entity} ${r.text}`;
      if (seen.has(dk)) dupeIds.push(Number(r.id));
      else seen.add(dk);
    }
    for (const id of dupeIds) await this.deleteObservation(id);

    const orphanRows = await this.q(
      `MATCH (o:Observation)
       OPTIONAL MATCH (e:Entity)-[:HAS_OBSERVATION]->(o)
       WITH o, e WHERE e IS NULL
       RETURN o.id AS id`
    );
    for (const r of orphanRows) await this.deleteObservation(Number(r.id));

    return { duplicateObservationsRemoved: dupeIds.length, orphanObservationsRemoved: orphanRows.length };
  }
}
