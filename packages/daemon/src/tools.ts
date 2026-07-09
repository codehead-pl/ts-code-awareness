// Category-A tools: thin, compact projections over the store. Reverse queries
// carry a coverage envelope.
import type { Project } from "./projects.ts";
import type { EdgeKind, EdgeRecord, SymbolRecord, Store } from "@codehead-pl/tsca-core";
import { search as semanticSearch, searchSimilar as semanticSimilar, indexPackage } from "@codehead-pl/tsca-core";

export interface ToolArgs {
  name?: string;
  kind?: string;
  package?: string;
  exported?: boolean;
  limit?: number;
  symbol?: string;
  id?: string;
  target?: string;
  file?: string;
  kinds?: EdgeKind[];
  view?: "summary" | "full";
  from?: string;
  to?: string;
  maxDepth?: number;
  transitive?: boolean;
  query?: string;
}

function relPath(id: string): string {
  const parts = id.split("|");
  return parts[1] ?? id;
}
function loc(s: SymbolRecord): string {
  return `${relPath(s.file)}:${s.span.startLine}-${s.span.endLine}`;
}
function completeCoverage(store: Store) {
  const n = store.counts().packages;
  return { scanned: n, total: n, unit: "packages" as const, complete: true };
}

function pkgOfId(id: string): string {
  const i = id.indexOf("|");
  return i < 0 ? id : id.slice(0, i);
}

/** Coverage for call-graph reverse queries: only hydrated packages' calls exist. */
function hydratedCoverage(store: Store) {
  const total = store.counts().packages;
  const scanned = store.hydratedPackages().length;
  const complete = scanned >= total;
  return {
    scanned,
    total,
    unit: "packages" as const,
    complete,
    ...(complete ? {} : { expand: "inbound call edges exist only for hydrated packages; drill into a package to hydrate it" }),
  };
}

// Tier-2 edge kinds: built lazily by the per-package call/reference sweep, so a
// forward query hydrates on demand and a reverse query reports hydrated (not
// complete) coverage. `references` joins `calls`/`instantiates` here.
const CALL_KINDS = new Set(["calls", "instantiates", "references"]);

/** Resolve an edge endpoint id to a compact reference. */
function ref(store: Store, id: string): Record<string, unknown> {
  if (id.startsWith("external:")) return { id, external: id.slice("external:".length) };
  const s = store.getSymbol(id);
  if (s) return { id, name: s.name, kind: s.kind, loc: loc(s) };
  const rp = relPath(id);
  return { id, file: rp }; // a file id
}

export function overview(p: Project) {
  const c = p.store.counts();
  const eps: Record<string, number> = {};
  for (const e of p.store.listEntrypoints()) eps[e.kind] = (eps[e.kind] ?? 0) + 1;
  return {
    root: p.root,
    builtAt: p.builtAt,
    workspace: {
      tool: p.store.getMeta("workspaceTool") ?? "single",
      packages: p.store.listPackages().map((pkg) => ({ name: pkg.name, dependsOn: pkg.workspaceDeps })),
    },
    counts: c,
    tiers: { hydrated: p.store.hydratedPackages(), total: c.packages, note: "Tier-1 (structural) built for all; Tier-2 (calls) hydrated on demand" },
    entrypointsByKind: eps,
    build: {
      durations: p.store.metrics().map((m) => ({ op: m.op, package: m.package, ms: m.ms })),
      mapSize: p.store.mapSize(),
    },
  };
}

export function list_packages(p: Project) {
  return { packages: p.store.listPackages() };
}

export function find_symbols(p: Project, args: ToolArgs) {
  const rows = p.store.findSymbols({
    name: args.name,
    kind: args.kind,
    package: args.package,
    exported: args.exported,
    limit: args.limit,
  });
  return {
    count: rows.length,
    results: rows.map((s) => ({ id: s.id, kind: s.kind, name: s.name, package: s.package, signature: s.signature, loc: loc(s) })),
  };
}

export function get_symbol(p: Project, args: ToolArgs) {
  const id = args.symbol ?? args.id;
  if (!id) return { error: "get_symbol requires `symbol` (a SymbolId)" };
  const s = p.store.getSymbol(id);
  if (!s) return { error: `symbol not found: ${id}` };
  const members = p.store.membersOf(s.id).map((m) => ({ id: m.id, kind: m.kind, name: m.name, signature: m.signature }));
  const base = {
    id: s.id,
    kind: s.kind,
    name: s.name,
    package: s.package,
    container: s.container,
    exported: s.exported,
    signature: s.signature,
    doc: s.doc,
    loc: loc(s),
    members: members.length ? members : undefined,
  };
  if (args.view === "full") {
    return { ...base, ...s.extra };
  }
  // summary: surface decorators (cheap, high-signal for Nest) but not full param/flag detail
  return { ...base, decorators: s.extra.decorators?.map((d) => d.name) };
}

export function type_of(p: Project, args: ToolArgs) {
  const id = args.symbol ?? args.id;
  if (!id) return { error: "type_of requires `symbol`" };
  const s = p.store.getSymbol(id);
  if (!s) return { error: `symbol not found: ${id}` };
  return { id: s.id, signature: s.signature, returns: s.extra.returns ?? null, params: s.extra.params, typeText: s.extra.typeText ?? null };
}

export function get_file(p: Project, args: ToolArgs) {
  if (!args.file) return { error: "get_file requires `file` (a FileId)" };
  const f = p.store.getFile(args.file);
  if (!f) return { error: `file not found: ${args.file}` };
  const symbols = p.store.symbolsInFile(args.file).map((s) => ({ id: s.id, kind: s.kind, name: s.name, signature: s.signature, loc: loc(s) }));
  const imports = p.store.edgesFrom(args.file, ["imports"]).map((e) => ref(p.store, e.dst));
  return { id: f.id, package: f.package, path: f.path, symbols, imports };
}

export function relations(p: Project, args: ToolArgs) {
  const target = args.target ?? args.symbol;
  if (!target) return { error: "relations requires `target`" };
  // Forward calls are bounded by the target's package — hydrate it on demand.
  const wantsCalls = !args.kinds || args.kinds.some((k) => CALL_KINDS.has(k));
  if (wantsCalls && target.includes("|")) p.hydrate(pkgOfId(target));
  const edges = p.store.edgesFrom(target, args.kinds);
  return {
    edges: edges.map((e) => ({ ...ref(p.store, e.dst), kind: e.kind, resolved: e.resolved, via: e.via ?? undefined, callee: e.callee ?? undefined })),
    coverage: completeCoverage(p.store),
  };
}

export function usages(p: Project, args: ToolArgs) {
  const target = args.target ?? args.symbol;
  if (!target) return { error: "usages requires `target`" };
  const edges = p.store.edgesTo(target, args.kinds);
  // Reverse call edges only exist for hydrated packages → report real coverage.
  const structuralOnly = args.kinds !== undefined && args.kinds.every((k) => !CALL_KINDS.has(k));
  return {
    edges: edges.map((e) => ({ ...ref(p.store, e.src), kind: e.kind, resolved: e.resolved, via: e.via ?? undefined })),
    coverage: structuralOnly ? completeCoverage(p.store) : hydratedCoverage(p.store),
  };
}

export function implementers(p: Project, args: ToolArgs) {
  const id = args.symbol ?? args.target;
  if (!id) return { error: "implementers requires `symbol`" };
  const hits = p.store.edgesTo(id, ["implements"]).map((e) => ref(p.store, e.src));
  return { hits, coverage: completeCoverage(p.store) };
}

export function subclasses(p: Project, args: ToolArgs) {
  const id = args.symbol ?? args.target;
  if (!id) return { error: "subclasses requires `symbol`" };
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  const walk = (root: string) => {
    for (const e of p.store.edgesTo(root, ["extends"])) {
      if (seen.has(e.src)) continue;
      seen.add(e.src);
      out.push(ref(p.store, e.src));
      if (args.transitive) walk(e.src);
    }
  };
  walk(id);
  return { hits: out, coverage: completeCoverage(p.store) };
}

export function entrypoints(p: Project, args: ToolArgs) {
  return { entrypoints: p.store.listEntrypoints(args.kind) };
}

export function call_paths(p: Project, args: ToolArgs) {
  if (!args.from || !args.to) return { error: "call_paths requires `from` and `to`" };
  // Forward traversal follows calls into the from-package's dependency closure.
  if (args.from.includes("|")) p.hydrateClosure(pkgOfId(args.from));
  const maxDepth = Math.min(args.maxDepth ?? 6, 12);
  // BFS over calls/contract edges, tracking the path.
  const queue: string[][] = [[args.from]];
  const visited = new Set<string>([args.from]);
  const paths: string[][] = [];
  let truncated = false;
  while (queue.length) {
    const path = queue.shift()!;
    const tip = path[path.length - 1];
    if (tip === args.to) {
      paths.push(path);
      if (paths.length >= 5) { truncated = true; break; }
      continue;
    }
    if (path.length > maxDepth) { truncated = true; continue; }
    for (const e of p.store.edgesFrom(tip, ["calls"])) {
      if (e.dst.startsWith("external:") || visited.has(e.dst)) continue;
      visited.add(e.dst);
      queue.push([...path, e.dst]);
    }
  }
  return {
    paths: paths.map((path) => path.map((id) => ref(p.store, id))),
    truncated,
    coverage: completeCoverage(p.store),
  };
}

/** Adapter role facets for a symbol. Built from the existing `fragmentsBySymbol`
 *  join, gated on which adapters
 *  are active for the project — a facet key appears only when its adapter is on
 *  AND the symbol actually plays that role. Compact: ids + a few orienting attrs.
 *  Returns `{}` for a plain symbol so the field's shape is stable. */
function symbolRoles(p: Project, id: string) {
  const active = new Set(p.adapters);
  const roles: {
    route?: Array<{ id: string; method?: string; path?: string }>;
    provider?: Array<{ id: string; token?: string; providerType?: string }>;
    dbAccess?: Array<{ id: string; model?: string; op?: string; rw?: string }>;
    model?: Array<{ id: string; name?: string }>;
  } = {};
  const a = (n: { attrs: Record<string, unknown> }) => n.attrs as Record<string, string | undefined>;

  if (active.has("nest")) {
    const routes = p.store.fragmentsBySymbol(id, "handler").filter((n) => n.adapter === "nest" && n.kind === "route");
    if (routes.length) roles.route = routes.map((n) => ({ id: n.id, method: a(n).method, path: a(n).path }));
    const provs = p.store.fragmentsBySymbol(id, "provides").filter((n) => n.adapter === "nest" && n.kind === "provider-binding");
    if (provs.length) roles.provider = provs.map((n) => ({ id: n.id, token: a(n).token, providerType: a(n).providerType }));
  }

  if (active.has("prisma")) {
    const acc = p.store.fragmentsBySymbol(id, "caller").filter((n) => n.adapter === "prisma" && n.kind === "access");
    if (acc.length) roles.dbAccess = acc.map((n) => ({ id: n.id, model: a(n).model, op: a(n).op, rw: a(n).rw }));
    const models = p.store.fragmentsBySymbol(id).filter((n) => n.adapter === "prisma" && n.kind === "model");
    if (models.length) roles.model = models.map((n) => ({ id: n.id, name: a(n).name }));
  }

  return roles;
}

export function explain_symbol(p: Project, args: ToolArgs) {
  const id = args.symbol ?? args.id;
  if (!id) return { error: "explain_symbol requires `symbol`" };
  if (id.includes("|")) p.hydrate(pkgOfId(id)); // so relation/usage call counts are populated
  const s = p.store.getSymbol(id);
  if (!s) return { error: `symbol not found: ${id}` };
  const TOP = 8;
  const out = p.store.edgesFrom(id);
  const inn = p.store.edgesTo(id);
  const summarize = (edges: EdgeRecord[], dir: "src" | "dst") => {
    const counts: Record<string, number> = {};
    for (const e of edges) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const top = edges.slice(0, TOP).map((e) => ({ ...ref(p.store, dir === "dst" ? e.dst : e.src), kind: e.kind, resolved: e.resolved }));
    return { counts, top };
  };
  return {
    detail: { id: s.id, kind: s.kind, name: s.name, package: s.package, signature: s.signature, doc: s.doc, loc: loc(s), decorators: s.extra.decorators?.map((d) => d.name) },
    relations: summarize(out, "dst"),
    usages: summarize(inn, "src"),
    roles: symbolRoles(p, id),
    coverage: hydratedCoverage(p.store),
  };
}

// ---- semantic search ------------------------

/** Coverage over the semantic index: which packages currently have chunks.
 *  The index is lazily (re)built per package on search — Tier-2 scoped. */
function searchCoverage(p: Project) {
  const total = p.store.counts().packages;
  const scanned = p.store.packagesWithChunks().length;
  const complete = scanned >= total;
  return { scanned, total, unit: "packages" as const, complete, ...(complete ? {} : { expand: "un-indexed packages are embedded on demand; widen with scope or a background job" }) };
}

/** Ensure the semantic index covers the given packages (hash-gated → cheap when
 *  unchanged). Keeps results fresh after edits without a separate build step. */
function ensureIndexed(p: Project, pkgs: string[]): void {
  for (const pk of pkgs) indexPackage(p.store, pk);
}

export function search(p: Project, args: ToolArgs) {
  if (!args.query) return { error: "search requires `query`" };
  const pkgs = args.package ? [args.package] : p.store.listPackages().map((x) => x.name);
  ensureIndexed(p, pkgs);
  const hits = semanticSearch(p.store, args.query, { kind: args.kind, package: args.package, limit: args.limit });
  return { hits, coverage: searchCoverage(p) };
}

export function search_similar(p: Project, args: ToolArgs) {
  const id = args.symbol ?? args.id;
  if (!id) return { error: "search_similar requires `symbol`" };
  ensureIndexed(p, p.store.listPackages().map((x) => x.name));
  const hits = semanticSimilar(p.store, id, args.limit ?? 10);
  if (!hits.length) return { hits, note: "no chunk anchored to that symbol (is it indexed / a chunkable symbol?)", coverage: searchCoverage(p) };
  return { hits, coverage: searchCoverage(p) };
}
