# Findings: Prisma adapter bugs on a pnpm monorepo (schema in one package, client consumed in others)

Handoff for a Claude session working **in this repo** (`/Users/flips/Dev/ts-code-awareness`).
Three reproducible Prisma-adapter defects (plus two minor ones) found while
exercising the full MCP tool surface against a real project. Two have root
causes confirmed in this repo's source; one needs you to reproduce and confirm
whether the published tarball diverges from the working tree.

## How these were found

- **Plugin version running:** `@codehead-pl/tsca-daemon@0.1.0` (the `npx -y
  @codehead-pl/tsca-daemon@latest` the SessionStart hook launches). Local
  working tree is also `0.1.0`, git HEAD `9dd513e`, tree clean.
- **Target project:** `/Users/flips/Dev/zawodnik` (same machine) — a pnpm-workspace
  monorepo. NestJS + Prisma + BullMQ. Every MCP tool was called against it.
- **The shape that triggers the bugs:** the Prisma **schema lives in one package**
  (`@zawodnik/shared`, at `packages/shared/prisma/schema.prisma`), and that package
  is the **only** one that declares `@prisma/client`/`prisma`. The client is
  **consumed in other packages** (`apps/api`, `apps/workers`) that depend on
  `@zawodnik/shared` and get the client transitively. This "definitions package vs
  consumer package" split is what the adapter mishandles. It is a very common
  monorepo layout, so this is worth fixing.

Package dependency facts (from the target's package.json files):

| package | declares `@prisma/client`? | owns schema.prisma? | has `prisma.<model>` / `$queryRaw` calls? |
|---|---|---|---|
| `@zawodnik/shared` | yes (`^6.3.0`) | **yes** | no |
| `@zawodnik/api` | no | no | **yes** (offers.service.ts, health.controller.ts, ...) |
| `@zawodnik/workers` | no | no | **yes** (dedup.ts, dedup-backfill.ts, ...) |
| matching / scrapers / cv / web | no | no | no |

So the one package the adapter attaches to (`shared`) contains **zero** client
call sites, and the packages full of call sites are never scanned.

---

## Finding 1 — `db_model_usage` always returns 0; `db_raw_queries` misses every real query

**Severity: high** (the model↔code bridge is a headline feature; it is silently empty here). Root cause confirmed in source.

### Symptoms observed

- `db_model_usage({ model: "JobOffer" })` → `{ count: 0, accesses: [] }` with
  `coverage.complete: true, hydrated: 7` (i.e. **not** a hydration problem — all
  7 packages were Tier-2 hydrated). Ground truth: `grep -rn '\.jobOffer\.' apps packages`
  finds **28** real `prisma.jobOffer.*` sites (e.g. `apps/api/src/offers/offers.service.ts:16`
  `.create(...)`, `:73` `.findMany(...)`, `:82` `.update(...)`).
- `db_raw_queries()` → returns exactly **1** query, and it is a false positive
  (see Finding 3). It **misses all three real ones**:
  `apps/api/src/health/health.controller.ts:11` (`$queryRaw\`SELECT 1\``),
  `apps/workers/src/dedup.ts:67` and `apps/workers/src/dedup-backfill.ts:84`
  (the pg_trgm similarity `$queryRaw` dedup queries).

### Root cause

The model↔code bridge and the raw-query capture both live in
`packages/adapter-prisma/src/build.ts` `build(ctx)`, and both only ever run over
the **schema-owning package's own files**:

- `build.ts:21-22` — `const schemaFiles = findSchemas(ctx.pkg.root); if (!schemaFiles.length) return;`
  The whole `build()` bails unless *this* package contains a `schema.prisma`.
- `build.ts:87` — `const files = ctx.project.getSourceFiles().filter((sf) => ctx.inPackage(sf));`
  Even when it does run, it scans only files **in the schema's package**.
- `packages/adapter-prisma/src/index.ts:24-28` — `detect(pkg)` activates the
  adapter for a package if it declares `@prisma/client`/`prisma` **or** contains a
  schema. In this monorepo only `shared` matches. But `shared` is a definitions
  package: it exports the client and the schema, and has no `prisma.model.op()`
  or `$queryRaw` call sites. The consumers (`api`, `workers`) match neither
  `detect` predicate (no direct `@prisma/client` dep, no schema), so their source
  — where all the call sites are — is never walked.

Net: `prisma:access` and `prisma:raw` fragments are only ever emitted for the
definitions package, which by construction has none of the interesting sites.

### Suggested fix (for discussion)

The model↔code scan needs a **project-wide** file set, not a package-local one,
while model/enum/migration fragments stay owned by the schema package. Options:

1. Run the access/raw scan across the whole workspace (`ctx.project.getSourceFiles()`
   without the `inPackage` filter), attributing each `prisma:access`/`prisma:raw`
   fragment to the file/package it was found in (provenance already carries `fid`).
   Keep the `delegateToModel` map from the parsed schema. This is the smallest change.
2. Or scan the schema package **plus every package whose workspace-dep closure
   reaches it** (here: everything that depends on `@zawodnik/shared`). Uses the
   same closure logic the daemon already has (`ProjectManager.hydrateClosure`).
3. Either way, reconsider `detect()` so a package that imports a workspace sibling
   which re-exports the client still gets its call sites scanned. Simple string
   `@prisma/client` in `pkg.dependencies` is too narrow for monorepos.

Watch out for: the `confidenceOf`/`clientTypeSet` typing (`build.ts:207-230`)
computes `clientTypes` from the **current file set** — if you widen the scan,
compute the `PrismaClient` heritage fixpoint across all scanned packages so a
`PrismaService extends PrismaClient` defined in `shared` still marks `this.prisma`
receivers in `api`/`workers` as `typed` rather than `heuristic`.

### Repro

Point the daemon at `/Users/flips/Dev/zawodnik` (or build a fixture: a pnpm
workspace with `packages/db` holding `prisma/schema.prisma` + the only
`@prisma/client` dep, and `apps/consumer` doing `prisma.user.findMany()` +
`prisma.$queryRaw`). Then `db_model_usage({model:"User"})` returns 0 and
`db_raw_queries()` misses the consumer's `$queryRaw`. A unit test over such a
fixture would lock in the fix.

---

## Finding 2 — `clientStale: true` false positive under pnpm

**Severity: medium** (misleads users into needless `prisma generate`/rebuilds; it's what kicked off this whole investigation). Root cause confirmed with filesystem evidence.

### Symptom

Every model in `db_models()` / `db_model()` reports `clientStale: true`, even
though the generated client is actually **newer** than the schema.

### Root cause

`packages/adapter-prisma/src/build.ts:391-397`:

```js
function computeClientStale(root, schemaMtime) {
  for (const rel of ["node_modules/.prisma/client", "node_modules/@prisma/client"]) {
    const p = join(root, rel);
    if (existsSync(p)) return safeMtime(p) < schemaMtime;   // <-- wrong file's mtime
  }
  return false;
}
```

`root` is the schema package (`packages/shared`). Under pnpm:

- `packages/shared/node_modules/.prisma/client` — **absent** (pnpm does not hoist
  the generated `.prisma/client` into each consuming package's `node_modules`).
- `packages/shared/node_modules/@prisma/client` — **exists, but as a symlink** into
  the pnpm store. `existsSync` follows it (true), and `statSync(p).mtimeMs`
  follows it to the **package directory**, whose mtime is the pnpm **install**
  time, not the `prisma generate` time.

Concrete evidence from the target machine:

```
packages/shared/node_modules/.prisma/client              (absent)
packages/shared/node_modules/@prisma/client   -> ../../../../node_modules/.pnpm/@prisma+client@6.19.3_.../node_modules/@prisma/client
    mtime 2026-07-05 17:34:07     (pnpm install time)
packages/shared/prisma/schema.prisma
    mtime 2026-07-08 22:18:49     (last schema edit, 3 days later)
node_modules/.pnpm/@prisma+client@6.19.3_.../node_modules/.prisma/client/index.d.ts
    mtime 2026-07-08 22:24:59     (actual `prisma generate` output, NEWER than schema)
```

So it compares `2026-07-05 17:34` (symlinked package dir) `< 2026-07-08 22:18`
(schema) → `true`, while the real generated artifact
(`.prisma/client/index.d.ts`, `2026-07-08 22:24`) is newer than the schema and
therefore **fresh**. It stats the wrong file.

### Suggested fix

Resolve the **actual generated client output** and stat that, not the package
symlink:

- Prefer the generated `index.d.ts`/`index.js` inside `.prisma/client`. Resolve it
  robustly under pnpm, e.g. `require.resolve(".prisma/client")` (or resolve
  `@prisma/client` then locate the sibling `.prisma/client`) from the schema
  package's root, and stat that file.
- Even better and mtime-independent: Prisma embeds a hash of the datamodel in the
  generated client. Compare that against a hash of the current `schema.prisma`;
  fall back to mtime only if unavailable. Avoids all the "touch reset the mtime"
  fragility.
- Minimum viable: if neither `.prisma/client` output file can be resolved, return
  `false`/`unknown` rather than defaulting to a symlink-dir mtime.

Consider exposing `unknown` as a third state so callers don't treat "couldn't
determine" as "stale".

---

## Finding 3 — `db_raw_queries` reports a bogus `$executeRaw` on `toLocaleString("sv-SE")`

**Severity: medium.** Observed defect is definite; root cause needs your confirmation (possible working-tree vs published-tarball divergence).

### Symptom

`db_raw_queries()` returns:

```json
{ "rw": "write", "sql": "\"sv-SE\"",
  "caller": "@zawodnik/shared|src/index.ts|formatLocalDateTime",
  "span": { "startLine": 158, "startCol": 10, "endLine": 159, "endCol": 72 } }
```

The source it flagged is not SQL at all — `packages/shared/src/index.ts:157-161`:

```ts
export function formatLocalDateTime(d: Date): string {
  return d
    .toLocaleString("sv-SE", { timeZone: APP_TIMEZONE, hour12: false })
    .slice(0, 16);
}
```

It captured the string literal `"sv-SE"` (the first call argument) as an
`$executeRaw` write.

### Why this is confusing — please confirm

Reading the **current working tree** `build.ts`, this should *not* happen:
`emitRaw` fires only for (a) tagged templates whose tag name is in
`RAW_TAGS = {$queryRaw, $executeRaw}` (`build.ts:96-102`) or (b) call
expressions whose method name is in `RAW_CALLS = {$queryRawUnsafe,
$executeRawUnsafe}` (`build.ts:108-112`). `toLocaleString` matches neither and is
not a tagged template. Yet the **running 0.1.0 daemon** emitted it.

That points at one of:
- The **published `0.1.0` npm tarball differs from the working tree** (same
  version number, different code — check `npm pack`/registry tarball vs `dist/`),
  i.e. the fix already landed locally but wasn't republished; **or**
- A subtler match in the built `dist/` than in `src/` (build step difference); **or**
- A stale fragment path.

**First action for you:** diff the published tarball against the working tree
(`npm view @codehead-pl/tsca-daemon dist.tarball`, extract, compare
`packages/adapter-prisma/dist`), and add a regression test: a source file
containing `x.toLocaleString("sv-SE", {...})` and any other `.foo("bar")` call
must yield **zero** `prisma:raw` fragments. If the tarball is stale, a republish
may already fix the symptom; keep the test regardless.

Combined with Finding 1, the correct output for the target project is: **0**
false positives and **3** real `$queryRaw` captures (health `SELECT 1`, dedup,
dedup-backfill).

---

## Minor findings (lower priority)

### 4. `db_migrations` — some migrations report empty `operations`/`tables`

`db_migrations()` classified the newest two migrations as `operations: [], tables: []`
despite non-zero `statements` (e.g. `20260708084331_application_status_on_hold`,
`20260708202445_extra_boards_rocketjobs_bulldogjob_solidjobs`). `drift.clean`
was still correctly `true`, so it's cosmetic. Cause: `operationOf`
(`build.ts:197-200`) only matches `CREATE TABLE|CREATE (UNIQUE )?INDEX|CREATE
TYPE|ALTER TABLE|DROP TABLE|DROP INDEX`. Enum-extension migrations use
`ALTER TYPE ... ADD VALUE`, which isn't in the alternation, so those statements
classify as `null` and drop out. Add `ALTER TYPE` (and probably `CREATE
EXTENSION`, `CREATE SCHEMA`) to the regex.

### 5. `data_tables` drift note

Not a bug, just document it: with live-data configured, `data_tables()` reports
`drift.clean: false` solely because `_prisma_migrations` (Prisma's own bookkeeping
table) exists in the DB but not the schema. Consider whitelisting
`_prisma_migrations` so a fully-migrated DB reads as clean.

---

## What is NOT a bug (verified, so you don't chase it)

- **Hydration scoping of `usages`/`db_model_usage` coverage** is by design and works.
  Tier-2 is on-demand; only `explain_symbol`, `relations` (call kinds), and
  `call_paths` trigger it (`packages/daemon/src/tools.ts:157,208,272`). After
  hydrating all 7 packages (edges 436 → 2899), `usages` resolved cross-package
  inbound calls with `coverage.complete: true`. `db_model_usage` staying at 0 is
  Finding 1, independent of hydration.
- All non-Prisma tool families were correct on the target: 15 core tools, 9 nest
  tools (routes/pipeline/DI graph all accurate — global `ValidationPipe`, 13
  injections of `PrismaService`, etc.), and the 5 live-data tools
  (`data_query` correctly rejects non-SELECT; `data_explain analyze:true` honors
  the `allowAnalyze` gate). `nest_graphql`/`nest_messaging` simply aren't exposed
  (REST-only project).

## Suggested priority

1. **Finding 1** (bridge package-scoping) — biggest correctness win; the feature is
   silently empty on any monorepo with a separate db/schema package.
2. **Finding 3** (raw-query false positive) — confirm tarball vs tree first; add the
   regression test.
3. **Finding 2** (`clientStale` under pnpm) — self-contained, easy, user-visible.
4. Findings 4–5 — cosmetic.
