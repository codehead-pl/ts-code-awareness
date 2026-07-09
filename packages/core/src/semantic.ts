// Semantic search (docs/design/02-map-schema.md §8, tools §D). Symbol/
// fragment-anchored chunker + a *pluggable, local* embedder + a brute-force
// cosine index over vectors kept in the `chunks` sidecar. The default embedder
// is offline and dependency-free (token/camelCase hashing) so nothing leaves the
// machine and there is no native build; a real code-embedding model swaps in
// behind the Embedder interface. Incremental re-embed is hash-gated: a one-line
// edit re-embeds exactly the chunks whose text changed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { ChunkRecord, SymbolRecord } from "./types.ts";
import { nowMs } from "./metrics.ts";

// ---- embedder ------------------------------------------------------------

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(text: string): Float32Array;
}

/** Offline hashing embedder: tokens (incl. camelCase sub-tokens) + adjacent
 *  bigrams hashed into a fixed-dim, L2-normalized vector. Cheap, deterministic,
 *  no network — a sane default for lexical-semantic retrieval over enriched
 *  headers. Cosine == dot product on the normalized output. */
export class HashingEmbedder implements Embedder {
  readonly id = "hashing-v1";
  constructor(readonly dim = 256) {}

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const toks = tokenize(text);
    for (let i = 0; i < toks.length; i += 1) {
      this.add(v, toks[i], 1);
      if (i + 1 < toks.length) this.add(v, `${toks[i]} ${toks[i + 1]}`, 0.5);
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i += 1) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i += 1) v[i] /= norm;
    return v;
  }

  private add(v: Float32Array, feature: string, weight: number): void {
    const h = fnv1a(feature);
    const idx = h % this.dim;
    const sign = (h >>> 31) & 1 ? 1 : -1;
    v[idx] += weight * sign;
  }
}

let _shared: Embedder | null = null; // a warmed learned embedder, when installed
let _fallback: Embedder | null = null; // the zero-dependency hashing default
/** The embedder used when a caller doesn't pass one. Returns the learned
 *  embedder once `setDefaultEmbedder` has installed it (see `onnx.ts`
 *  `warmDefaultEmbedder`), otherwise the offline `HashingEmbedder`. */
export function defaultEmbedder(): Embedder {
  if (_shared) return _shared;
  if (!_fallback) _fallback = new HashingEmbedder();
  return _fallback;
}
/** Install (or clear) the process-wide shared embedder. The learned embedder is
 *  loaded once and shared across every warm project; passing `null` reverts to
 *  the hashing fallback. */
export function setDefaultEmbedder(e: Embedder | null): void {
  _shared = e;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const lw = raw.toLowerCase();
    if (lw.length >= 2) out.push(lw);
    // camelCase / PascalCase sub-tokens: findOne -> find, one
    const parts = raw.split(/(?=[A-Z])/);
    if (parts.length > 1) for (const p of parts) {
      const pl = p.toLowerCase();
      if (pl.length >= 2 && pl !== lw) out.push(pl);
    }
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
  return dot;
}

// ---- chunker -------------------------------------------------------------

interface ChunkDraft {
  id: string;
  anchor: string;
  level: ChunkRecord["level"];
  kind: ChunkRecord["kind"];
  package: string;
  file: string;
  span: ChunkRecord["span"];
  header: string;
  snippet: string;
  text: string;
  textHash: string;
}

const OWN_CHUNK = new Set(["method", "constructor", "function", "accessor", "variable", "type-alias", "enum"]);
const MAX_BODY = 1600;

const relOf = (fid: string): string => fid.slice(fid.indexOf("|") + 1);
const symbolPathOf = (id: string): string => id.split("|")[2] ?? id;

/** Derive (but do not embed) the chunk drafts for one package: class-outline +
 *  member chunks from symbols, and schema fragments from prisma models/enums. */
export function chunkPackage(store: Store, pkg: string): ChunkDraft[] {
  const pkgRoot = store.listPackages().find((p) => p.name === pkg)?.root ?? null;
  const fileLines = new Map<string, string[]>();
  const linesOf = (fid: string): string[] | null => {
    if (!pkgRoot) return null;
    let ls = fileLines.get(fid);
    if (ls) return ls;
    try {
      ls = readFileSync(join(pkgRoot, relOf(fid)), "utf8").split("\n");
      fileLines.set(fid, ls);
      return ls;
    } catch {
      return null;
    }
  };
  const bodyOf = (s: SymbolRecord): string => {
    const ls = linesOf(s.file);
    if (!ls || !s.span) return s.signature ?? "";
    return ls.slice(s.span.startLine - 1, s.span.endLine).join("\n");
  };

  const drafts: ChunkDraft[] = [];
  const symbols = store.symbolsByPackage(pkg);
  const membersOfContainer = new Map<string, SymbolRecord[]>();
  for (const s of symbols) if (s.container) getOrPush(membersOfContainer, s.container, s);

  for (const s of symbols) {
    if (s.kind === "class" || s.kind === "interface") {
      const members = membersOfContainer.get(s.id) ?? [];
      const outline = members.map((m) => `  - ${m.signature ?? m.name}`).join("\n");
      const header = headerFor(pkg, s);
      const text = `${header}\n${s.doc ?? ""}\nmembers:\n${outline}`;
      drafts.push(mkDraft(s.id, s.id, "class-outline", "code", pkg, s.file, s.span, header, s.signature ?? s.name, text));
    } else if (OWN_CHUNK.has(s.kind)) {
      // members (methods/accessors/ctor) and top-level fns/vars/types/enums
      const header = headerFor(pkg, s);
      const decos = s.extra.decorators?.map((d) => `@${d.name}`).join(" ") ?? "";
      const body = bodyOf(s);
      for (const part of splitBody(body)) {
        const id = part.n === 0 ? s.id : `${s.id}#part${part.n}`;
        const level: ChunkRecord["level"] = part.n === 0 ? "member" : "sub-chunk";
        const text = `${header}\n${decos}\n${s.doc ?? ""}\n${part.text}`;
        drafts.push(mkDraft(id, s.id, level, "code", pkg, s.file, s.span, header, s.signature ?? s.name, text));
      }
    }
  }

  // schema fragments (prisma models + enums) → schema chunks anchored to the node
  for (const kind of ["model", "enum"] as const) {
    for (const node of store.fragments("prisma", kind)) {
      if (fragPkg(node.provenance) !== pkg) continue;
      const header = `${pkg} · ${relOf(node.provenance[0] ?? "")} · ${kind} ${String(node.attrs.name)}`;
      const text = `${header}\n${schemaText(node.attrs)}`;
      drafts.push(mkDraft(node.id, node.id, "fragment", "schema", pkg, node.provenance[0] ?? "", node.span, header, `${kind} ${String(node.attrs.name)}`, text));
    }
  }

  return drafts;
}

function headerFor(pkg: string, s: SymbolRecord): string {
  return `${pkg} · ${relOf(s.file)} · ${symbolPathOf(s.id)}${s.signature && s.signature !== s.name ? ` — ${s.signature}` : ""}`;
}

function schemaText(attrs: Record<string, unknown>): string {
  const fields = (attrs.fields as Array<Record<string, unknown>> | undefined) ?? [];
  const rels = (attrs.relations as Array<Record<string, unknown>> | undefined) ?? [];
  const members = (attrs.members as string[] | undefined) ?? [];
  const parts: string[] = [];
  if (attrs.table) parts.push(`table ${String(attrs.table)}`);
  if (fields.length) parts.push(`fields: ${fields.map((f) => `${f.name}:${f.type}`).join(", ")}`);
  if (rels.length) parts.push(`relations: ${rels.map((r) => `${r.name}->${r.target}`).join(", ")}`);
  if (members.length) parts.push(`values: ${members.join(", ")}`);
  return parts.join("\n");
}

function splitBody(body: string): Array<{ n: number; text: string }> {
  if (body.length <= MAX_BODY) return [{ n: 0, text: body }];
  const parts: Array<{ n: number; text: string }> = [];
  for (let i = 0, n = 0; i < body.length; i += MAX_BODY, n += 1) parts.push({ n, text: body.slice(i, i + MAX_BODY) });
  return parts;
}

function mkDraft(
  id: string,
  anchor: string,
  level: ChunkRecord["level"],
  kind: ChunkRecord["kind"],
  pkg: string,
  file: string,
  span: ChunkRecord["span"],
  header: string,
  snippet: string,
  text: string,
): ChunkDraft {
  return { id, anchor, level, kind, package: pkg, file, span, header, snippet, text, textHash: sha(text) };
}

function fragPkg(provenance: string[]): string | null {
  const p = provenance[0];
  return p ? p.slice(0, p.indexOf("|")) : null;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function getOrPush<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

// ---- indexing (hash-gated incremental re-embed) --------------------------

export interface IndexResult {
  embedded: number;
  skipped: number;
  removed: number;
}

/** Gate hash stored per chunk. It folds the embedder identity into the text
 *  hash so re-embedding is triggered by *either* a text change (one-line edit →
 *  exactly that chunk) *or* a model change (different embedder id/dim → every
 *  chunk), reusing the existing hash-gated machinery for both. */
function gateHash(embedder: Embedder, textHash: string): string {
  return sha(`${embedder.id} ${embedder.dim} ${textHash}`);
}

/** (Re)build the semantic index for one package. Only chunks whose text changed
 *  — or whose embedding model changed — are re-embedded; chunks whose anchor
 *  vanished are dropped. The active embedder's id/dim are recorded in `meta`. */
export function indexPackage(store: Store, pkg: string, embedder: Embedder = defaultEmbedder()): IndexResult {
  const t0 = nowMs();
  const drafts = chunkPackage(store, pkg);
  const existing = store.chunkHashes(pkg);
  const seen = new Set<string>();
  let embedded = 0;
  let skipped = 0;
  for (const d of drafts) {
    seen.add(d.id);
    const gate = gateHash(embedder, d.textHash);
    if (existing.get(d.id) === gate) {
      skipped += 1;
      continue;
    }
    store.upsertChunk({
      id: d.id,
      anchor: d.anchor,
      level: d.level,
      kind: d.kind,
      package: d.package,
      file: d.file,
      span: d.span,
      header: d.header,
      snippet: d.snippet,
      textHash: gate,
      vec: embedder.embed(d.text),
    });
    embedded += 1;
  }
  let removed = 0;
  for (const id of existing.keys()) if (!seen.has(id)) {
    store.deleteChunk(id);
    removed += 1;
  }
  if (embedded > 0) {
    store.setMeta("embedderId", embedder.id);
    store.setMeta("embedderDim", String(embedder.dim));
  }
  store.recordMetric("indexPackage", pkg, Math.round((nowMs() - t0) * 1000) / 1000);
  return { embedded, skipped, removed };
}

// ---- search --------------------------------------------------------------

export interface SearchHit {
  anchor: string;
  level: ChunkRecord["level"];
  kind: ChunkRecord["kind"];
  score: number;
  package: string;
  file: string;
  span: ChunkRecord["span"];
  snippet: string;
}

export function search(
  store: Store,
  query: string,
  opts: { kind?: string; package?: string; limit?: number } = {},
  embedder: Embedder = defaultEmbedder(),
): SearchHit[] {
  const q = embedder.embed(query);
  const limit = opts.limit ?? 10;
  const scored = store
    .searchChunks({ kind: opts.kind, package: opts.package })
    .map((c) => ({ c, score: cosine(q, c.vec) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return dedupeByAnchor(scored, limit);
}

export function searchSimilar(store: Store, symbolOrChunkId: string, limit = 10): SearchHit[] {
  const target = store.chunkById(symbolOrChunkId) ?? store.searchChunks({}).find((c) => c.anchor === symbolOrChunkId) ?? null;
  if (!target) return [];
  const scored = store
    .searchChunks({})
    .filter((c) => c.anchor !== target.anchor)
    .map((c) => ({ c, score: cosine(target.vec, c.vec) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return dedupeByAnchor(scored, limit);
}

/** Collapse a symbol's sub-chunks / outline+member to one hit per anchor. */
function dedupeByAnchor(scored: Array<{ c: ChunkRecord; score: number }>, limit: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const { c, score } of scored) {
    if (seen.has(c.anchor)) continue;
    seen.add(c.anchor);
    out.push({ anchor: c.anchor, level: c.level, kind: c.kind, score: round(score), package: c.package, file: c.file, span: c.span, snippet: c.snippet });
    if (out.length >= limit) break;
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
