// Differential correctness oracle.
//
// Produces a *canonical* dump of a built map — every structural table sorted by
// a stable key, volatile fields (the `meta.builtAt` wall-clock stamp and the
// `build_metrics` timings) excluded — so two independently-built stores of the
// same source can be compared for byte equality. This is the reusable oracle
// incremental invalidation is validated against: incremental == full.
import type { Store } from "./store.ts";

/** Tables that make up the deterministic content of a map, each with the
 *  ORDER BY that renders its rows in a stable, build-order-independent way.
 *  `meta` (holds the volatile builtAt stamp) and `build_metrics` (timings) are
 *  intentionally excluded. */
const TABLES: Array<[table: string, orderBy: string]> = [
  ["packages", "name"],
  ["files", "id"],
  ["symbols", "id"],
  ["edges", "src, dst, kind, resolved, via, callee, file"],
  ["entrypoints", "id"],
  ["fragment_nodes", "id"],
  ["fragment_refs", "node_id, role, symbol_id"],
  ["chunks", "id"],
];

export interface CanonicalDump {
  tables: Record<string, Record<string, unknown>[]>;
}

/** Canonical, order-independent snapshot of a store's structural content. */
export function canonicalDump(store: Store): CanonicalDump {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const [table, orderBy] of TABLES) {
    tables[table] = store.dumpRows(table, orderBy).map(normalizeRow);
  }
  return { tables };
}

/** Deterministic string form of a dump, for equality / hashing / diffing. */
export function canonicalJson(store: Store): string {
  return JSON.stringify(canonicalDump(store));
}

/** Structural equality of two built stores. Returns the first differing table
 *  + row index when they diverge, or `{ equal: true }` when identical. */
export function diffStores(
  a: Store,
  b: Store,
): { equal: true } | { equal: false; table: string; index: number; a: unknown; b: unknown } {
  const da = canonicalDump(a);
  const db = canonicalDump(b);
  for (const table of Object.keys(da.tables)) {
    const ra = da.tables[table];
    const rb = db.tables[table];
    const n = Math.max(ra.length, rb.length);
    for (let i = 0; i < n; i += 1) {
      const sa = JSON.stringify(ra[i] ?? null);
      const sb = JSON.stringify(rb[i] ?? null);
      if (sa !== sb) return { equal: false, table, index: i, a: ra[i] ?? null, b: rb[i] ?? null };
    }
  }
  return { equal: true };
}

/** BLOB columns come back as Uint8Array; render them as a plain number array so
 *  JSON.stringify is stable across engines. Everything else passes through. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Uint8Array ? Array.from(v) : v;
  }
  return out;
}
