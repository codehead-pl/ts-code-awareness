# Roadmap

Direction, not dates. This lists where `ts-code-awareness` is headed — mostly new
adapters that broaden framework and database coverage. Priorities are marked
**[next up]** · **[planned]** · **[exploring]**; they signal intent and ordering,
not commitments. Contributions and proposals are welcome.

## Principles

Every item below is shaped by what the engine is good at:

- **One program walk, many contributors.** Adapters read the same parsed
  `ts-morph` program and contribute namespaced fragments — they never re-walk.
- **Best fit = decorator/heritage-structural or code-as-schema.** Decorator-heavy
  targets (TypeORM, MikroORM) reuse machinery that already exists; TS-as-schema
  targets (Drizzle, tRPC, zod) are read directly, like Prisma.
- **Honest incompleteness for dynamic targets.** Imperative frameworks (Express,
  Koa) register routes/middleware at runtime; extraction is heuristic and every
  answer carries the coverage envelope rather than pretending to be complete.
- **Detection-gated, zero-cost when absent.** An adapter loads only when its
  framework is detected; a project never pays for what it doesn't use.
- **Uniform surfaces.** New ORMs light up the **same `db_*` tools** as Prisma; the
  goal is that `db_models` / `db_model_usage` work whether the app uses Prisma,
  TypeORM, or Drizzle. HTTP framework adapters aim for the same consistency (see
  *Unified HTTP surface*).

**Where we'd start (tentpoles):** TypeORM · Drizzle · Validation bridge ·
Next.js · the Adapter SDK.

---

## Framework adapters

### Next.js — `next_*`  **[next up]**
- **Detects:** `next` dep + an `app/` or `pages/` directory.
- **Surfaces:** the route map (App Router `route.ts`/`page.tsx` + Pages `api/`),
  the **RSC boundary graph** (`"use client"` / `"use server"` — which tree runs
  where), **server actions**, `middleware.ts`, and data-fetching sites.
- **Why:** biggest ecosystem, and the client/server boundary is something agents
  routinely get wrong — no LSP maps it. Medium effort (needs a file-convention
  layer over the AST).

### tRPC — `trpc_*`  **[planned]**
- **Detects:** `@trpc/server`.
- **Surfaces:** the router/procedure **tree**, query vs mutation vs subscription,
  and the zod input/output schema per procedure.
- **Why:** great fit — the router is code-as-schema and reads directly.

### Fastify — `fastify_*`  **[planned]**
- **Detects:** `fastify`.
- **Surfaces:** the route table, **hooks** (`onRequest`/`preHandler` — the
  pipeline analog), the **plugin encapsulation graph** (a Nest-module analog), and
  JSON-schema validation on routes.
- **Why:** structured enough for solid static analysis.

### Express — `express_*`  **[planned]**
- **Detects:** `express`.
- **Surfaces:** the route table, the **ordered middleware chain**, and error
  handlers.
- **Why:** the default Node framework. Dynamic registration makes it heuristic —
  the honesty contract (coverage envelope, `unresolved` markers) is what makes it
  trustworthy anyway.

### Unified HTTP surface — `http_*`  **[exploring]**
A shared `http_routes` / `http_pipeline_for` that each web-framework adapter
feeds, so an agent gets one consistent route + request-pipeline view regardless of
framework (Nest, Next, Fastify, Express). Open design question: unify under
`http_*` vs keep per-framework namespaces.

---

## ORM / database-layer adapters

All of these contribute to the **existing `db_*` tool surface** (`db_models`,
`db_model`, `db_er`, `db_model_usage`, `db_enums`, `db_migrations`) — one database
view, many backends.

### TypeORM — extends `db_*`  **[next up]**
- **Detects:** `typeorm`.
- **Surfaces:** `@Entity`/`@Column`/relation decorators → entity↔table, the
  relation graph, repository/query usage sites, and migrations.
- **Why:** the biggest Prisma alternative in Nest land, and decorator-based — it
  reuses the decorator machinery directly. Great fit.

### Drizzle — extends `db_*`  **[next up]**
- **Detects:** `drizzle-orm`.
- **Surfaces:** `pgTable`/`mysqlTable`/`sqliteTable` schema definitions → models +
  relations, plus type-safe query sites (`db.select().from(...)`).
- **Why:** fast-growing, schema-in-TS — read directly, no separate schema file.

### Mongoose / MongoDB — extends `db_*` (documents)  **[planned]**
- **Detects:** `mongoose`.
- **Surfaces:** document schemas, models, `ref` relations, and access sites.
- **Why:** extends the DB category into **NoSQL** — a different paradigm (embedded
  documents, no migrations) with broad usage. Pairs with the MongoDB live driver.

### MikroORM · Kysely · Sequelize — extends `db_*`  **[exploring]**
- **MikroORM** — decorator entities (cheap, like TypeORM).
- **Kysely** — typed query builder; schema from a TS interface + query analysis.
- **Sequelize** — model definitions + associations (older, still widespread).

---

## Live-data drivers

New read-only `Driver` implementations behind the existing SELECT-only guard +
caps + timeout. Current: SQLite, Postgres, MySQL.

- **MariaDB** **[planned]** — mysql2-compatible; nearly free.
- **CockroachDB** **[planned]** — Postgres wire protocol; nearly free.
- **SQL Server (MSSQL)** **[planned]** — via `mssql`/`tedious`.
- **MongoDB (read-only)** **[planned]** — needs a **read-only op guard** analogous
  to the SELECT-only one: allow `find`/`aggregate`/`count`, reject writes and
  `$out`/`$merge`. Pairs with the Mongoose adapter.

---

## Cross-cutting adapters

Not frameworks — these compose with *every* framework and tend to be cheaper than
a new web framework while adding as much value.

### Validation bridge — `validation:*` fragments  **[next up]**
- **Detects:** `zod`, `class-validator`, TypeBox/Valibot.
- **Surfaces:** the constraints a schema actually enforces, linked to route inputs
  and DTOs — "what validation runs on this request body." Enriches `nest_route` /
  future `http_route` and `explain_symbol` role facets.
- **Why:** completes the API-understanding story; composes everywhere.

### Auth map — `auth_*`  **[planned]**
- **Detects:** `passport`/`@nestjs/passport`, JWT libs.
- **Surfaces:** strategies, guard→strategy resolution, and `auth_for(route)` —
  "what protects this endpoint," cross-framework.

### API contract views — `contract_*`  **[planned]**
- **Surfaces:** reconstructed OpenAPI from `@nestjs/swagger` decorators, and the
  GraphQL SDL — the API contract as a first-class, queryable view.

### Config / env adapter  **[exploring]**
- **Surfaces:** `process.env` usage + validated config schema (Nest `ConfigModule`,
  zod-validated env) → "what this service needs to run."

---

## Platform & ecosystem

### Adapter SDK + authoring guide  **[next up]**
Stabilize and document the `Adapter` / `AdapterContext` contract, ship a template
adapter + a testing harness (the golden-fixture pattern), and document the
fragment-schema conventions and detection model — so the **community** can write
adapters. For an open-source project this is a force multiplier that beats
building every adapter first-party.

### Broader MCP clients  **[planned]**
The daemon + stdio shim are generic MCP. Package for Cursor and other MCP clients
beyond Claude Code, and provide a non-plugin install path — widening the audience
with little engine work.

### Semantic search: ANN index + learned-model default  **[exploring]**
A carry-over core enhancement: an ANN index (hnsw / sqlite-vec) behind the
existing brute-force cosine for large indexes, and making the learned
`OnnxEmbedder` the default when the model is available.
