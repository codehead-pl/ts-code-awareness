// Acceptance: build the fixture
// with the Prisma adapter active and assert the ER model + the model↔code bridge
// (db_model_usage recall/confidence), $queryRaw capture, and static migrations.
import { Store, buildSkeleton, registerAdapter } from "@codehead-pl/tsca-core";
import { prismaAdapter } from "../src/index.ts";
import * as t from "../src/tools.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerAdapter(prismaAdapter);

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}

const store = new Store(join(tmpdir(), `prisma-${process.pid}.db`));
const res = buildSkeleton(store, "fixtures/nest-monorepo");
console.log("skeleton:", res, "adapters:", store.getMeta("adapters"));
check("prisma adapter active", (store.getMeta("adapters") ?? "").includes("prisma"));

// ---- models / entity→table ----------------------------------------------
const models = t.db_models(store, {}) as { count: number; models: Array<Record<string, any>> };
const byName = (n: string) => models.models.find((m) => m.name === n);
check("2 models discovered", models.count === 2);
check("User → users table (@@map)", byName("User")?.table === "users");
check("Post → Post table (default)", byName("Post")?.table === "Post");

const user = t.db_model(store, { model: "User" }) as { fields: Array<Record<string, any>>; relations: Array<Record<string, any>> };
check("User.email is unique scalar", user.fields.some((f) => f.name === "email" && f.isUnique && !f.isRelation));
check("User.role typed as Role enum", user.fields.some((f) => f.name === "role" && f.type === "Role"));
check("User.posts is a one-to-many relation to Post", user.relations.some((r) => r.name === "posts" && r.target === "Post" && r.kind === "one-to-many"));

const post = t.db_model(store, { model: "Post" }) as { relations: Array<Record<string, any>> };
check("Post.author is many-to-one with fk authorId", post.relations.some((r) => r.name === "author" && r.kind === "many-to-one" && r.fk === "authorId"));

// ---- enums ---------------------------------------------------------------
const enums = t.db_enums(store, {}) as { enums: Array<{ name: string; members: string[] }> };
check("Role enum with ADMIN,USER", enums.enums.some((e) => e.name === "Role" && e.members.join(",") === "ADMIN,USER"));

// ---- ER graph ------------------------------------------------------------
const er = t.db_er(store, {}) as { models: string[]; relations: Array<Record<string, any>> };
check("ER graph has a User↔Post edge", er.relations.some((r) => (r.from === "Post" && r.to === "User") || (r.from === "User" && r.to === "Post")));

// ---- the model↔code bridge (headline) ------------------------------------
const usage = t.db_model_usage(store, { model: "User" }) as { count: number; accesses: Array<Record<string, any>> };
const ops = usage.accesses.map((a) => a.op).sort();
console.log("\nUser accesses:", usage.accesses.map((a) => `${a.op}/${a.rw}/${a.confidence}[${(a.fields as string[]).join(",")}]`).join("  "));
check("4 User accesses recognized (count/findMany/findUnique/create)", usage.count === 4 && JSON.stringify(ops) === JSON.stringify(["count", "create", "findMany", "findUnique"]));
check("all User accesses are typed confidence (receiver reaches PrismaClient)", usage.accesses.every((a) => a.confidence === "typed"));
check("create is a write touching email,name,role", usage.accesses.some((a) => a.op === "create" && a.rw === "write" && (a.fields as string[]).sort().join(",") === "email,name,role"));
check("findMany is a read touching email", usage.accesses.some((a) => a.op === "findMany" && a.rw === "read" && (a.fields as string[]).join(",") === "email"));
check("findUnique reads by id", usage.accesses.some((a) => a.op === "findUnique" && (a.fields as string[]).join(",") === "id"));

const writes = t.db_model_usage(store, { model: "User", rw: "write" }) as { count: number };
check("rw:'write' filter isolates the create", writes.count === 1);

// ---- bare-identifier client receiver typing --------------------------
// `post-stats.ts`: `const db = new PrismaClient(); db.post.findMany(...)`. The
// receiver `db` is a bare identifier (not `this.<field>`), yet its initializer
// provably reaches PrismaClient, so confidence must be `typed`, not `heuristic`.
const postUsage = t.db_model_usage(store, { model: "Post" }) as { accesses: Array<Record<string, any>> };
console.log("\nPost accesses:", postUsage.accesses.map((a) => `${a.op}/${a.rw}/${a.confidence}`).join("  "));
const bareFindMany = postUsage.accesses.find((a) => a.op === "findMany" && a.rw === "read");
check("bare-identifier local const client access is recognized (recall)", bareFindMany !== undefined);
check("bare-identifier client access is 'typed' (receiver reaches PrismaClient via initializer)", bareFindMany?.confidence === "typed");

// ---- raw queries ---------------------------------------------------------
const raws = t.db_raw_queries(store, {}) as { count: number; queries: Array<Record<string, any>> };
check("$queryRaw captured with SQL text", raws.count === 1 && String(raws.queries[0].sql).includes("SELECT * FROM") && raws.queries[0].kind === "queryRaw");

// ---- migrations (static) -------------------------------------------------
const migs = t.db_migrations(store, {}) as { count: number; migrations: Array<Record<string, any>>; drift: Record<string, any> };
console.log("\nmigrations:", JSON.stringify(migs.migrations), "\ndrift:", JSON.stringify(migs.drift));
check("1 migration listed", migs.count === 1);
check("migration creates users + Post tables", (migs.migrations[0].tables as string[]).sort().join(",") === "Post,users");
check("no schema↔migration drift", migs.drift.clean === true);

store.close();
console.log(failures === 0 ? "\nPASS — all Prisma acceptance checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
