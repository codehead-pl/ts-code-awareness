// Optional live-data surface. Runtime
// tools, NOT part of the map — they open the engine's own read-only connection
// when configured and never write to the map DB or boot the target app.
export { guardSelectOnly } from "./guard.ts";
export type { GuardResult } from "./guard.ts";
export { SqliteDriver, PgDriver, MysqlDriver } from "./drivers.ts";
export type { Driver, TableInfo, ColumnInfo, QueryResult, Plan } from "./drivers.ts";
export { loadLiveConfig, createDriver } from "./config.ts";
export type { LiveConfig } from "./config.ts";
export * as liveTools from "./tools.ts";
