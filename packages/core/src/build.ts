// Base-map builder, tiered.
//   buildSkeleton   — Tier-1 for all packages: symbols + structural edges.
//   hydratePackage  — Tier-2 for one package: its call graph (re-parses the
//                     package's dependency closure so calls into deps resolve).
//   buildInto       — eager full build (skeleton + hydrate all); used by tests.
import {
  Project,
  Scope,
  ts,
  type SourceFile,
  type ClassDeclaration,
  type MethodDeclaration,
  type MethodSignature,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type PropertyDeclaration,
  type PropertySignature,
  type VariableDeclaration,
  type ParameterDeclaration,
  type Node,
} from "ts-morph";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, relative, join, sep, resolve } from "node:path";
import type { Store } from "./store.ts";
import type { DecoratorUse, Param, Span, SymbolExtra, SymbolKind } from "./types.ts";
import { fileId, symbolId } from "./ids.ts";
import { buildStructural, buildCalls, nameResolver } from "./graph.ts";
import { detectWorkspace, type Workspace, type WorkspacePackage } from "./workspace.ts";
import { registeredAdapters, type AdapterContext } from "./adapter.ts";
import { Timer, nowMs } from "./metrics.ts";
import { fingerprint, auxFingerprint, diff, type RefreshResult } from "./fingerprint.ts";
import { indexPackage, defaultEmbedder, type Embedder } from "./semantic.ts";

const pkgOf = (fid: string): string => fid.slice(0, fid.indexOf("|"));

export interface BuildResult {
  files: number;
  symbols: number;
  edges: number;
  entrypoints: number;
  /** Wall-independent (monotonic) build duration in milliseconds. */
  ms: number;
}

export interface SymbolIndex {
  byNode: Map<Node, string>;
  exportsByPackage: Map<string, Map<string, string>>;
  localByFile: Map<string, Map<string, string>>;
  membersByOwner: Map<string, Map<string, string>>;
  importsByFile: Map<string, Map<string, string>>;
  fileByAbs: Map<string, string>;
  info: Map<string, { kind: SymbolKind; abstract: boolean; file: string; package: string }>;
}

function emptyIndex(): SymbolIndex {
  return {
    byNode: new Map(),
    exportsByPackage: new Map(),
    localByFile: new Map(),
    membersByOwner: new Map(),
    importsByFile: new Map(),
    fileByAbs: new Map(),
    info: new Map(),
  };
}

function packageInfo(fileDir: string, projectRoot: string): { name: string; root: string } {
  let dir = fileDir;
  while (dir.startsWith(projectRoot)) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const json = JSON.parse(readFileSync(pj, "utf8")) as { name?: string };
        if (json.name) return { name: json.name, root: dir };
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { name: ".", root: projectRoot };
}

export function createProject(projectRoot: string, ws?: Workspace, roots?: string[]): Project {
  const compilerOptions: ts.CompilerOptions = { allowJs: false };
  if (ws?.tsPaths) {
    compilerOptions.baseUrl = ws.tsPaths.baseUrl;
    compilerOptions.paths = ws.tsPaths.paths;
  }
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions,
  });
  const scan = roots && roots.length ? roots : [projectRoot];
  for (const base of scan) {
    project.addSourceFilesAtPaths([
      `${base}/**/*.ts`,
      `!${base}/**/node_modules/**`,
      `!${base}/**/dist/**`,
      `!${base}/**/*.d.ts`,
    ]);
  }
  return project;
}

function persistPackages(store: Store, ws: Workspace): void {
  for (const p of ws.packages) {
    store.upsertPackage({ name: p.name, root: p.root, tsconfig: p.tsconfig, workspaceDeps: p.workspaceDeps });
  }
}

/** Pass 1: index files + symbols. `shouldWrite(pkg)` gates store writes so a
 *  hydration can index a dep's sources without overwriting its rows. */
function runPass1(
  project: Project,
  store: Store,
  index: SymbolIndex,
  projectRoot: string,
  shouldWrite: (pkg: string, fid: string) => boolean,
): void {
  const pkgCache = new Map<string, { name: string; root: string }>();
  for (const sf of project.getSourceFiles()) {
    const abs = sf.getFilePath();
    const dir = dirname(abs);
    let pkg = pkgCache.get(dir);
    if (!pkg) {
      pkg = packageInfo(dir, projectRoot);
      pkgCache.set(dir, pkg);
    }
    const relPath = relative(pkg.root, abs).split(sep).join("/");
    const fid = fileId(pkg.name, relPath);
    index.fileByAbs.set(abs, fid);
    const write = shouldWrite(pkg.name, fid);
    if (write) {
      const hash = createHash("sha256").update(sf.getFullText()).digest("hex");
      store.upsertFile({ id: fid, package: pkg.name, path: relPath, hash, module: "esm" });
    }
    indexFile(sf, store, index, pkg.name, relPath, fid, write);
  }
}

/** Transitive workspace dependency closure of a package (incl. itself). */
function closureOf(ws: Workspace, pkg: string): Set<string> {
  const byName = new Map(ws.packages.map((p) => [p.name, p]));
  const out = new Set<string>();
  const stack = [pkg];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    for (const d of byName.get(n)?.workspaceDeps ?? []) stack.push(d);
  }
  return out;
}

export function buildSkeleton(store: Store, projectRootInput: string): BuildResult {
  const projectRoot = resolve(projectRootInput);
  const ws = detectWorkspace(projectRoot);
  const project = createProject(projectRoot, ws);
  const index = emptyIndex();

  const activeAdapters = new Set<string>();
  const timer = new Timer();
  const t0 = nowMs();
  store.reset();
  store.transaction(() => {
    persistPackages(store, ws);
    timer.time("buildSkeleton.pass1", ".", () => runPass1(project, store, index, projectRoot, () => true));
    timer.time("buildSkeleton.structural", ".", () => buildStructural(project, store, index, { writeEdges: true }));
    runAdapters(project, store, index, ws, projectRoot, activeAdapters, timer);
  });
  const ms = Math.round((nowMs() - t0) * 1000) / 1000;

  store.setMeta("builtAt", new Date().toISOString());
  store.setMeta("projectRoot", projectRoot);
  store.setMeta("schemaVersion", "0");
  store.setMeta("workspaceTool", ws.tool);
  store.setMeta("hydrated", "[]");
  store.setMeta("adapters", JSON.stringify([...activeAdapters]));
  // Baseline the adapter (non-`.ts`) fingerprint so a later incrementalRefresh
  // only re-runs adapters when their `.prisma`/migration inputs actually change.
  store.setMeta("auxHashes", stringifyMap(auxFingerprint(ws)));
  // Persist timings (after reset(), which cleared the last build's samples).
  timer.add("buildSkeleton", ".", ms);
  for (const m of timer.timings()) store.recordMetric(m.op, m.package, m.ms);
  const c = store.counts();
  return { files: c.files, symbols: c.symbols, edges: c.edges, entrypoints: c.entrypoints, ms };
}

/** Run every registered adapter over each package it detects, contributing
 *  fragment nodes at skeleton time. Nest's structural views (routes, DI,
 *  modules) read only decorators/heritage — already captured by pass 1 — so
 *  they build cheaply here and need no Tier-2 hydration to be queried. */
function makeAdapterContext(
  project: Project,
  store: Store,
  index: SymbolIndex,
  ws: Workspace,
  projectRoot: string,
  pkg: WorkspacePackage,
): AdapterContext {
  const fidOf = (sf: SourceFile) => index.fileByAbs.get(sf.getFilePath());
  return {
    projectRoot,
    workspace: ws,
    pkg,
    project,
    store,
    index,
    fileIdOf: fidOf,
    symbolIdOf: (node) => index.byNode.get(node),
    resolveName: (sf) => {
      const fid = fidOf(sf);
      return fid ? nameResolver(sf, index, fid) : () => null;
    },
    inPackage: (sf) => {
      const fid = fidOf(sf);
      return !!fid && pkgOf(fid) === pkg.name;
    },
  };
}

function runAdapters(
  project: Project,
  store: Store,
  index: SymbolIndex,
  ws: Workspace,
  projectRoot: string,
  active: Set<string>,
  timer: Timer,
): void {
  const adapters = registeredAdapters();
  if (!adapters.length) return;
  for (const pkg of ws.packages) {
    for (const adapter of adapters) {
      if (!adapter.detect(pkg, ws)) continue;
      active.add(adapter.name);
      const ctx = makeAdapterContext(project, store, index, ws, projectRoot, pkg);
      timer.time(`adapter:${adapter.name}`, pkg.name, () => adapter.build(ctx));
    }
  }
}

/** Build the Tier-2 call graph for one package (no-op if already hydrated). */
export function hydratePackage(store: Store, projectRootInput: string, pkg: string): boolean {
  if (store.isHydrated(pkg)) return false;
  const projectRoot = resolve(projectRootInput);
  const ws = detectWorkspace(projectRoot);
  const closure = closureOf(ws, pkg);
  const roots = ws.packages.filter((p) => closure.has(p.name)).map((p) => p.root);
  const project = createProject(projectRoot, ws, roots.length ? roots : undefined);
  const index = emptyIndex();

  const t0 = nowMs();
  store.transaction(() => {
    runPass1(project, store, index, projectRoot, (p) => p === pkg); // write only target pkg
    const heritageIds = buildStructural(project, store, index, { writeEdges: false });
    buildCalls(project, store, index, heritageIds, { onlyPackage: pkg });
    store.markHydrated(pkg);
  });
  store.recordMetric("hydratePackage", pkg, Math.round((nowMs() - t0) * 1000) / 1000);
  return true;
}

/** Eager full build: skeleton + hydrate every package. */
export function buildInto(store: Store, projectRootInput: string): BuildResult {
  const projectRoot = resolve(projectRootInput);
  const t0 = nowMs();
  buildSkeleton(store, projectRoot);
  for (const p of store.listPackages()) hydratePackage(store, projectRoot, p.name);
  const ms = Math.round((nowMs() - t0) * 1000) / 1000;
  const c = store.counts();
  return { files: c.files, symbols: c.symbols, edges: c.edges, entrypoints: c.entrypoints, ms };
}

// ---- incremental invalidation -------
//
// A dirty-set rebuild that is provably identical to a from-scratch build (the
// contract validated by test:diff). Resolution parity with the full build is
// guaranteed by parsing the whole workspace and reusing the exact same
// buildStructural/buildCalls passes — only the *persisted* rows are scoped to
// the dirty set, so unchanged files keep their rows (and provenance), the
// wired-up deleteFileRows drives per-file teardown, and the semantic sidecar
// re-embeds only what changed.

export interface IncrementalResult {
  mode: "full" | "incremental" | "noop";
  added: string[];
  changed: string[];
  deleted: string[];
  /** File-ids torn down + rewritten (dirty set, post reverse-dep expansion). */
  rebuilt: string[];
  /** Packages whose adapter fragments were re-derived. */
  adaptersFor: string[];
  /** Per-package semantic re-embed stats (only when `reindex` requested). */
  reindexed: Array<{ package: string; embedded: number; skipped: number; removed: number }>;
  ms: number;
}

/** Packages that (transitively) depend on any package in `seeds`, via the
 *  workspace dependency DAG — the reverse-import/DAG closure whose edge
 *  resolution can shift when a seed package's public surface changes. */
function dependentsOf(ws: Workspace, seeds: Set<string>): Set<string> {
  if (!seeds.size) return new Set();
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of ws.packages) {
      if (out.has(p.name)) continue;
      if (p.workspaceDeps.some((d) => seeds.has(d) || out.has(d))) {
        out.add(p.name);
        changed = true;
      }
    }
  }
  return out;
}

function symbolIdsByFile(index: SymbolIndex): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [id, info] of index.info) getOrInit(out, info.file, () => new Set<string>()).add(id);
  return out;
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1; // `**/` also matches zero segments
      } else re += "[^/]*";
    } else if (".+^${}()|[]\\".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(relPath: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

/** Incremental refresh: fingerprint-diff the tree and rebuild only the dirty
 *  set. Falls back to a full skeleton build on the cold path (empty/relocated
 *  map). Optionally re-embeds the semantic sidecar for touched packages. */
export function incrementalRefresh(
  store: Store,
  projectRootInput: string,
  opts: { reindex?: boolean; embedder?: Embedder } = {},
): IncrementalResult {
  const projectRoot = resolve(projectRootInput);
  const empty = (mode: IncrementalResult["mode"], ms: number): IncrementalResult => ({
    mode,
    added: [],
    changed: [],
    deleted: [],
    rebuilt: [],
    adaptersFor: [],
    reindexed: [],
    ms,
  });

  const prev = store.fileHashes();
  const fresh = prev.size > 0 && store.getMeta("projectRoot") === projectRoot;
  if (!fresh) {
    const r = buildSkeleton(store, projectRoot); // sets auxHashes baseline
    return empty("full", r.ms);
  }

  const ws = detectWorkspace(projectRoot);
  const cur = fingerprint(projectRoot);
  const { added, changed, deleted } = diff(prev, cur);

  const auxCur = auxFingerprint(ws);
  const auxD = diff(parseMap(store.getMeta("auxHashes")), auxCur);
  const auxChanged = new Set([...auxD.added, ...auxD.changed, ...auxD.deleted]);

  if (!added.size && !changed.size && !deleted.size && !auxChanged.size) {
    return empty("noop", 0);
  }

  const t0 = nowMs();
  const project = createProject(projectRoot, ws);
  const index = emptyIndex();
  runPass1(project, store, index, projectRoot, () => false); // index all; write none

  // Structural change = a file's symbol-id set changed (add/remove/rename), or a
  // file appeared/vanished — these can shift edges in *other* files.
  const newIds = symbolIdsByFile(index);
  const structuralPkgs = new Set<string>();
  for (const fid of changed) {
    if (!setEq(store.symbolIdsInFile(fid), newIds.get(fid) ?? new Set())) structuralPkgs.add(pkgOf(fid));
  }
  for (const fid of added) structuralPkgs.add(pkgOf(fid));
  for (const fid of deleted) structuralPkgs.add(pkgOf(fid));

  // Reverse-dep closure: every file of a structurally-changed package and of its
  // dependents may need its edges recomputed.
  const affectedPkgs = new Set(structuralPkgs);
  for (const p of dependentsOf(ws, structuralPkgs)) affectedPkgs.add(p);

  const rebuild = new Set<string>([...added, ...changed]);
  if (affectedPkgs.size) {
    for (const fid of index.fileByAbs.values()) if (affectedPkgs.has(pkgOf(fid))) rebuild.add(fid);
  }

  const hydrated = new Set(store.hydratedPackages());
  const adaptersFor = new Set<string>();

  store.transaction(() => {
    for (const fid of deleted) store.deleteFileRows(fid);
    for (const fid of rebuild) store.deleteFileRows(fid);

    runPass1(project, store, index, projectRoot, (_p, fid) => rebuild.has(fid));
    const heritageIds = buildStructural(project, store, index, { writeEdges: true, onlyFiles: rebuild });
    const callFiles = new Set([...rebuild].filter((fid) => hydrated.has(pkgOf(fid))));
    if (callFiles.size) buildCalls(project, store, index, heritageIds, { onlyFiles: callFiles });
    store.retierHydrated();

    // Per-fragment (adapter) invalidation. Re-run an adapter over a package when
    // that package was re-swept (symbol ids may have shifted under its fragments)
    // or when a changed source matches the adapter's fingerprintGlobs.
    const changedByPkg = new Map<string, string[]>();
    const noteRel = (fid: string) => getOrInit(changedByPkg, pkgOf(fid), () => []).push(fid.slice(fid.indexOf("|") + 1));
    for (const fid of [...added, ...changed, ...deleted]) noteRel(fid);
    for (const fid of auxChanged) noteRel(fid);

    // A package's adapter fragments can also depend on aux inputs (schema /
    // migrations) owned by a package in its dependency closure — e.g. Prisma's
    // consumer packages read the schema-owner's schema.prisma. So a dep's aux
    // change must also re-run the dependent's adapter.
    const auxRelsByPkg = new Map<string, string[]>();
    for (const fid of auxChanged) getOrInit(auxRelsByPkg, pkgOf(fid), () => []).push(fid.slice(fid.indexOf("|") + 1));

    for (const pkg of ws.packages) {
      for (const adapter of registeredAdapters()) {
        if (!adapter.detect(pkg, ws)) continue;
        const rels = [...(changedByPkg.get(pkg.name) ?? [])];
        for (const dep of closureOf(ws, pkg.name)) if (dep !== pkg.name) rels.push(...(auxRelsByPkg.get(dep) ?? []));
        const run = affectedPkgs.has(pkg.name) || rels.some((rel) => matchesAny(rel, adapter.fingerprintGlobs));
        if (!run) continue;
        store.deleteFragmentsForPackage(adapter.name, pkg.name);
        adapter.build(makeAdapterContext(project, store, index, ws, projectRoot, pkg));
        adaptersFor.add(pkg.name);
      }
    }
  });

  store.setMeta("auxHashes", stringifyMap(auxCur));
  store.setMeta("builtAt", new Date().toISOString());

  // Semantic reindex-on-rebuild (hash-gated): re-derive + re-embed only the
  // packages whose sources or schema changed. Unchanged packages aren't touched.
  const reindexed: IncrementalResult["reindexed"] = [];
  if (opts.reindex) {
    const embedder = opts.embedder ?? defaultEmbedder();
    const reindexPkgs = new Set<string>();
    for (const fid of [...added, ...changed, ...deleted, ...rebuild]) reindexPkgs.add(pkgOf(fid));
    for (const fid of auxChanged) reindexPkgs.add(pkgOf(fid));
    for (const pkg of reindexPkgs) {
      const r = indexPackage(store, pkg, embedder);
      reindexed.push({ package: pkg, ...r });
    }
  }

  const ms = Math.round((nowMs() - t0) * 1000) / 1000;
  store.recordMetric("incrementalRefresh", ".", ms);
  return {
    mode: "incremental",
    added: [...added],
    changed: [...changed],
    deleted: [...deleted],
    rebuilt: [...rebuild],
    adaptersFor: [...adaptersFor],
    reindexed,
    ms,
  };
}

/** Build if stale (or empty); otherwise a no-op. Back-compat wrapper over
 *  incrementalRefresh for the daemon + the incremental smoke test. */
export function refresh(store: Store, projectRootInput: string): RefreshResult {
  const r = incrementalRefresh(store, projectRootInput);
  const changed = r.mode === "full" ? store.counts().files : r.added.length + r.changed.length + r.deleted.length;
  return { rebuilt: r.mode !== "noop", changed };
}

function stringifyMap(m: Map<string, string>): string {
  return JSON.stringify([...m.entries()].sort());
}

function parseMap(json: string | null): Map<string, string> {
  if (!json) return new Map();
  try {
    return new Map(JSON.parse(json) as Array<[string, string]>);
  } catch {
    return new Map();
  }
}

// ---- pass 1 symbol extraction (enriched) --------------------------------

function importMapOf(sf: SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of sf.getImportDeclarations()) {
    const mod = imp.getModuleSpecifierValue();
    for (const ni of imp.getNamedImports()) map.set(ni.getAliasNode()?.getText() ?? ni.getName(), mod);
    const def = imp.getDefaultImport();
    if (def) map.set(def.getText(), mod);
    const ns = imp.getNamespaceImport();
    if (ns) map.set(ns.getText(), mod);
  }
  return map;
}

function indexFile(
  sf: SourceFile,
  store: Store,
  index: SymbolIndex,
  pkg: string,
  relPath: string,
  fid: string,
  write: boolean,
): void {
  const imports = importMapOf(sf);
  index.importsByFile.set(fid, imports);
  const local = getOrInit(index.localByFile, fid, () => new Map<string, string>());
  const exports = getOrInit(index.exportsByPackage, pkg, () => new Map<string, string>());
  const used = new Set<string>();

  const register = (
    symbolPathRaw: string,
    kind: SymbolKind,
    name: string,
    exported: boolean,
    node: Node,
    signature: string | null,
    doc: string | null,
    container: string | null,
    extra: SymbolExtra,
  ): string => {
    let symbolPath = symbolPathRaw;
    if (used.has(symbolPath)) {
      let i = 1;
      while (used.has(`${symbolPathRaw}#${i}`)) i += 1;
      symbolPath = `${symbolPathRaw}#${i}`;
    }
    used.add(symbolPath);
    const id = symbolId(pkg, relPath, symbolPath);
    if (write) {
      store.upsertSymbol({ id, file: fid, package: pkg, container, kind, name, exported, tier: 1, signature, doc, span: spanOf(node), extra });
    }
    index.byNode.set(node, id);
    index.info.set(id, { kind, abstract: extra.flags?.abstract ?? false, file: fid, package: pkg });
    if (container === null) {
      local.set(name, id);
      if (exported) exports.set(name, id);
    }
    return id;
  };

  for (const cls of sf.getClasses()) {
    const name = cls.getName() ?? "default";
    const exported = cls.isExported();
    const heritage = { extends: cls.getExtends() ? [cls.getExtends()!.getText()] : [], implements: cls.getImplements().map((i) => i.getText()) };
    const cid = register(name, "class", name, exported, cls, classSignature(cls), jsdoc(cls), null, { decorators: decoratorsOf(cls, imports), flags: { abstract: cls.isAbstract() }, heritage });
    const members = getOrInit(index.membersByOwner, cid, () => new Map<string, string>());
    for (const m of cls.getConstructors()) members.set("constructor", register(`${name}.constructor`, "constructor", "constructor", exported, m, sigOf(m), jsdoc(m), cid, { params: paramsOf(m, imports) }));
    for (const m of cls.getMethods())
      members.set(m.getName(), register(`${name}.${m.getName()}`, "method", m.getName(), exported, m, sigOf(m), jsdoc(m), cid, { visibility: scopeOf(m), params: paramsOf(m, imports), returns: m.getReturnTypeNode()?.getText() ?? null, flags: { async: m.isAsync(), static: m.isStatic(), abstract: m.isAbstract() }, decorators: decoratorsOf(m, imports) }));
    for (const p of cls.getProperties())
      members.set(p.getName(), register(`${name}.${p.getName()}`, "property", p.getName(), exported, p, propSig(p), jsdoc(p), cid, { visibility: scopeOf(p), typeText: p.getTypeNode()?.getText() ?? null, flags: { static: p.isStatic(), readonly: p.isReadonly() }, decorators: decoratorsOf(p, imports) }));
    for (const a of cls.getGetAccessors()) members.set(a.getName(), register(`${name}.${a.getName()}`, "accessor", a.getName(), exported, a, null, jsdoc(a), cid, {}));
  }

  for (const iface of sf.getInterfaces()) {
    const name = iface.getName();
    const exported = iface.isExported();
    const cid = register(name, "interface", name, exported, iface, `interface ${name}`, jsdoc(iface), null, { heritage: { extends: iface.getExtends().map((e) => e.getText()), implements: [] } });
    const members = getOrInit(index.membersByOwner, cid, () => new Map<string, string>());
    for (const m of iface.getMethods()) members.set(m.getName(), register(`${name}.${m.getName()}`, "method", m.getName(), exported, m, sigOf(m), jsdoc(m), cid, { params: paramsOf(m, imports), returns: m.getReturnTypeNode()?.getText() ?? null }));
    for (const p of iface.getProperties()) members.set(p.getName(), register(`${name}.${p.getName()}`, "property", p.getName(), exported, p, propSig(p), jsdoc(p), cid, { typeText: p.getTypeNode()?.getText() ?? null }));
  }

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    register(name, "function", name, fn.isExported(), fn, sigOf(fn), jsdoc(fn), null, { params: paramsOf(fn, imports), returns: fn.getReturnTypeNode()?.getText() ?? null, flags: { async: fn.isAsync() } });
  }

  for (const en of sf.getEnums()) {
    const name = en.getName();
    const exported = en.isExported();
    const cid = register(name, "enum", name, exported, en, `enum ${name}`, jsdoc(en), null, {});
    const members = getOrInit(index.membersByOwner, cid, () => new Map<string, string>());
    for (const mem of en.getMembers()) members.set(mem.getName(), register(`${name}.${mem.getName()}`, "enum-member", mem.getName(), exported, mem, null, null, cid, {}));
  }

  for (const ta of sf.getTypeAliases()) register(ta.getName(), "type-alias", ta.getName(), ta.isExported(), ta, `type ${ta.getName()}`, jsdoc(ta), null, {});

  for (const vs of sf.getVariableStatements()) {
    const exported = vs.isExported();
    for (const d of vs.getDeclarations()) register(d.getName(), "variable", d.getName(), exported, d, varSig(d), jsdoc(vs), null, { typeText: d.getTypeNode()?.getText() ?? null });
  }
}

// ---- extractors ---------------------------------------------------------

function decoratorsOf(node: { getDecorators?: () => Array<{ getName(): string; getArguments(): Node[] }> }, imports: Map<string, string>): DecoratorUse[] {
  return (node.getDecorators?.() ?? []).map((d) => ({ name: d.getName(), from: imports.get(d.getName()) ?? null, args: d.getArguments().map((a) => a.getText()) }));
}

function paramsOf(m: { getParameters(): ParameterDeclaration[] }, imports: Map<string, string>): Param[] {
  return m.getParameters().map((p) => ({ name: p.getName(), type: p.getTypeNode()?.getText() ?? null, optional: p.hasQuestionToken(), decorators: decoratorsOf(p, imports) }));
}

function scopeOf(m: { getScope?: () => Scope }): "public" | "protected" | "private" | undefined {
  const s = m.getScope?.();
  if (s === Scope.Private) return "private";
  if (s === Scope.Protected) return "protected";
  return "public";
}

function spanOf(node: Node): Span {
  const sf = node.getSourceFile();
  const start = sf.getLineAndColumnAtPos(node.getStart());
  const end = sf.getLineAndColumnAtPos(node.getEnd());
  return { startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column };
}

function jsdoc(node: { getJsDocs?: () => Array<{ getDescription(): string }> }): string | null {
  const docs = node.getJsDocs?.() ?? [];
  if (!docs.length) return null;
  const t = docs[docs.length - 1].getDescription().trim();
  return t || null;
}

function sigOf(m: MethodDeclaration | MethodSignature | ConstructorDeclaration | FunctionDeclaration): string {
  const name = "getName" in m ? ((m as { getName?: () => string }).getName?.() ?? "") : "";
  const params = m.getParameters().map((p) => { const tn = p.getTypeNode(); return `${p.getName()}${p.hasQuestionToken() ? "?" : ""}${tn ? `: ${tn.getText()}` : ""}`; }).join(", ");
  const rt = m.getReturnTypeNode();
  return `${name}(${params})${rt ? `: ${rt.getText()}` : ""}`;
}

function propSig(p: PropertyDeclaration | PropertySignature): string {
  const tn = p.getTypeNode();
  return `${p.getName()}${p.hasQuestionToken() ? "?" : ""}${tn ? `: ${tn.getText()}` : ""}`;
}

function varSig(d: VariableDeclaration): string {
  const tn = d.getTypeNode();
  return `${d.getName()}${tn ? `: ${tn.getText()}` : ""}`;
}

function classSignature(cls: ClassDeclaration): string {
  const name = cls.getName() ?? "default";
  const ext = cls.getExtends()?.getText();
  const impls = cls.getImplements().map((i) => i.getText());
  let s = `${cls.isAbstract() ? "abstract " : ""}class ${name}`;
  if (ext) s += ` extends ${ext}`;
  if (impls.length) s += ` implements ${impls.join(", ")}`;
  return s;
}

function getOrInit<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}
