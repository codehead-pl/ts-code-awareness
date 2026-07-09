# tsca plugin wiring

How Claude Code connects to the engine:

```
Claude Code session
  │  spawns (stdio, cwd = project)
  ▼
packages/mcp-server  ── HTTP POST /rpc, header X-Project-Root: <cwd> ──►  packages/daemon
  (per-session shim)                                                       (shared, long-lived)
                                                                              │
                                                                              ▼
                                                                          packages/core
                                                                       (build → SQLite → tools)
```

- **`hooks/session-start.sh`** — the `SessionStart` hook. Ensures the shared
  daemon is running (idempotent; health-checks first, so it's safe to run every
  session). The daemon outlives individual sessions.
- **`../.mcp.json`** — registers the stdio shim as the `ts-code-awareness` MCP
  server. Claude Code asks you to approve it on first use.
- **`../.claude/settings.json`** — registers the SessionStart hook.

Only the tools whose adapter is detected for a project are exposed — a plain
TypeScript project sees the structural + semantic tools; a Nest + Prisma project
additionally gets the `nest_*` and `db_*` tools. The `data_*` live-data tools
appear only when a DB connection is configured (see
[`packages/live-data`](../packages/live-data)).

## Try it in this repo

`.mcp.json` and the hook are already wired, so opening this repo in Claude Code
(and approving the `ts-code-awareness` MCP server) gives you the tools over this
repo's own TypeScript. To point at the golden fixture instead:

```sh
# daemon must be up (the hook starts it; or: pnpm --filter @codehead-pl/tsca-daemon start)
pnpm exec tsx packages/mcp-server/test/client.ts "$PWD/fixtures/nest-monorepo"
```

## Configuration

- `TSCA_PORT` — daemon port (default `47600`).
- `TSCA_LRU` — number of warm projects kept in memory (default `3`).
- `TSCA_CACHE_DIR` — where per-project maps are cached (default
  `<repo>/.tsca-cache`).
- Live data is configured per project via `tsca.config.json` (a `liveData` block)
  or the `TSCA_DB_*` environment variables; absent config means the `data_*`
  tools don't exist for that project.
