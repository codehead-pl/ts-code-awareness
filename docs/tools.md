# Tool reference (MCP surface)

The tools an agent calls over MCP. Each is a thin, indexed query returning a
**compact projection** over the map — never a raw dump. The guiding constraint is
the project's reason for existing: **let the agent understand the code without
hallucinating and without spending many tokens.**

Tools are grouped into five categories:

- **A. Structural discovery** (`core.*`) — always available.
- **B. Framework: HTTP & DI** (`nest_*`) — only when the Nest adapter is active.
- **C. Database** (`db_*`) — only when the Prisma adapter is active.
- **D. Semantic search** — when the semantic index exists.
- **E. Live data** (`data_*`) — only when a DB connection is configured.

Adapter tools **do not appear** in the tool list unless their adapter detects
(`detect()`), so a plain Express + Drizzle project sees only categories A + D.

---

## Conventions (apply to every tool)

**Symbol references.** Inputs take either a `symbol` (a `SymbolId`) or a `name`.
A `name` is resolved to a symbol; if ambiguous the tool returns the candidate
list instead of guessing. Outputs **always** return `SymbolId`s so the agent can
chain `find → pick id → expand id` without re-sending source.

**Compact projection.** List-style tools return the minimum to decide the next
call: `{ id, kind, name, signature, span }`. Detail tools expand one id. Spans
(`{file, startLine..endLine}`) are always included so the agent opens exact
ranges, never whole files.

**View.** Detail tools accept `view: "summary" | "full"` (default `"summary"`).
Verbosity is opt-in — the default payload stays compact; `"full"` adds bodies,
all members, full decorator args, etc.

**No checker at query time.** Everything is precomputed at build; tools read the
DB only.

**Pagination.** List tools accept `limit` (default 50) + `cursor`; responses
carry `nextCursor` when truncated. Truncation is never silent.

**Coverage envelope** (reverse/cross-package tools only). Responses include:
```jsonc
"coverage": { "scanned": 12, "total": 50, "unit": "packages",
              "complete": false, "expand": "re-run with scope:'all'" }
```
`complete:false` means the answer is scoped — the agent is told, explicitly, that
more may exist. This is the anti-hallucination contract.

**Scope** (reverse tools). `scope: "closure" | "all"`:
- structural reverse (implementers/subclasses/importers) defaults to `"all"` —
  complete and cheap via the Tier-1 skeleton.
- call-level reverse (callers) defaults to `"closure"` — complete within the
  active dependency closure; `"all"` hydrates more packages on demand.

**Degradation flags.** Tools surface honesty markers rather than hiding them:
call edges carry `resolved` (`exact|contract|unresolved`); prisma access carries
`confidence` (`typed|heuristic`); schema fragments carry `clientStale`.

---

## A. Structural discovery — `core.*` (always on)

### `overview() → ProjectOverview`
Orientation; the "start here" tool. Workspace tool + package count, detected
adapters/frameworks + ORM, entrypoint counts by kind, symbol/file totals, build
freshness (`builtAt`, tier coverage, timings, map size). No input.

### `list_packages() → Package[]`
Workspace packages + the dependency DAG (`name, root, tsconfig, workspaceDeps`).

### `find_symbols({ name?, kind?, package?, file?, exported?, limit, cursor }) → SymbolRef[]`
Structural (non-semantic) symbol lookup by name/kind/filters. Returns
`{id, kind, name, signature, span, package}`.

### `get_symbol({ symbol|name, members? }) → SymbolDetail`
The workhorse expand. Full detail for one symbol: `signature`, `doc`,
`decorators`, `params`, `returns`, `visibility`, `flags`, `span`; for
class/interface, its `members` when `members:true`.

### `get_file({ file }) → FileDetail`
Browse a file without reading it: `exports`, top-level symbol ids + signatures,
imports (resolved).

### `explain_symbol({ symbol|name }) → SymbolDossier`
Bounded orientation composite ("what is X and how does it sit in the system") in
**one** call: `detail` + `relations`/`usages` as counts + ranked top-N pointers +
`roles` (adapter facets — route / provider / db-access — when the relevant
adapter is active) + `coverage`. Everything is a pointer; depth goes through the
primitives.

### `relations({ target, kinds?, transitive? }) → { edges, coverage }`
Outbound edges from a symbol **or file**: `calls`, `imports`, `extends`,
`implements`, `references`, `instantiates` (default: all). Forward = bounded by
the dependency closure, so complete. Each edge carries `resolved`; `contract`
call edges link to the declared method — expand real targets with `implementers`.

### `usages({ target, kinds?, transitive?, scope? }) → { edges, coverage }`
Inbound edges into a symbol/file — "what uses X": `calls`, `references`,
`imports` (default: all). Reverse, coverage-reported. `unresolved` callers are
omitted but summarized (count + `grep` hint). For the type hierarchy use
`implementers` / `subclasses`.

### `implementers({ symbol }) → { hits, coverage }`
Classes implementing an interface / extending an abstract. **Complete** via
skeleton.

### `subclasses({ symbol, transitive? }) → { hits, coverage }`
Classes extending a class (optionally transitive).

### `call_paths({ from, to, maxDepth? }) → Path[]`
Path(s) between two symbols over call/`contract` edges, DI-refined when Nest is
active. Answers "how does this route handler reach a DB write." Bounded depth;
reports truncation.

### `entrypoints({ kind? }) → Entrypoint[]`
Entrypoints by kind (`bin|package-main|nest-bootstrap|route-handler|
graphql-resolver|queue-consumer|event-handler`). Core + adapter-contributed.

### `type_of({ symbol|param }) → TypeRef`
Resolved rendered type for a symbol/param/return + link to the head symbol.

---

## B. Framework: HTTP & DI — `nest_*` (Nest adapter active)

### `nest_routes({ method?, path?, controller?, limit, cursor }) → RouteRef[]`
The HTTP route table. `{ id, method, path, controllerSymbol, handlerSymbol,
guards[], span }`.

### `nest_route({ route|handler }) → RouteDetail`
One route, fully expanded: the **ordered** guard → interceptor → pipe → handler
chain (resolved to symbols, incl. globally-registered), request params
(`@Body/@Param/@Query` with DTO type links), and response type.

### `nest_pipeline_for({ handler|controller }) → Pipeline`
"What actually runs for this request" — the effective chain across all **five**
registration levels (method / controller / param decorators, global-via-DI
`APP_*` providers, global-via-bootstrap `useGlobalX`) composed in Nest's
execution order: guards → interceptors(pre) → pipes → handler →
interceptors(post) → exception filters. Each element tagged with `source`
(`global-bootstrap|global-di|controller|method|param`), `resolved`, and
construction style. Carries a `complete` flag that flips to `false` — with the
unresolved `main.ts` span — whenever a bootstrap global can't be statically
resolved. Never claims completeness it can't prove.

### `nest_controllers({ limit, cursor }) → ControllerRef[]`
Controllers with base path + route count + symbol id.

### `nest_providers({ module?, token?, scope?, limit, cursor }) → ProviderBinding[]`
DI providers: `{ token, providerType (useClass|useFactory|useValue|useExisting),
scope, moduleSymbol, providesSymbol }`. Filterable.

### `nest_resolve_token({ token, fromModule? }) → Resolution`
"What provides token X" (optionally as visible from a module): the binding(s),
concrete provider symbol, defining module, and whether it's exported/visible.

### `nest_injected_into({ symbol|token, scope? }) → { hits, coverage }`
"Where is X injected" — reverse DI edge: constructors/params that receive it.

### `nest_module_graph({ root? }) → ModuleGraph`
Module import/export graph: each module's imports/providers/exports and the
effective provider visibility across the graph.

### `nest_module({ module }) → ModuleDetail`
One module: imports, providers, controllers, exports, and which external
providers become visible through its imports.

### `nest_graphql({ kind? }) → GraphQLNode[]`  *(when `@nestjs/graphql` is present)*
Resolvers / queries / mutations / `@ResolveField`s with return types + handler
symbols + parent object type.

### `nest_messaging({ kind? }) → MessageHandler[]`  *(when microservices/queues are present)*
`@MessagePattern` / `@EventPattern` handlers and BullMQ consumers: pattern/topic,
payload type, handler symbol.

---

## C. Database — `db_*` (Prisma adapter active)

### `db_models({ limit, cursor }) → ModelRef[]`
Models: `{ name, table, fieldCount, relationSummary, clientStale }`.

### `db_model({ model }) → ModelDetail`
One model: fields (`name, type, dbType, nullable, default, attributes`),
relations (`name, target, kind, fk`), indexes, uniques, id.

### `db_er({ around?, depth? }) → ERGraph`
Entity-relationship graph (models + relations). Filter to a subgraph around one
model at a given relation depth.

### `db_model_usage({ model, rw?, scope? }) → { accesses, coverage }`
**The model↔code bridge.** Where a model is read/written in code: `{ op, rw,
fields[], callerSymbol, span, confidence }`. Filter by `rw`. Answers "where is
User written."

### `db_enums() → EnumDef[]`
Prisma enums (name + members).

### `db_raw_queries({ limit, cursor }) → RawQuery[]`
Captured `$queryRaw` sites: SQL text + caller symbol + span.

### `db_migrations() → MigrationReport`
**Static** migration understanding — reads migration files + `schema.prisma`, no
execution. Reports applied/pending migrations and schema-vs-migrations drift.

---

## D. Semantic search

### `search({ query, kind?, package?, limit }) → { hits, coverage }`
NL discovery. Returns ranked chunks → `{ anchor (symbolId|fragmentId), level,
score, span, snippet }`. `kind` filters `code|doc|schema`. The "where is X" entry
point; hand `anchor` to the structural tools.

### `search_similar({ symbol, limit }) → Hit[]`
Symbols semantically nearest a given symbol (find analogous handlers, potential
duplication).

---

## E. Live data (DB connection configured; guarded)

Absolute invariant: **never mutates the target DB.** A weaker property — *never
executes* — is relaxed in exactly one place (opt-in `EXPLAIN ANALYZE` on SELECT).

### `data_tables({ schema? }) → TableInfo[]`
Live tables/columns from the actual connection; reconciled against Prisma model
mapping (flags drift).

### `data_sample({ table, limit? }) → Rows`
Sample rows (read-only, hard row cap).

### `data_query({ sql, limit? }) → Rows`
Run a **SELECT-only** query (parsed + rejected if it mutates), statement timeout
+ row cap enforced.

### `data_explain({ sql | model, op?, analyze? }) → Plan`
`EXPLAIN` a query, or the query a given access op would run. `analyze: true` runs
`EXPLAIN ANALYZE` — **SELECT-only**, config-gated (`liveData.allowAnalyze`,
default off). Relaxes "never executes," never "never mutates."

### `data_count({ table, where? }) → { count }`
Fast row count / cardinality.

---

## Summary

| Category | Tools | Reads |
|---|---|---|
| A structural | 13 | `symbols`, `edges`, `entrypoints`, `packages`, `files` |
| B nest | 11 | fragment nodes/refs (nest) + core symbols |
| C prisma | 7 | fragment nodes/refs (prisma model + access) + migration files |
| D semantic | 2 | vector sidecar → anchors into core/fragments |
| E live data | 5 | runtime DB connection (not the map) |

Read-only except E, which never mutates the target DB (SELECT-only + caps +
timeout guards; opt-in SELECT `EXPLAIN ANALYZE` is the only relaxation).
