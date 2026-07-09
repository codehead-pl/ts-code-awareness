// Per-project live-data config — only active when a DB connection is configured.
// Read from `tsca.config.json` at the project root
// (a `liveData` block), with env overrides. Absent config → the data_* tools do
// not appear at all.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "./drivers.ts";

export interface LiveConfig {
  driver: "sqlite" | "postgres" | "mysql";
  url: string; // connection string, or a file path / :memory: for sqlite
  allowAnalyze: boolean; // gates EXPLAIN ANALYZE (the only "may execute" relaxation)
  rowCap: number; // hard cap on rows returned
  statementTimeoutMs: number;
  schema?: string; // default schema for introspection (pg/mysql)
}

const DEFAULTS = { allowAnalyze: false, rowCap: 100, statementTimeoutMs: 5000 };

export function loadLiveConfig(projectRoot: string): LiveConfig | null {
  let raw: Partial<LiveConfig> = {};
  const cfgPath = join(projectRoot, "tsca.config.json");
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as { liveData?: Partial<LiveConfig> };
      if (parsed.liveData) raw = parsed.liveData;
    } catch {
      /* ignore malformed config → treat as unconfigured */
    }
  }
  const driver = (process.env.TSCA_DB_DRIVER as LiveConfig["driver"]) ?? raw.driver;
  const url = process.env.TSCA_DB_URL ?? raw.url;
  if (!driver || !url) return null;
  if (!["sqlite", "postgres", "mysql"].includes(driver)) return null;
  return {
    driver,
    url,
    allowAnalyze: raw.allowAnalyze ?? DEFAULTS.allowAnalyze,
    rowCap: raw.rowCap ?? DEFAULTS.rowCap,
    statementTimeoutMs: raw.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs,
    schema: raw.schema,
  };
}

export async function createDriver(config: LiveConfig): Promise<Driver> {
  const { SqliteDriver, PgDriver, MysqlDriver } = await import("./drivers.ts");
  switch (config.driver) {
    case "sqlite":
      return new SqliteDriver(config.url);
    case "postgres":
      return PgDriver.create(config.url);
    case "mysql":
      return MysqlDriver.create(config.url);
  }
}
