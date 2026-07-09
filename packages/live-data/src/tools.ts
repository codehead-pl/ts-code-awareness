// Live-data tools. Read-only. Every path either
// runs an engine-generated SELECT over a validated table or passes user SQL
// through guardSelectOnly first. `data_explain --analyze` is the sole "may
// execute" relaxation and is config-gated + still SELECT-only.
import type { Store } from "@codehead-pl/tsca-core";
import type { Driver } from "./drivers.ts";
import type { LiveConfig } from "./config.ts";
import { guardSelectOnly } from "./guard.ts";

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

async function knownTables(driver: Driver, schema?: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const t of await driver.tables(schema)) map.set(t.name.toLowerCase(), t.name);
  return map;
}

/** Resolve a caller-supplied table name to a real table, or throw. Prevents any
 *  identifier the DB doesn't already expose from reaching a query. */
async function resolveTable(driver: Driver, name: string, schema?: string): Promise<string> {
  const real = (await knownTables(driver, schema)).get(name.toLowerCase());
  if (!real) throw new Error(`unknown table: ${name}`);
  return real;
}

// ---- data_tables (+ Prisma drift) ----------------------------------------

export async function data_tables(store: Store, driver: Driver, config: LiveConfig, args: Args) {
  const schema = str(args.schema) ?? config.schema;
  const tables = await driver.tables(schema);
  const liveByName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));

  // Reconcile against Prisma model fragments (schema §C — schema drift).
  const models = store.fragments("prisma", "model");
  const schemaTables = new Map<string, { model: string; columns: Set<string> }>();
  for (const m of models) {
    const fields = (m.attrs.fields as Array<Record<string, unknown>> | undefined) ?? [];
    const columns = new Set(fields.filter((f) => !f.isRelation).map((f) => String(f.column ?? f.name).toLowerCase()));
    schemaTables.set(String(m.attrs.table).toLowerCase(), { model: String(m.attrs.name), columns });
  }

  const tablesNotInSchema = tables.filter((t) => !schemaTables.has(t.name.toLowerCase())).map((t) => t.name);
  const tablesNotInDb = [...schemaTables.entries()].filter(([t]) => !liveByName.has(t)).map(([, v]) => v.model);
  const columnDrift: Array<{ table: string; inDbNotSchema: string[]; inSchemaNotDb: string[] }> = [];
  for (const [tname, s] of schemaTables) {
    const live = liveByName.get(tname);
    if (!live) continue;
    const liveCols = new Set(live.columns.map((c) => c.name.toLowerCase()));
    const inDbNotSchema = [...liveCols].filter((c) => !s.columns.has(c));
    const inSchemaNotDb = [...s.columns].filter((c) => !liveCols.has(c));
    if (inDbNotSchema.length || inSchemaNotDb.length) columnDrift.push({ table: live.name, inDbNotSchema, inSchemaNotDb });
  }

  return {
    tables: tables.map((t) => ({ name: t.name, columns: t.columns })),
    drift: {
      hasPrismaSchema: models.length > 0,
      tablesInDbNotInSchema: tablesNotInSchema,
      modelsInSchemaNotInDb: tablesNotInDb,
      columnDrift,
      clean: tablesNotInSchema.length === 0 && tablesNotInDb.length === 0 && columnDrift.length === 0,
    },
  };
}

// ---- data_sample ---------------------------------------------------------

export async function data_sample(_store: Store, driver: Driver, config: LiveConfig, args: Args) {
  const name = str(args.table);
  if (!name) return { error: "data_sample requires `table`" };
  const table = await resolveTable(driver, name, str(args.schema) ?? config.schema);
  const limit = Math.min(num(args.limit) ?? config.rowCap, config.rowCap);
  const res = await driver.runSelect(`SELECT * FROM ${driver.quoteIdent(table)}`, [], { rowCap: limit, timeoutMs: config.statementTimeoutMs });
  return { table, ...res };
}

// ---- data_query (guarded) ------------------------------------------------

export async function data_query(_store: Store, driver: Driver, config: LiveConfig, args: Args) {
  const sql = str(args.sql);
  if (!sql) return { error: "data_query requires `sql`" };
  const guard = guardSelectOnly(sql);
  if (!guard.ok) return { rejected: true, reason: guard.reason };
  const limit = Math.min(num(args.limit) ?? config.rowCap, config.rowCap);
  const res = await driver.runSelect(sql, [], { rowCap: limit, timeoutMs: config.statementTimeoutMs });
  return res;
}

// ---- data_explain (+ opt-in analyze) -------------------------------------

const READ_OP_SQL: Record<string, (t: string) => string> = {
  findMany: (t) => `SELECT * FROM ${t}`,
  findFirst: (t) => `SELECT * FROM ${t} LIMIT 1`,
  findUnique: (t) => `SELECT * FROM ${t} LIMIT 1`,
  count: (t) => `SELECT COUNT(*) FROM ${t}`,
  aggregate: (t) => `SELECT COUNT(*) FROM ${t}`,
};

export async function data_explain(store: Store, driver: Driver, config: LiveConfig, args: Args) {
  const analyze = args.analyze === true;
  if (analyze && !config.allowAnalyze) {
    return { error: "EXPLAIN ANALYZE is disabled — set liveData.allowAnalyze in tsca.config.json to enable (SELECT-only, still never mutates)" };
  }
  let sql = str(args.sql);
  if (!sql) {
    const model = str(args.model);
    const op = str(args.op) ?? "findMany";
    if (!model) return { error: "data_explain requires `sql`, or `model` (+ optional `op`)" };
    const node = store.fragment(model.startsWith("prisma:model:") ? model : `prisma:model:${model}`);
    if (!node) return { error: `unknown model: ${model}` };
    const gen = READ_OP_SQL[op];
    if (!gen) return { error: `unsupported op for explain: ${op} (read ops only: ${Object.keys(READ_OP_SQL).join(", ")})` };
    sql = gen(driver.quoteIdent(String(node.attrs.table)));
  }
  // Even for a hand-written statement, only ever EXPLAIN a read — so ANALYZE
  // (which executes) can never touch a mutation.
  const guard = guardSelectOnly(sql);
  if (!guard.ok) return { rejected: true, reason: guard.reason };
  const plan = await driver.explain(sql, [], analyze);
  return { sql, analyzed: plan.analyzed, plan: plan.plan };
}

// ---- data_count ----------------------------------------------------------

export async function data_count(_store: Store, driver: Driver, config: LiveConfig, args: Args) {
  const name = str(args.table);
  if (!name) return { error: "data_count requires `table`" };
  const table = await resolveTable(driver, name, str(args.schema) ?? config.schema);
  const where = str(args.where);
  const sql = `SELECT COUNT(*) AS count FROM ${driver.quoteIdent(table)}${where ? ` WHERE ${where}` : ""}`;
  // Defense in depth: a `where` clause is still guarded (rejects injected DML).
  const guard = guardSelectOnly(sql);
  if (!guard.ok) return { rejected: true, reason: guard.reason };
  const res = await driver.runSelect(sql, [], { rowCap: 1, timeoutMs: config.statementTimeoutMs });
  return { table, count: Number(res.rows[0]?.count ?? 0) };
}
