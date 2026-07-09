// The parameterized live-data acceptance suite. The SAME checks run against
// every engine (SQLite reference, real Postgres, real MySQL). Two halves:
//   1. guardRedTeam — pure-JS, engine-independent (run once): the 23-statement
//      mutation/evasion set is rejected and the 9 read-only statements allowed.
//   2. runDbSuite — driven against a live database per engine: drift, row caps +
//      truncation, data_query mutation rejection, count/sample/explain, and —
//      on pg/mysql — a *fired* statement timeout on a deliberately slow SELECT.
import type { Store } from "@tsca/core";
import { guardSelectOnly, liveTools, type Driver, type LiveConfig } from "../src/index.ts";

export type Check = (label: string, cond: boolean) => void;

// ---- 1. guard red-team (engine-independent) ------------------------------
const MUTATING = [
  "INSERT INTO users VALUES (1)",
  "UPDATE users SET name = 'x'",
  "DELETE FROM users",
  "DROP TABLE users",
  "TRUNCATE users",
  "ALTER TABLE users ADD col int",
  "CREATE TABLE x (id int)",
  "GRANT ALL ON users TO bob",
  "SELECT 1; DROP TABLE users",
  "SELECT 1 /* hide */; DELETE FROM users",
  "WITH t AS (DELETE FROM users RETURNING *) SELECT * FROM t",
  "SELECT * INTO backup FROM users",
  "COPY users TO '/tmp/x'",
  "CALL sp_do_it()",
  "MERGE INTO users u USING s ON (u.id=s.id) WHEN MATCHED THEN UPDATE SET u.n=1",
  "REPLACE INTO users VALUES (1)",
  "SET statement_timeout = 0",
  "VACUUM",
  "PRAGMA writable_schema = 1",
  "DO $$ BEGIN PERFORM 1; END $$",
  "SELECT 1 /* c */ ; DROP TABLE users",
  "",
  "   ",
];
const READONLY = [
  "SELECT * FROM users",
  "select id, email from users where id = 'a; DROP TABLE x'",
  "WITH t AS (SELECT 1 AS n) SELECT * FROM t",
  "SELECT count(*) FROM users",
  "(SELECT 1)",
  "VALUES (1),(2)",
  "TABLE users",
  "SELECT deleted_at, created_at, updated_at FROM users",
  "SELECT 1 -- ; DROP TABLE users",
];

export function guardRedTeam(check: Check): void {
  const rejected = MUTATING.filter((s) => !guardSelectOnly(s).ok);
  const allowed = READONLY.filter((s) => guardSelectOnly(s).ok);
  check(`guard rejects all ${MUTATING.length} mutating/evasion statements`, rejected.length === MUTATING.length);
  if (rejected.length !== MUTATING.length) console.log("   LEAKED:", MUTATING.filter((s) => guardSelectOnly(s).ok));
  check(`guard allows all ${READONLY.length} read-only statements`, allowed.length === READONLY.length);
  if (allowed.length !== READONLY.length) console.log("   BLOCKED:", READONLY.filter((s) => !guardSelectOnly(s).ok));
}

// ---- 2. per-engine DB suite ----------------------------------------------
export interface EngineOpts {
  /** A genuinely slow read the engine's statement timeout must interrupt.
   *  Undefined for SQLite (per-statement interrupt is an inherent no-op). */
  slowSelect?: string;
}

export async function runDbSuite(engine: string, store: Store, driver: Driver, config: LiveConfig, check: Check, opts: EngineOpts): Promise<void> {
  const tag = (s: string) => `[${engine}] ${s}`;

  // -- data_tables + Prisma drift reconciliation against the live catalog --
  const tbls = (await liveTools.data_tables(store, driver, config, {})) as any;
  const liveNames = tbls.tables.map((t: any) => String(t.name).toLowerCase()).sort();
  console.log(`  ${engine} tables:`, liveNames, "drift:", JSON.stringify(tbls.drift));
  check(tag("data_tables lists live users + sessions"), liveNames.join(",") === "sessions,users");
  check(tag("drift: Post model has no live table"), tbls.drift.modelsInSchemaNotInDb.includes("Post"));
  check(tag("drift: sessions table not in Prisma schema"), tbls.drift.tablesInDbNotInSchema.map((t: string) => t.toLowerCase()).includes("sessions"));
  check(tag("drift: users columns match the User model (no column drift)"), !tbls.drift.columnDrift.some((d: any) => String(d.table).toLowerCase() === "users"));

  // -- row cap + truncation --
  const sample = (await liveTools.data_sample(store, driver, config, { table: "users" })) as any;
  check(tag("data_sample honors the row cap (2) and reports truncation"), sample.rows.length === 2 && sample.truncated === true);

  // -- data_query happy path + mutation rejection --
  const q = (await liveTools.data_query(store, driver, config, { sql: "SELECT email FROM users WHERE role = 'ADMIN'" })) as any;
  check(tag("data_query returns the ADMIN row"), q.rows.length === 1 && q.rows[0].email === "a@x.com");
  const bad = (await liveTools.data_query(store, driver, config, { sql: "DELETE FROM users" })) as any;
  check(tag("data_query rejects a mutating statement"), bad.rejected === true);

  // -- data_count (+ where) --
  const count = (await liveTools.data_count(store, driver, config, { table: "users" })) as any;
  check(tag("data_count(users) = 5"), Number(count.count) === 5);
  const countWhere = (await liveTools.data_count(store, driver, config, { table: "users", where: "role = 'USER'" })) as any;
  check(tag("data_count(users, role=USER) = 4"), Number(countWhere.count) === 4);

  // -- data_explain: engine-generated SELECT, ANALYZE gating --
  const expectedSql = `SELECT * FROM ${driver.quoteIdent("users")}`;
  const exp = (await liveTools.data_explain(store, driver, config, { model: "User", op: "findMany" })) as any;
  check(tag(`data_explain(model:User) plans ${expectedSql}`), exp.sql === expectedSql && exp.analyzed === false && exp.plan != null);
  const analyzeOff = (await liveTools.data_explain(store, driver, config, { model: "User", analyze: true })) as any;
  check(tag("EXPLAIN ANALYZE refused when allowAnalyze is off"), typeof analyzeOff.error === "string");
  const analyzeOn: LiveConfig = { ...config, allowAnalyze: true };
  const analyzeDml = (await liveTools.data_explain(store, driver, analyzeOn, { sql: "DELETE FROM users", analyze: true })) as any;
  check(tag("EXPLAIN ANALYZE refuses a non-SELECT even when enabled"), analyzeDml.rejected === true);
  const analyzeSel = (await liveTools.data_explain(store, driver, analyzeOn, { sql: "SELECT * FROM users", analyze: true })) as any;
  check(tag("EXPLAIN ANALYZE allowed on a SELECT when enabled"), !analyzeSel.error && !analyzeSel.rejected);

  // -- injected table name rejected --
  const badTable = (await liveTools
    .data_sample(store, driver, config, { table: "users; DROP TABLE users" })
    .then((r) => r, (e) => ({ error: String(e) }))) as any;
  check(tag("data_sample rejects an unknown/injected table name"), typeof badTable.error === "string");

  // -- statement timeout FIRES on a slow SELECT (pg: statement_timeout,
  //    mysql: MAX_EXECUTION_TIME). SQLite has no per-statement interrupt. --
  if (opts.slowSelect) {
    const fastCfg: LiveConfig = { ...config, statementTimeoutMs: 400 };
    const started = Date.now();
    let fired = false;
    let msg = "";
    try {
      await liveTools.data_query(store, driver, fastCfg, { sql: opts.slowSelect });
    } catch (e) {
      fired = true;
      msg = String(e);
    }
    const elapsed = Date.now() - started;
    console.log(`  ${engine} timeout: fired=${fired} after ${elapsed}ms — ${msg.slice(0, 120)}`);
    // Must have thrown, and well before the ~5s the SELECT would otherwise take.
    check(tag("statement timeout fires on a deliberately slow SELECT"), fired && elapsed < 4000);
  }
}
