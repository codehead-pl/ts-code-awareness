// DB drivers. SqliteDriver uses the built-in node:sqlite — a real SQL engine
// with zero native deps, so the whole surface is exercised end-to-end against an
// actual database. PgDriver/MysqlDriver lazily import their optional peer deps
// (pg / mysql2) only when configured, so the engine never carries them unless a
// live connection is set up. Every read goes through the caller's guard; drivers
// additionally cap rows (subquery wrap) and apply a statement timeout where the
// engine supports one.
import { DatabaseSync } from "node:sqlite";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}
export interface TableInfo {
  name: string;
  schema?: string;
  columns: ColumnInfo[];
}
export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}
export interface Plan {
  analyzed: boolean;
  plan: unknown;
}

export interface Driver {
  readonly kind: "sqlite" | "postgres" | "mysql";
  tables(schema?: string): Promise<TableInfo[]>;
  runSelect(sql: string, params: unknown[], opts: { rowCap: number; timeoutMs: number }): Promise<QueryResult>;
  explain(sql: string, params: unknown[], analyze: boolean): Promise<Plan>;
  quoteIdent(name: string): string;
  close(): Promise<void>;
}

/** Wrap a validated SELECT so the engine caps rows server-side (cap+1 to detect
 *  truncation). Safe because the guard already proved `sql` is a single read. */
function capWrap(sql: string, cap: number): string {
  return `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS tsca_capped LIMIT ${cap + 1}`;
}

function finish(rows: Array<Record<string, unknown>>, cap: number): QueryResult {
  const truncated = rows.length > cap;
  const capped = truncated ? rows.slice(0, cap) : rows;
  return { columns: capped.length ? Object.keys(capped[0]) : [], rows: capped, rowCount: capped.length, truncated };
}

// ---- sqlite (built-in, the tested reference driver) ---------------------

export class SqliteDriver implements Driver {
  readonly kind = "sqlite" as const;
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }
  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
  async tables(): Promise<TableInfo[]> {
    const names = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return names.map(({ name }) => {
      const cols = this.db.prepare(`PRAGMA table_info(${this.quoteIdent(name)})`).all() as Array<{ name: string; type: string; notnull: number }>;
      return { name, columns: cols.map((c) => ({ name: c.name, type: c.type || "", nullable: c.notnull === 0 })) };
    });
  }
  async runSelect(sql: string, params: unknown[], opts: { rowCap: number }): Promise<QueryResult> {
    const rows = this.db.prepare(capWrap(sql, opts.rowCap)).all(...(params as never[])) as Array<Record<string, unknown>>;
    return finish(rows, opts.rowCap);
  }
  async explain(sql: string, params: unknown[]): Promise<Plan> {
    // sqlite has no EXPLAIN ANALYZE; the query plan is always static (never executes rows).
    const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql.replace(/;\s*$/, "")}`).all(...(params as never[]));
    return { analyzed: false, plan: rows };
  }
  async close(): Promise<void> {
    this.db.close();
  }
}

// ---- postgres / mysql (lazy optional peer deps; best-effort) -------------

async function optionalImport(mod: string): Promise<any> {
  try {
    return await import(mod);
  } catch {
    throw new Error(`live-data: the '${mod}' driver is not installed — add it to run this connection`);
  }
}

export class PgDriver implements Driver {
  readonly kind = "postgres" as const;
  private constructor(private client: any) {}
  static async create(url: string): Promise<PgDriver> {
    const pg = await optionalImport("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return new PgDriver(client);
  }
  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
  async tables(schema = "public"): Promise<TableInfo[]> {
    const res = await this.client.query(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
      [schema],
    );
    const byTable = new Map<string, TableInfo>();
    for (const r of res.rows as Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>) {
      let t = byTable.get(r.table_name);
      if (!t) byTable.set(r.table_name, (t = { name: r.table_name, schema, columns: [] }));
      t.columns.push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === "YES" });
    }
    return [...byTable.values()];
  }
  async runSelect(sql: string, params: unknown[], opts: { rowCap: number; timeoutMs: number }): Promise<QueryResult> {
    await this.client.query(`SET statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`);
    const res = await this.client.query({ text: capWrap(sql, opts.rowCap), values: params, rowMode: "object" });
    return finish(res.rows as Array<Record<string, unknown>>, opts.rowCap);
  }
  async explain(sql: string, params: unknown[], analyze: boolean): Promise<Plan> {
    const res = await this.client.query(`EXPLAIN (FORMAT JSON${analyze ? ", ANALYZE" : ""}) ${sql.replace(/;\s*$/, "")}`, params);
    return { analyzed: analyze, plan: res.rows?.[0]?.["QUERY PLAN"] ?? res.rows };
  }
  async close(): Promise<void> {
    await this.client.end();
  }
}

export class MysqlDriver implements Driver {
  readonly kind = "mysql" as const;
  private constructor(private conn: any, private db: string) {}
  static async create(url: string): Promise<MysqlDriver> {
    const mysql = await optionalImport("mysql2/promise");
    const conn = await mysql.createConnection(url);
    const db = new URL(url).pathname.replace(/^\//, "");
    return new MysqlDriver(conn, db);
  }
  quoteIdent(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  async tables(schema?: string): Promise<TableInfo[]> {
    const s = schema ?? this.db;
    const [rows] = await this.conn.query(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`,
      [s],
    );
    const byTable = new Map<string, TableInfo>();
    for (const r of rows as Array<Record<string, string>>) {
      const tn = r.table_name ?? r.TABLE_NAME;
      let t = byTable.get(tn);
      if (!t) byTable.set(tn, (t = { name: tn, schema: s, columns: [] }));
      t.columns.push({ name: r.column_name ?? r.COLUMN_NAME, type: r.data_type ?? r.DATA_TYPE, nullable: (r.is_nullable ?? r.IS_NULLABLE) === "YES" });
    }
    return [...byTable.values()];
  }
  async runSelect(sql: string, params: unknown[], opts: { rowCap: number; timeoutMs: number }): Promise<QueryResult> {
    const capped = `SELECT /*+ MAX_EXECUTION_TIME(${Math.max(1, Math.floor(opts.timeoutMs))}) */ * FROM (${sql.replace(/;\s*$/, "")}) AS tsca_capped LIMIT ${opts.rowCap + 1}`;
    const [rows] = await this.conn.query(capped, params);
    return finish(rows as Array<Record<string, unknown>>, opts.rowCap);
  }
  async explain(sql: string, params: unknown[], analyze: boolean): Promise<Plan> {
    const [rows] = await this.conn.query(`EXPLAIN ${analyze ? "ANALYZE " : "FORMAT=JSON "}${sql.replace(/;\s*$/, "")}`, params);
    return { analyzed: analyze, plan: rows };
  }
  async close(): Promise<void> {
    await this.conn.end();
  }
}
