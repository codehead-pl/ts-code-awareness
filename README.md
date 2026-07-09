# ts-code-awareness

A static-analysis **knowledge base for TypeScript / NestJS codebases**, served to
AI agents (like Claude Code) over MCP — so they can understand code **without
hallucinating and without spending many tokens**.

It reads the source under a project root (it **never boots the target app's
runtime**), builds a queryable map, and exposes framework-aware tools an LSP
can't give you: DI graphs, route tables, the Nest guard/pipe/interceptor
pipeline, the Prisma schema, and the entity↔code bridge — plus structural
discovery, semantic search, and optional read-only live-data tools.

## Why

TypeScript already ships a type checker and a language server, so "types,
go-to-def, find-references" are table stakes. The differentiation here is the
**framework-aware, pre-digested views no LSP gives you**, returned as compact,
chainable projections instead of raw source. An agent asks *"what actually runs
when `POST /users` is hit, and where does it touch the DB?"* and gets an answer
built from the route pipeline, the call graph, and the ORM access map — not a
pile of files to re-read.

Every answer is **honest about its own completeness**: reverse queries carry a
coverage envelope, call edges are tagged `exact | contract | unresolved`, and DB
access is tagged `typed | heuristic`. The engine never claims certainty it can't
prove.

## What it does

- **Structural map** — symbols, signatures, decorators, and a resolved edge graph
  (imports, calls, extends/implements/overrides, references, instantiations)
  across a whole pnpm/npm/yarn + nx/turbo **monorepo**, with cross-package
  resolution and a two-tier build (cheap skeleton for everything, full call graph
  on demand).
- **NestJS adapter** — the route table, DI/provider graph, module graph, and
  `nest_pipeline_for` (the effective guard → interceptor → pipe → filter chain for
  a handler, composed across all five registration levels in execution order).
  GraphQL resolvers and microservice/queue handlers when those packages are used.
- **Prisma adapter** — `schema.prisma` → models / relations / enums, the
  model↔code access bridge ("where is `User` written, with which fields"), and
  static migration/drift reports. The generated client is never read.
- **Semantic search** — NL discovery (`search`, `search_similar`) over a local,
  on-machine embedding index. Nothing leaves the machine.
- **Live data (optional, opt-in)** — read-only `data_*` tools against a configured
  DB connection, behind a **SELECT-only guard** that provably never mutates.

The full tool catalog is in **[`docs/tools.md`](docs/tools.md)** (~35 tools across
five categories; framework/DB/live tools light up only on detection).

## Architecture

A single shared, multi-tenant **HTTP daemon** — started by a Claude Code
`SessionStart` hook — holds warm maps under an LRU and routes each session to its
project by an `X-Project-Root` header. A per-session **stdio MCP shim** forwards
tool calls to it. The daemon walks the program once with `ts-morph`; **adapters**
(Nest, Prisma) read that one parsed program and contribute namespaced fragments,
so nothing framework-specific runs unless its framework is detected.

```
Claude Code session
  │  spawns (stdio, cwd = project)
  ▼
mcp-server  ──  HTTP /rpc, header X-Project-Root: <cwd>  ──►  daemon (shared, long-lived)
(per-session shim)                                             │  ts-morph walk → SQLite map
                                                               ▼
                                                   core + nest/prisma adapters → tools
```

## Layout

```
packages/
  core/           ts-morph walk → base map + tiers + fingerprint/incremental,
                  adapter registry, semantic index; SQLite store (node:sqlite)
  adapter-nest/   routes, DI/module graph, guard/pipe/interceptor/filter pipeline,
                  GraphQL + messaging
  adapter-prisma/ schema → models/relations, model↔code access bridge, migrations
  live-data/      optional read-only DB tools behind a SELECT-only guard
  daemon/         shared multi-tenant HTTP daemon + LRU + X-Project-Root routing
  mcp-server/     stdio MCP shim (per session; forwards to the daemon)
plugin/           Claude Code SessionStart hook + MCP wiring
fixtures/         golden nx/pnpm monorepo (Nest + Prisma) test bed
docs/tools.md     the MCP tool reference
```

## Use it with Claude Code

The engine is wired as a Claude Code plugin via `plugin/` — see
**[`plugin/README.md`](plugin/README.md)**. In short: a `SessionStart` hook starts
the shared daemon, `.mcp.json` registers the stdio shim as the `ts-code-awareness`
MCP server, and Claude Code asks you to approve it on first use. Opening this repo
in Claude Code (and approving `ts-code-awareness`) gives you the tools over this
repo's own TypeScript.

## Develop

```sh
pnpm install

# typecheck the whole workspace
pnpm typecheck

# the test suites (run against the golden fixture)
pnpm test:tiers      # structural map + incremental build
pnpm test:nest       # routes / DI / pipeline
pnpm test:prisma     # schema + model↔code bridge
pnpm test:semantic   # semantic search
pnpm test:live       # live-data guard + drivers (spins up throwaway DBs)

# run the daemon, then curl it
pnpm --filter @tsca/daemon start
curl -s localhost:47600/health

# drive the MCP shim the way Claude Code does
pnpm exec tsx packages/mcp-server/test/client.ts "$PWD/fixtures/nest-monorepo"

# compile to dist/
pnpm build
```

**Requirements:** Node ≥ 22.5 (uses built-in `node:sqlite` — no native modules).
Dev runs TypeScript directly via `tsx`; `pnpm build` compiles with `tsup`.

## Roadmap

Where it's headed — more framework and database adapters, cross-cutting bridges,
and a community adapter SDK — is in [`ROADMAP.md`](ROADMAP.md).

## License

[MIT](LICENSE) © Michał Tomczuk
