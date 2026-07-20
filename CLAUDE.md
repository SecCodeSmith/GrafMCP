# GrafMCP — Graph Memory for LLM Context

A persistent, graph-based memory system for AI agents using Kuzu embedded database and Model Context Protocol (MCP).

## Project Overview

**graf-memory** is a shared daemon that manages a knowledge graph where agents store and retrieve facts, entities, and relationships. Multiple Claude Code instances connect to one daemon, sharing the same memory graph organized by workspaces.

## Architecture

- **src/index.js** — Stdio bridge: spawns the daemon and proxies MCP requests
- **src/daemon.js** — MCP server: owns the Kuzu database, exposes tools and resources
- **src/db.js** — GraphDB: Cypher-based entity/observation/relation operations
- **src/logger.js** — Activity log for the dashboard
- **src/ui.html** — Web dashboard at http://127.0.0.1:7688

## Workspace Configuration

This project uses the **GrafMCP** workspace to isolate its memory from other projects:
- Workspace: `grafmcp`
- Database: `./data/graph.kuzu`
- Dashboard: `http://127.0.0.1:7688`

## MCP Tools

All GraphDB methods are exposed as MCP tools:
- **Memory ops**: remember, connect, recall, expand, find_nodes, search_facts
- **Graph queries**: get_node, tree, read_graph, list_workspaces
- **Direct access**: create_entity_direct, set_entity_type, rename_entity, update_fact
- **Cleanup**: forget, delete_entity_direct, delete_relation_direct, delete_workspace, cleanup
- **Monitoring**: get_stats

## Environment Variables

- `GRAF_MCP_PORT` — HTTP port (default: 7688)
- `GRAF_MCP_HOST` — Bind address (default: 127.0.0.1, set to 0.0.0.0 in Docker)
- `GRAF_MCP_WORKSPACE` — Workspace name (default: folder basename)
- `GRAF_MCP_DB` — Database file path (default: ./data/graph.kuzu)
- `GRAF_MCP_DEBUG` — Enable request logging (set to "1")

## Token Optimization

All GraphDB functions are exposed directly as MCP tools to minimize token overhead:
- No custom agent logic needed to access graph operations
- Direct tool calls reduce serialization/parsing overhead
- Workspace isolation prevents memory leaks between projects
