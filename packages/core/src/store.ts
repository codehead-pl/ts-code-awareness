// SQLite-backed store. Uses built-in node:sqlite (Node 22.5+), so there is no
// native-module compile step.
//
// Each row derives from exactly one source file, so provenance is a `file`
// column rather than a separate table.
import { DatabaseSync } from "node:sqlite";
import type {
  ChunkRecord,
  EdgeKind,
  EdgeRecord,
  EntrypointRecord,
  FileRecord,
  FragmentNodeRecord,
  Span,
  SymbolExtra,
  SymbolRecord,
} from "./types.ts";

export interface FindOpts {
  name?: string;
  kind?: string;
  package?: string;
  exported?: boolean;
  limit?: number;
}

export interface PackageRecord {
  name: string;
  root: string;
  tsconfig: string | null;
  workspaceDeps: string[];
}

// Physical table shape version. Bump when the schema changes: on mismatch the
// store drops and rebuilds. Distinct from the map's logical schemaVersion in `meta`.
const STORE_SCHEMA = "5";

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.init();
  }

  private init(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
    const ver = (this.db.prepare("SELECT value FROM meta WHERE key = 'storeSchema'").get() as
      | { value: string }
      | undefined)?.value;
    if (ver !== STORE_SCHEMA) {
      this.db.exec(
        "DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS entrypoints; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS packages; DROP TABLE IF EXISTS fragment_nodes; DROP TABLE IF EXISTS fragment_refs; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS build_metrics;",
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS packages (name TEXT PRIMARY KEY, root TEXT, tsconfig TEXT, deps TEXT);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, package TEXT, path TEXT, hash TEXT, module TEXT
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY, file TEXT, package TEXT, container TEXT,
        kind TEXT, name TEXT, exported INTEGER, tier INTEGER,
        signature TEXT, doc TEXT, span TEXT, extra TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS ix_symbols_kind ON symbols(kind);
      CREATE INDEX IF NOT EXISTS ix_symbols_file ON symbols(file);
      CREATE INDEX IF NOT EXISTS ix_symbols_container ON symbols(container);
      CREATE TABLE IF NOT EXISTS edges (
        src TEXT, dst TEXT, kind TEXT, resolved TEXT, via TEXT, callee TEXT, file TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_edges_src ON edges(src, kind);
      CREATE INDEX IF NOT EXISTS ix_edges_dst ON edges(dst, kind);
      CREATE INDEX IF NOT EXISTS ix_edges_file ON edges(file);
      CREATE TABLE IF NOT EXISTS entrypoints (
        id TEXT PRIMARY KEY, kind TEXT, source TEXT, symbol TEXT, detail TEXT, file TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_entrypoints_file ON entrypoints(file);
      CREATE TABLE IF NOT EXISTS fragment_nodes (
        id TEXT PRIMARY KEY, adapter TEXT, kind TEXT, attrs TEXT, span TEXT, provenance TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_fragnodes_adapter ON fragment_nodes(adapter);
      CREATE INDEX IF NOT EXISTS ix_fragnodes_kind ON fragment_nodes(adapter, kind);
      CREATE TABLE IF NOT EXISTS fragment_refs (node_id TEXT, role TEXT, symbol_id TEXT);
      CREATE INDEX IF NOT EXISTS ix_fragrefs_node ON fragment_refs(node_id);
      CREATE INDEX IF NOT EXISTS ix_fragrefs_symbol ON fragment_refs(symbol_id);
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, anchor TEXT, level TEXT, kind TEXT, package TEXT, file TEXT,
        span TEXT, header TEXT, snippet TEXT, text_hash TEXT, dim INTEGER, vec BLOB
      );
      CREATE INDEX IF NOT EXISTS ix_chunks_package ON chunks(package);
      CREATE INDEX IF NOT EXISTS ix_chunks_kind ON chunks(kind);
      CREATE INDEX IF NOT EXISTS ix_chunks_anchor ON chunks(anchor);
      CREATE TABLE IF NOT EXISTS build_metrics (
        op TEXT, package TEXT, ms REAL, at TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_build_metrics_op ON build_metrics(op, package);
    `);
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES('storeSchema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(STORE_SCHEMA);
  }

  // Note: `chunks` is deliberately NOT cleared — the semantic index is a sidecar
  // that survives skeleton rebuilds so hash-gated re-embed stays cheap;
  // indexPackage reconciles it against the rebuilt symbols.
  reset(): void {
    // NB: `meta` keeps its `storeSchema` sentinel. Wiping it would leave a
    // populated DB with no schema row, so the next open would hit the
    // version-mismatch branch in init() and DROP every table.
    this.db.exec(
      "DELETE FROM symbols; DELETE FROM edges; DELETE FROM entrypoints; DELETE FROM files; DELETE FROM packages; DELETE FROM meta WHERE key <> 'storeSchema'; DELETE FROM fragment_nodes; DELETE FROM fragment_refs; DELETE FROM build_metrics;",
    );
  }

  /** Incremental: drop every row derived from a file before rebuilding it. */
  deleteFileRows(fileId: string): void {
    this.db.prepare("DELETE FROM symbols WHERE file = ?").run(fileId);
    this.db.prepare("DELETE FROM edges WHERE file = ?").run(fileId);
    this.db.prepare("DELETE FROM entrypoints WHERE file = ?").run(fileId);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  }

  /** Symbol ids currently stored for a file — the pre-edit identity set that
   *  incremental diffs against a fresh parse to detect a *structural* change
   *  (a symbol added / removed / renamed, which can shift cross-file edges). */
  symbolIdsInFile(fileId: string): Set<string> {
    const rows = this.db.prepare("SELECT id FROM symbols WHERE file = ?").all(fileId) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Re-assert Tier-2 on every hydrated package's symbols. A per-file rewrite
   *  re-inserts symbols at tier 1 (pass 1); this restores the tier the package
   *  had, so an incremental map matches a from-scratch fully-hydrated one. */
  retierHydrated(): void {
    for (const pkg of this.hydratedPackages()) {
      this.db.prepare("UPDATE symbols SET tier = 2 WHERE package = ?").run(pkg);
    }
  }

  /** Incremental per-fragment invalidation: drop an adapter's fragment nodes
   *  (and their refs) whose provenance points into `pkg`, so re-running that
   *  adapter over the package yields no stale/duplicate rows. Fragments with a
   *  synthetic-but-package-prefixed provenance (Prisma `.prisma`/migration ids)
   *  are attributed by their `pkg|…` head, giving them real file provenance. */
  deleteFragmentsForPackage(adapter: string, pkg: string): void {
    const rows = this.db.prepare("SELECT id, provenance FROM fragment_nodes WHERE adapter = ?").all(adapter) as Array<{
      id: string;
      provenance: string | null;
    }>;
    const prefix = `${pkg}|`;
    const delNode = this.db.prepare("DELETE FROM fragment_nodes WHERE id = ?");
    const delRefs = this.db.prepare("DELETE FROM fragment_refs WHERE node_id = ?");
    for (const r of rows) {
      const prov = r.provenance ? (JSON.parse(r.provenance) as string[]) : [];
      if (prov.some((p) => p.startsWith(prefix))) {
        delNode.run(r.id);
        delRefs.run(r.id);
      }
    }
  }

  transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- meta / packages / files ------------------------------------------

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  upsertPackage(p: PackageRecord): void {
    this.db
      .prepare(
        "INSERT INTO packages(name, root, tsconfig, deps) VALUES(?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET root = excluded.root, tsconfig = excluded.tsconfig, deps = excluded.deps",
      )
      .run(p.name, p.root, p.tsconfig, JSON.stringify(p.workspaceDeps));
  }

  listPackages(): PackageRecord[] {
    const rows = this.db.prepare("SELECT name, root, tsconfig, deps FROM packages ORDER BY name").all() as unknown as Array<{
      name: string;
      root: string;
      tsconfig: string | null;
      deps: string | null;
    }>;
    return rows.map((r) => ({ name: r.name, root: r.root, tsconfig: r.tsconfig, workspaceDeps: r.deps ? JSON.parse(r.deps) : [] }));
  }

  // ---- tiers -----------------------

  /** Packages whose Tier-2 (call graph) has been built. */
  hydratedPackages(): string[] {
    const v = this.getMeta("hydrated");
    return v ? (JSON.parse(v) as string[]) : [];
  }

  markHydrated(pkg: string): void {
    const set = new Set(this.hydratedPackages());
    set.add(pkg);
    this.setMeta("hydrated", JSON.stringify([...set]));
    this.db.prepare("UPDATE symbols SET tier = 2 WHERE package = ?").run(pkg);
  }

  isHydrated(pkg: string): boolean {
    return this.hydratedPackages().includes(pkg);
  }

  upsertFile(f: FileRecord): void {
    this.db
      .prepare(
        `INSERT INTO files(id, package, path, hash, module) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET package = excluded.package, path = excluded.path,
           hash = excluded.hash, module = excluded.module`,
      )
      .run(f.id, f.package, f.path, f.hash, f.module);
  }

  getFile(id: string): FileRecord | null {
    const row = this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as
      | FileRecord
      | undefined;
    return row ?? null;
  }

  /** Map of fileId -> content hash, for incremental fingerprint diffing. */
  fileHashes(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, hash FROM files").all() as Array<{
      id: string;
      hash: string;
    }>;
    return new Map(rows.map((r) => [r.id, r.hash]));
  }

  // ---- symbols ----------------------------------------------------------

  upsertSymbol(s: SymbolRecord): void {
    this.db
      .prepare(
        `INSERT INTO symbols(id, file, package, container, kind, name, exported, tier, signature, doc, span, extra)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           file = excluded.file, package = excluded.package, container = excluded.container,
           kind = excluded.kind, name = excluded.name, exported = excluded.exported,
           tier = excluded.tier, signature = excluded.signature, doc = excluded.doc,
           span = excluded.span, extra = excluded.extra`,
      )
      .run(
        s.id,
        s.file,
        s.package,
        s.container,
        s.kind,
        s.name,
        s.exported ? 1 : 0,
        s.tier,
        s.signature,
        s.doc,
        JSON.stringify(s.span),
        JSON.stringify(s.extra ?? {}),
      );
  }

  findSymbols(opts: FindOpts): SymbolRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.name) {
      clauses.push("name LIKE ?");
      params.push(`%${opts.name}%`);
    }
    if (opts.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.package) {
      clauses.push("package = ?");
      params.push(opts.package);
    }
    if (opts.exported !== undefined) {
      clauses.push("exported = ?");
      params.push(opts.exported ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(opts.limit ?? 50, 500);
    const rows = this.db
      .prepare(`SELECT * FROM symbols ${where} ORDER BY name LIMIT ?`)
      .all(...(params as never[]), limit) as unknown as SymbolRow[];
    return rows.map(rowToSymbol);
  }

  getSymbol(id: string): SymbolRecord | null {
    const row = this.db.prepare("SELECT * FROM symbols WHERE id = ?").get(id) as
      | SymbolRow
      | undefined;
    return row ? rowToSymbol(row) : null;
  }

  membersOf(containerId: string): SymbolRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM symbols WHERE container = ? ORDER BY rowid")
      .all(containerId) as unknown as SymbolRow[];
    return rows.map(rowToSymbol);
  }

  symbolsInFile(fileId: string): SymbolRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM symbols WHERE file = ? AND container IS NULL ORDER BY rowid")
      .all(fileId) as unknown as SymbolRow[];
    return rows.map(rowToSymbol);
  }

  /** Every symbol in a package (unbounded — for the semantic chunker). */
  symbolsByPackage(pkg: string): SymbolRecord[] {
    const rows = this.db.prepare("SELECT * FROM symbols WHERE package = ? ORDER BY rowid").all(pkg) as unknown as SymbolRow[];
    return rows.map(rowToSymbol);
  }

  // ---- edges ------------------------------------------------------------

  insertEdge(e: EdgeRecord & { file: string }): void {
    this.db
      .prepare("INSERT INTO edges(src, dst, kind, resolved, via, callee, file) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(e.src, e.dst, e.kind, e.resolved, e.via, e.callee, e.file);
  }

  edgesFrom(src: string, kinds?: EdgeKind[]): EdgeRecord[] {
    return this.queryEdges("src", src, kinds);
  }

  edgesTo(dst: string, kinds?: EdgeKind[]): EdgeRecord[] {
    return this.queryEdges("dst", dst, kinds);
  }

  private queryEdges(col: "src" | "dst", value: string, kinds?: EdgeKind[]): EdgeRecord[] {
    let sql = `SELECT src, dst, kind, resolved, via, callee FROM edges WHERE ${col} = ?`;
    const params: unknown[] = [value];
    if (kinds && kinds.length) {
      sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
      params.push(...kinds);
    }
    return this.db.prepare(sql).all(...(params as never[])) as unknown as EdgeRecord[];
  }

  // ---- entrypoints ------------------------------------------------------

  upsertEntrypoint(e: EntrypointRecord & { file: string }): void {
    this.db
      .prepare(
        `INSERT INTO entrypoints(id, kind, source, symbol, detail, file) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, source = excluded.source,
           symbol = excluded.symbol, detail = excluded.detail, file = excluded.file`,
      )
      .run(e.id, e.kind, e.source, e.symbol, e.detail ? JSON.stringify(e.detail) : null, e.file);
  }

  listEntrypoints(kind?: string): EntrypointRecord[] {
    const rows = kind
      ? (this.db.prepare("SELECT * FROM entrypoints WHERE kind = ?").all(kind) as unknown as EntrypointRow[])
      : (this.db.prepare("SELECT * FROM entrypoints").all() as unknown as EntrypointRow[]);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as EntrypointRecord["kind"],
      source: r.source,
      symbol: r.symbol,
      detail: r.detail ? JSON.parse(r.detail) : null,
    }));
  }

  // ---- adapter fragments -----------

  /** Upsert a fragment node and rewrite its flattened refs. */
  upsertFragment(n: FragmentNodeRecord): void {
    this.db
      .prepare(
        `INSERT INTO fragment_nodes(id, adapter, kind, attrs, span, provenance) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET adapter = excluded.adapter, kind = excluded.kind,
           attrs = excluded.attrs, span = excluded.span, provenance = excluded.provenance`,
      )
      .run(n.id, n.adapter, n.kind, JSON.stringify(n.attrs), n.span ? JSON.stringify(n.span) : null, JSON.stringify(n.provenance));
    this.db.prepare("DELETE FROM fragment_refs WHERE node_id = ?").run(n.id);
    const insRef = this.db.prepare("INSERT INTO fragment_refs(node_id, role, symbol_id) VALUES(?, ?, ?)");
    for (const [role, val] of Object.entries(n.refs)) {
      for (const sym of Array.isArray(val) ? val : [val]) insRef.run(n.id, role, sym);
    }
  }

  fragment(id: string): FragmentNodeRecord | null {
    const row = this.db.prepare("SELECT * FROM fragment_nodes WHERE id = ?").get(id) as FragmentRow | undefined;
    return row ? this.rowToFragment(row) : null;
  }

  /** Fragment nodes of a given adapter, optionally filtered by kind. */
  fragments(adapter: string, kind?: string): FragmentNodeRecord[] {
    const rows = kind
      ? (this.db.prepare("SELECT * FROM fragment_nodes WHERE adapter = ? AND kind = ? ORDER BY id").all(adapter, kind) as unknown as FragmentRow[])
      : (this.db.prepare("SELECT * FROM fragment_nodes WHERE adapter = ? ORDER BY id").all(adapter) as unknown as FragmentRow[]);
    return rows.map((r) => this.rowToFragment(r));
  }

  /** Fragment nodes referencing a symbol (optionally in a given role). */
  fragmentsBySymbol(symbolId: string, role?: string): FragmentNodeRecord[] {
    const rows = role
      ? (this.db.prepare("SELECT DISTINCT node_id FROM fragment_refs WHERE symbol_id = ? AND role = ?").all(symbolId, role) as Array<{ node_id: string }>)
      : (this.db.prepare("SELECT DISTINCT node_id FROM fragment_refs WHERE symbol_id = ?").all(symbolId) as Array<{ node_id: string }>);
    return rows.map((r) => this.fragment(r.node_id)).filter((n): n is FragmentNodeRecord => n !== null);
  }

  private rowToFragment(row: FragmentRow): FragmentNodeRecord {
    const refs: Record<string, string | string[]> = {};
    const refRows = this.db.prepare("SELECT role, symbol_id FROM fragment_refs WHERE node_id = ?").all(row.id) as Array<{ role: string; symbol_id: string }>;
    for (const r of refRows) {
      const prev = refs[r.role];
      if (prev === undefined) refs[r.role] = r.symbol_id;
      else if (Array.isArray(prev)) prev.push(r.symbol_id);
      else refs[r.role] = [prev, r.symbol_id];
    }
    return {
      id: row.id,
      adapter: row.adapter,
      kind: row.kind,
      attrs: row.attrs ? JSON.parse(row.attrs) : {},
      refs,
      span: row.span ? (JSON.parse(row.span) as Span) : null,
      provenance: row.provenance ? JSON.parse(row.provenance) : [],
    };
  }

  // ---- semantic chunks (sidecar) --------

  upsertChunk(c: ChunkRecord): void {
    const buf = Buffer.from(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength);
    this.db
      .prepare(
        `INSERT INTO chunks(id, anchor, level, kind, package, file, span, header, snippet, text_hash, dim, vec)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET anchor = excluded.anchor, level = excluded.level, kind = excluded.kind,
           package = excluded.package, file = excluded.file, span = excluded.span, header = excluded.header,
           snippet = excluded.snippet, text_hash = excluded.text_hash, dim = excluded.dim, vec = excluded.vec`,
      )
      .run(c.id, c.anchor, c.level, c.kind, c.package, c.file, c.span ? JSON.stringify(c.span) : null, c.header, c.snippet, c.textHash, c.vec.length, buf);
  }

  deleteChunk(id: string): void {
    this.db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
  }

  /** id → text_hash for a package, to gate incremental re-embed. */
  chunkHashes(pkg: string): Map<string, string> {
    const rows = this.db.prepare("SELECT id, text_hash FROM chunks WHERE package = ?").all(pkg) as Array<{ id: string; text_hash: string }>;
    return new Map(rows.map((r) => [r.id, r.text_hash]));
  }

  /** Load chunk vectors + metadata for brute-force search, filtered in-SQL. */
  searchChunks(filter: { kind?: string; package?: string } = {}): ChunkRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.package) {
      clauses.push("package = ?");
      params.push(filter.package);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM chunks ${where}`).all(...(params as never[])) as unknown as ChunkRow[];
    return rows.map(rowToChunk);
  }

  chunkById(id: string): ChunkRecord | null {
    const row = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  /** Packages that currently have any chunk rows (drives search coverage). */
  packagesWithChunks(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT package FROM chunks").all() as Array<{ package: string }>;
    return rows.map((r) => r.package);
  }

  countChunks(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  }

  // ---- build metrics ----------------

  /** Append one build-timing sample. Cleared on full rebuild (reset()). */
  recordMetric(op: string, pkg: string, ms: number): void {
    this.db
      .prepare("INSERT INTO build_metrics(op, package, ms, at) VALUES(?, ?, ?, ?)")
      .run(op, pkg, ms, new Date().toISOString());
  }

  /** Latest timing per (op, package), newest sample winning. */
  metrics(): Array<{ op: string; package: string; ms: number; at: string }> {
    return this.db
      .prepare(
        `SELECT op, package, ms, at FROM build_metrics b
         WHERE rowid = (SELECT MAX(rowid) FROM build_metrics WHERE op = b.op AND package = b.package)
         ORDER BY op, package`,
      )
      .all() as Array<{ op: string; package: string; ms: number; at: string }>;
  }

  /** DB file size on disk + per-table row counts (map-size block). */
  mapSize(): { bytes: number; tables: Record<string, number> } {
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    const rows = (name: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
    return {
      bytes: pageCount * pageSize,
      tables: {
        symbols: rows("symbols"),
        edges: rows("edges"),
        entrypoints: rows("entrypoints"),
        fragment_nodes: rows("fragment_nodes"),
        fragment_refs: rows("fragment_refs"),
        chunks: rows("chunks"),
      },
    };
  }

  /** Dump a table's rows sorted by a fixed key — for the differential oracle.
   *  `table`/`orderBy` are code-supplied constants (never user input). */
  dumpRows(table: string, orderBy: string): Record<string, unknown>[] {
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Record<string, unknown>[];
  }

  // ---- stats ------------------------------------------------------------

  counts(): { symbols: number; files: number; edges: number; packages: number; entrypoints: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      symbols: one("SELECT COUNT(*) AS n FROM symbols"),
      files: one("SELECT COUNT(*) AS n FROM files"),
      edges: one("SELECT COUNT(*) AS n FROM edges"),
      packages: one("SELECT COUNT(*) AS n FROM packages"),
      entrypoints: one("SELECT COUNT(*) AS n FROM entrypoints"),
    };
  }

  countSymbols(): number {
    return this.counts().symbols;
  }

  close(): void {
    this.db.close();
  }
}

interface SymbolRow {
  id: string;
  file: string;
  package: string;
  container: string | null;
  kind: string;
  name: string;
  exported: number;
  tier: number;
  signature: string | null;
  doc: string | null;
  span: string;
  extra: string | null;
}

interface EntrypointRow {
  id: string;
  kind: string;
  source: string;
  symbol: string | null;
  detail: string | null;
}

interface FragmentRow {
  id: string;
  adapter: string;
  kind: string;
  attrs: string | null;
  span: string | null;
  provenance: string | null;
}

interface ChunkRow {
  id: string;
  anchor: string;
  level: string;
  kind: string;
  package: string;
  file: string;
  span: string | null;
  header: string;
  snippet: string;
  text_hash: string;
  dim: number;
  vec: Uint8Array;
}

function rowToChunk(row: ChunkRow): ChunkRecord {
  // Copy into a fresh (4-byte-aligned) buffer — a SQLite BLOB's byteOffset isn't
  // guaranteed aligned, and Float32Array requires it.
  const copy = row.vec.slice();
  const vec = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  return {
    id: row.id,
    anchor: row.anchor,
    level: row.level as ChunkRecord["level"],
    kind: row.kind as ChunkRecord["kind"],
    package: row.package,
    file: row.file,
    span: row.span ? JSON.parse(row.span) : null,
    header: row.header,
    snippet: row.snippet,
    textHash: row.text_hash,
    vec,
  };
}

function rowToSymbol(row: SymbolRow): SymbolRecord {
  return {
    id: row.id,
    file: row.file,
    package: row.package,
    container: row.container,
    kind: row.kind as SymbolRecord["kind"],
    name: row.name,
    exported: !!row.exported,
    tier: row.tier,
    signature: row.signature,
    doc: row.doc,
    span: JSON.parse(row.span),
    extra: (row.extra ? JSON.parse(row.extra) : {}) as SymbolExtra,
  };
}
