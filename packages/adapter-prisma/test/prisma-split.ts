// Acceptance for the SPLIT monorepo layout: schema + @prisma/client live in one
// package (@split/db) while every client call site lives in a consumer package
// (@split/api) that reaches the client only transitively. Locks Finding 1 (the
// bridge must scan consumer packages), Finding 3 (no toLocaleString false
// positive), Finding 4 (ALTER TYPE migration op), Finding 2 (clientStale under a
// pnpm symlink layout), and incremental == full-rebuild for consumer + schema
// edits.
import { Store, buildSkeleton, buildInto, incrementalRefresh, diffStores, registerAdapter } from "@codehead-pl/tsca-core";
import { prismaAdapter } from "../src/index.ts";
import { computeClientStale } from "../src/build.ts";
import * as t from "../src/tools.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, rmSync, cpSync, readFileSync } from "node:fs";

registerAdapter(prismaAdapter);

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}

const FIXTURE = "fixtures/prisma-split";
const store = new Store(join(tmpdir(), `prisma-split-${process.pid}.db`));
const res = buildSkeleton(store, FIXTURE);
console.log("skeleton:", res, "adapters:", store.getMeta("adapters"));
check("prisma adapter active", (store.getMeta("adapters") ?? "").includes("prisma"));

// ---- models are emitted once, by the schema-owning package ----------------
const models = t.db_models(store, {}) as { count: number; models: Array<Record<string, any>> };
check("2 models discovered (User, Post)", models.count === 2);
check("no duplicate model fragments", new Set(models.models.map((m) => m.name)).size === models.count);
check("clientStale is false (no generated client resolvable → not stale)", models.models.every((m) => m.clientStale === false));

// ---- Finding 1: the bridge recognizes CONSUMER-package call sites ----------
const userUsage = t.db_model_usage(store, { model: "User" }) as { count: number; accesses: Array<Record<string, any>> };
console.log("\nUser accesses:", userUsage.accesses.map((a) => `${a.op}/${a.rw}/${a.confidence}@${a.caller?.loc}`).join("  "));
check("User.findMany recognized in the consumer package (was 0 before the fix)", userUsage.count >= 1 && userUsage.accesses.some((a) => a.op === "findMany"));
check(
  "consumer access is attributed to apps/api, not the schema package",
  userUsage.accesses.some((a) => String(a.caller?.loc ?? "").includes("offers.service.ts")),
);
check(
  "receiver typed PrismaService (extends PrismaClient in the db pkg) → 'typed' across packages",
  userUsage.accesses.every((a) => a.confidence === "typed"),
);

const postUsage = t.db_model_usage(store, { model: "Post" }) as { count: number; accesses: Array<Record<string, any>> };
check("Post.create recognized as a write in the consumer package", postUsage.accesses.some((a) => a.op === "create" && a.rw === "write"));

// ---- Finding 3: raw queries — real ones captured, decoy excluded -----------
const raws = t.db_raw_queries(store, {}) as { count: number; queries: Array<Record<string, any>> };
console.log("\nraw queries:", raws.queries.map((q) => `${q.kind}:${JSON.stringify(q.sql).slice(0, 40)}`).join("  "));
check("2 raw $queryRaw captured (health SELECT 1 + offers similarity)", raws.count === 2);
check("no toLocaleString(\"sv-SE\") false positive", !raws.queries.some((q) => String(q.sql).includes("sv-SE")));
check("all captured raws are reads (queryRaw)", raws.queries.every((q) => q.rw === "read" && q.kind === "queryRaw"));

// ---- Finding 4: ALTER TYPE migration operation is classified ---------------
const migs = t.db_migrations(store, {}) as { count: number; migrations: Array<Record<string, any>>; drift: Record<string, any> };
console.log("\nmigrations:", JSON.stringify(migs.migrations));
const alterEnum = migs.migrations.find((m) => m.name.includes("add_role_value"));
check("ALTER TYPE migration classified (not empty operations)", (alterEnum?.operations as string[])?.includes("ALTER TYPE"));
check("CREATE EXTENSION also classified", (alterEnum?.operations as string[])?.includes("CREATE EXTENSION"));
check("schema↔migration drift clean", migs.drift.clean === true);

store.close();

// ---- Finding 2: clientStale under a pnpm symlink layout --------------------
// Reproduce the exact bug: `@prisma/client` is a symlink into a store whose
// package-dir mtime is the *install* time (older than the schema), while the
// real generated `.prisma/client/index.d.ts` is *newer*. Stat-ing the symlink
// dir said "stale"; resolving the generated output says "fresh".
{
  const tmp = mkdtempSync(join(tmpdir(), "prisma-stale-"));
  const projectRoot = tmp;
  const pkgRoot = join(tmp, "packages", "db");
  const store = join(tmp, "node_modules", ".pnpm", "@prisma+client@6.19.3", "node_modules");
  mkdirSync(join(pkgRoot, "node_modules", "@prisma"), { recursive: true });
  mkdirSync(join(store, "@prisma", "client"), { recursive: true });
  mkdirSync(join(store, ".prisma", "client"), { recursive: true });

  const OLD = new Date("2026-07-05T17:34:00Z"); // pnpm install time
  const SCHEMA = new Date("2026-07-08T22:18:00Z"); // last schema edit
  const NEW = new Date("2026-07-08T22:24:00Z"); // real `prisma generate` output

  // The generated output — newer than the schema (fresh).
  const generated = join(store, ".prisma", "client", "index.d.ts");
  writeFileSync(generated, "export {}\n");
  utimesSync(generated, NEW, NEW);
  // The symlinked package dir — stamped at install time (older than the schema).
  const storeClientPkg = join(store, "@prisma", "client");
  writeFileSync(join(storeClientPkg, "index.js"), "");
  utimesSync(storeClientPkg, OLD, OLD);
  // pnpm's symlink from the package's node_modules into the store.
  symlinkSync(storeClientPkg, join(pkgRoot, "node_modules", "@prisma", "client"), "dir");

  const stale = computeClientStale(pkgRoot, projectRoot, SCHEMA.getTime());
  check("clientStale=false when generated output is newer than schema (pnpm symlink)", stale === false);

  // And genuinely stale when the generated output predates the schema.
  utimesSync(generated, OLD, OLD);
  const stale2 = computeClientStale(pkgRoot, projectRoot, SCHEMA.getTime());
  check("clientStale=true when generated output predates schema", stale2 === true);

  rmSync(tmp, { recursive: true, force: true });
}

// ---- incremental == full-rebuild over the split layout ---------------------
console.log("\n=== incremental == full-rebuild (split layout) ===");
let seq = 0;
const scratch = (tag: string) => join(tmpdir(), `psplit-${tag}-${process.pid}-${seq++}`);
function freshCopy(tag: string): string {
  const dir = scratch(tag);
  rmSync(dir, { recursive: true, force: true });
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
function edit(dir: string, rel: string, fn: (s: string) => string): void {
  const p = join(dir, rel);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
}
function battery(name: string, apply: (dir: string) => void): void {
  const dir = freshCopy(name);
  const dbI = scratch(`${name}-i.db`);
  const dbF = scratch(`${name}-f.db`);
  const si = new Store(dbI);
  buildInto(si, dir);
  apply(dir);
  incrementalRefresh(si, dir);
  const sf = new Store(dbF);
  buildInto(sf, dir);
  const d = diffStores(si, sf);
  check(`[${name}] incremental DB == full-rebuild DB`, d.equal === true);
  if (!d.equal) console.log(`     first divergence: table ${d.table} row ${d.index}\n       INC:  ${JSON.stringify(d.a)}\n       FULL: ${JSON.stringify(d.b)}`);
  si.close();
  sf.close();
  for (const p of [dir, dbI, dbF, `${dbI}-wal`, `${dbF}-wal`, `${dbI}-shm`, `${dbF}-shm`]) rmSync(p, { recursive: true, force: true });
}

// 1) consumer-package body edit — a call-site change in apps/api must re-derive
//    that package's access fragment (glob widened to **/*.ts).
battery("consumer-edit", (dir) =>
  edit(dir, "apps/api/src/offers.service.ts", (s) => s.replace("similarity(title", "word_similarity(title")),
);

// 2) schema edit in the db package that changes a CONSUMER's recognition: add
//    the `tag` field the consumer already references. The consumer package must
//    re-run its adapter (aux-change closure) or incremental != full.
battery("schema-adds-consumed-field", (dir) =>
  edit(dir, "packages/db/prisma/schema.prisma", (s) => s.replace("name  String?", "name  String?\n  tag   String?")),
);

console.log(failures === 0 ? "\nPASS — split-layout Prisma checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
