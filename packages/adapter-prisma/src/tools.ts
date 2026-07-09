// db_* tools. Compact projections over the prisma:*
// fragments. The model↔code bridge (db_model_usage) is the headline join.
import type { Store } from "@tsca/core";

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function relPath(id: string): string {
  return id.split("|")[1] ?? id;
}

function symRef(store: Store, id: string | undefined): Record<string, unknown> | undefined {
  if (!id) return undefined;
  const s = store.getSymbol(id);
  if (!s) return { id };
  return { id, name: s.name, kind: s.kind, loc: `${relPath(s.file)}:${s.span.startLine}-${s.span.endLine}` };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

interface FieldAttr {
  name: string;
  type: string;
  isRelation: boolean;
  nullable: boolean;
  isId: boolean;
}
interface RelationAttr {
  name: string;
  target: string;
  kind: string;
  fk: string | null;
}

export function db_models(store: Store, args: Args) {
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const models = store.fragments("prisma", "model");
  return {
    count: models.length,
    models: models.slice(0, limit).map((m) => {
      const fields = (m.attrs.fields as FieldAttr[]) ?? [];
      const relations = (m.attrs.relations as RelationAttr[]) ?? [];
      return {
        name: m.attrs.name,
        table: m.attrs.table,
        fieldCount: fields.filter((f) => !f.isRelation).length,
        relationSummary: relations.map((r) => `${r.name}:${r.target}(${r.kind})`),
        clientStale: m.attrs.clientStale === true,
      };
    }),
    ...(models.length > limit ? { nextCursor: String(limit) } : {}),
  };
}

export function db_model(store: Store, args: Args) {
  const model = str(args.model);
  if (!model) return { error: "db_model requires `model`" };
  const m = store.fragment(model.startsWith("prisma:model:") ? model : `prisma:model:${model}`);
  if (!m) return { error: `model not found: ${model}` };
  return {
    name: m.attrs.name,
    table: m.attrs.table,
    idFields: m.attrs.idFields,
    fields: m.attrs.fields,
    relations: m.attrs.relations,
    indexes: m.attrs.indexes,
    uniques: m.attrs.uniques,
    clientStale: m.attrs.clientStale === true,
    span: m.span,
  };
}

export function db_er(store: Store, args: Args) {
  const around = str(args.around);
  const depth = typeof args.depth === "number" ? args.depth : 1;
  const models = store.fragments("prisma", "model");
  const edges: Array<{ from: string; to: string; kind: string; fk: string | null }> = [];
  for (const m of models) {
    for (const r of (m.attrs.relations as RelationAttr[]) ?? []) {
      edges.push({ from: String(m.attrs.name), to: r.target, kind: r.kind, fk: r.fk });
    }
  }
  let names = models.map((m) => String(m.attrs.name));
  if (around) {
    // BFS out to `depth` over the (undirected) relation graph.
    const keep = new Set([around]);
    let frontier = new Set([around]);
    for (let d = 0; d < depth; d += 1) {
      const next = new Set<string>();
      for (const e of edges) {
        if (frontier.has(e.from) && !keep.has(e.to)) next.add(e.to);
        if (frontier.has(e.to) && !keep.has(e.from)) next.add(e.from);
      }
      for (const n of next) keep.add(n);
      frontier = next;
    }
    names = names.filter((n) => keep.has(n));
  }
  const nameSet = new Set(names);
  return {
    models: names,
    relations: edges.filter((e) => nameSet.has(e.from) && nameSet.has(e.to)),
  };
}

export function db_model_usage(store: Store, args: Args) {
  const model = str(args.model);
  if (!model) return { error: "db_model_usage requires `model`" };
  const name = model.replace(/^prisma:model:/, "");
  const rw = str(args.rw);
  let accesses = store.fragments("prisma", "access").filter((a) => a.attrs.model === name);
  if (rw) accesses = accesses.filter((a) => a.attrs.rw === rw);
  const hydrated = store.hydratedPackages().length;
  const total = store.counts().packages;
  return {
    model: name,
    count: accesses.length,
    accesses: accesses.map((a) => ({
      op: a.attrs.op,
      rw: a.attrs.rw,
      fields: a.attrs.fields,
      confidence: a.attrs.confidence,
      caller: symRef(store, first(a.refs.caller)),
      span: a.span,
    })),
    // access recognition is source-structural (built at skeleton), so it is
    // complete regardless of Tier-2 hydration.
    coverage: { scanned: total, total, unit: "packages", complete: true, hydrated },
  };
}

export function db_enums(store: Store, _args: Args) {
  return {
    enums: store.fragments("prisma", "enum").map((e) => ({ name: e.attrs.name, members: e.attrs.members })),
  };
}

export function db_raw_queries(store: Store, args: Args) {
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const raws = store.fragments("prisma", "raw-query");
  return {
    count: raws.length,
    queries: raws.slice(0, limit).map((r) => ({
      kind: r.attrs.kind,
      rw: r.attrs.rw,
      sql: r.attrs.sql,
      caller: symRef(store, first(r.refs.caller)),
      span: r.span,
    })),
    ...(raws.length > limit ? { nextCursor: String(limit) } : {}),
  };
}

export function db_migrations(store: Store, _args: Args) {
  const migrations = store.fragments("prisma", "migration");
  const models = store.fragments("prisma", "model");
  const schemaTables = new Set(models.map((m) => String(m.attrs.table)));
  const migratedTables = new Set<string>();
  for (const mig of migrations) for (const t of (mig.attrs.tables as string[]) ?? []) migratedTables.add(t);

  const missingInMigrations = [...schemaTables].filter((t) => !migratedTables.has(t));
  const orphanTables = [...migratedTables].filter((t) => !schemaTables.has(t));

  return {
    // Static: no DB is touched, so applied-vs-pending is not determinable here —
    // we report the migrations found and schema↔migration table drift.
    note: "static analysis — no database connection; 'applied' state is not known",
    count: migrations.length,
    migrations: migrations.map((m) => ({
      name: m.attrs.name,
      statements: m.attrs.statements,
      operations: m.attrs.operations,
      tables: m.attrs.tables,
    })),
    drift: {
      tablesInSchemaWithoutMigration: missingInMigrations,
      tablesInMigrationsNotInSchema: orphanTables,
      clean: missingInMigrations.length === 0 && orphanTables.length === 0,
    },
  };
}

export type PrismaTool = (store: Store, args: Args) => unknown;
