// Acceptance: the live-data surface is exercised against a REAL database on ALL THREE
// supported engines — SQLite (built-in reference), Postgres, and MySQL — with
// the identical suite: SELECT-only guard red-team, Prisma drift reconciliation,
// row caps + truncation, mutation rejection, count/sample/explain, and a *fired*
// statement timeout on pg (statement_timeout) + mysql (MAX_EXECUTION_TIME).
//
// Postgres and MySQL are provisioned via Docker automatically (torn down at the
// end). Set TSCA_PG_URL / TSCA_MYSQL_URL to point at pre-provisioned servers
// (e.g. CI service containers) and Docker is skipped for that engine. If Docker
// is unavailable and no URL is given, that engine is reported SKIPPED rather
// than failing the run.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Store, buildSkeleton, registerAdapter } from "@tsca/core";
import { prismaAdapter } from "@tsca/adapter-prisma";
import { SqliteDriver, PgDriver, MysqlDriver, type Driver, type LiveConfig } from "../src/index.ts";
import { guardRedTeam, runDbSuite, type Check } from "./suite.ts";
import { seedSqlite } from "./seed/sqlite.ts";
import { seedPg } from "./seed/pg.ts";
import { seedMysql } from "./seed/mysql.ts";

const execFileP = promisify(execFile);

let failures = 0;
const skipped: string[] = [];
const check: Check = (label, cond) => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
};

// ---- docker helpers ------------------------------------------------------
function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function dockerRm(name: string): void {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}
async function waitReady(make: () => Promise<Driver>, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const d = await make();
      await d.close();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`server not ready after ${seconds}s: ${String(lastErr)}`);
}

// ---- shared map store (Prisma model fragments, engine-independent) --------
registerAdapter(prismaAdapter);
const store = new Store(join(tmpdir(), `live-map-${process.pid}.db`));
buildSkeleton(store, "fixtures/nest-monorepo"); // populates prisma:model fragments (User/Post)

// ---- 1. guard red-team (once) --------------------------------------------
console.log("\n== guard red-team (engine-independent) ==");
guardRedTeam(check);

// ---- 2a. SQLite (reference) ----------------------------------------------
console.log("\n== engine: sqlite ==");
const sqlitePath = join(tmpdir(), `live-${process.pid}.sqlite`);
seedSqlite(sqlitePath);
{
  const driver = new SqliteDriver(sqlitePath);
  const config: LiveConfig = { driver: "sqlite", url: sqlitePath, allowAnalyze: false, rowCap: 2, statementTimeoutMs: 5000 };
  await runDbSuite("sqlite", store, driver, config, check, {}); // no timeout: inherent no-op
  await driver.close();
}
rmSync(sqlitePath, { force: true });

const containers: string[] = [];
const canDocker = dockerAvailable();

try {
  // ---- 2b. Postgres ------------------------------------------------------
  console.log("\n== engine: postgres ==");
  let pgUrl = process.env.TSCA_PG_URL;
  if (!pgUrl) {
    if (!canDocker) {
      skipped.push("postgres (no TSCA_PG_URL and Docker unavailable)");
    } else {
      const name = `tsca-live-pg-${process.pid}`;
      const port = 55432;
      pgUrl = `postgresql://postgres:pass@127.0.0.1:${port}/tsca`;
      console.log(`  starting ${name} on :${port} …`);
      await execFileP("docker", ["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=pass", "-e", "POSTGRES_DB=tsca", "-p", `${port}:5432`, "postgres:16-alpine"]);
      containers.push(name);
      await waitReady(() => PgDriver.create(pgUrl!), 60);
    }
  }
  if (pgUrl) {
    await seedPg(pgUrl);
    const driver = await PgDriver.create(pgUrl);
    const config: LiveConfig = { driver: "postgres", url: pgUrl, allowAnalyze: false, rowCap: 2, statementTimeoutMs: 5000, schema: "public" };
    await runDbSuite("postgres", store, driver, config, check, { slowSelect: "SELECT pg_sleep(5)" });
    await driver.close();
  }

  // ---- 2c. MySQL ---------------------------------------------------------
  console.log("\n== engine: mysql ==");
  let myUrl = process.env.TSCA_MYSQL_URL;
  if (!myUrl) {
    if (!canDocker) {
      skipped.push("mysql (no TSCA_MYSQL_URL and Docker unavailable)");
    } else {
      const name = `tsca-live-mysql-${process.pid}`;
      const port = 33306;
      myUrl = `mysql://root:pass@127.0.0.1:${port}/tsca`;
      console.log(`  starting ${name} on :${port} …`);
      await execFileP("docker", ["run", "-d", "--name", name, "-e", "MYSQL_ROOT_PASSWORD=pass", "-e", "MYSQL_DATABASE=tsca", "-p", `${port}:3306`, "mysql:8"]);
      containers.push(name);
      await waitReady(() => MysqlDriver.create(myUrl!), 90);
    }
  }
  if (myUrl) {
    await seedMysql(myUrl);
    const driver = await MysqlDriver.create(myUrl);
    const config: LiveConfig = { driver: "mysql", url: myUrl, allowAnalyze: false, rowCap: 2, statementTimeoutMs: 5000 };
    await runDbSuite("mysql", store, driver, config, check, { slowSelect: "SELECT SLEEP(5)" });
    await driver.close();
  }
} finally {
  for (const name of containers) {
    console.log(`  tearing down ${name} …`);
    dockerRm(name);
  }
  store.close();
}

if (skipped.length) console.log("\nSKIPPED:", skipped.join("; "));
const engineGap = skipped.length > 0;
if (failures === 0 && !engineGap) {
  console.log("\nPASS — live-data acceptance green on sqlite + postgres + mysql");
  process.exit(0);
} else if (failures === 0 && engineGap) {
  console.log(`\nPARTIAL — checks green, but ${skipped.length} engine(s) skipped`);
  process.exit(2);
} else {
  console.log(`\nFAIL — ${failures} check(s) failed`);
  process.exit(1);
}
