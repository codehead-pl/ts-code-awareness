// Base-map records.

export type SymbolKind =
  | "class"
  | "interface"
  | "function"
  | "method"
  | "constructor"
  | "property"
  | "accessor"
  | "enum"
  | "enum-member"
  | "type-alias"
  | "variable"
  | "module";

export interface Span {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface FileRecord {
  id: string; // pkg|relPath
  package: string;
  path: string; // rel to package root, POSIX
  hash: string; // sha-256 of contents
  module: "esm" | "cjs";
}

/** Raw, uninterpreted decorator info — adapters read these. */
export interface DecoratorUse {
  name: string;
  from: string | null; // resolved import module specifier, e.g. "@nestjs/common"
  args: string[]; // rendered argument source text
}

export interface Param {
  name: string;
  type: string | null;
  optional: boolean;
  decorators: DecoratorUse[];
}

export interface SymbolExtra {
  visibility?: "public" | "protected" | "private";
  decorators?: DecoratorUse[];
  params?: Param[];
  returns?: string | null;
  typeText?: string | null;
  flags?: {
    async?: boolean;
    static?: boolean;
    abstract?: boolean;
    readonly?: boolean;
  };
  // Rendered heritage text, retained to drive extends/implements resolution.
  heritage?: { extends?: string[]; implements?: string[] };
}

export interface SymbolRecord {
  id: string; // pkg|relPath|symbolPath
  file: string; // FileRecord.id
  package: string;
  container: string | null; // parent SymbolId
  kind: SymbolKind;
  name: string;
  exported: boolean;
  signature: string | null;
  doc: string | null;
  span: Span;
  tier: number; // 1 = skeleton, 2 = full.
  extra: SymbolExtra;
}

export type EdgeKind =
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "overrides"
  | "references"
  | "instantiates";
// No `decorated-by` edge kind: decorator usage is already fully captured on the
// symbol header (`SymbolExtra.decorators`, raw + resolved import source) and in
// the adapter fragment layer, so a graph edge would add no query power.

export type Resolved = "exact" | "contract" | "unresolved";

export interface EdgeRecord {
  src: string; // SymbolId or FileId
  dst: string; // SymbolId, FileId, or "external:<specifier>"
  kind: EdgeKind;
  resolved: Resolved;
  via: string | null; // call/import site "relPath:line"
  callee: string | null; // textual callee name (unresolved calls only)
}

export interface EntrypointRecord {
  id: string;
  kind:
    | "bin"
    | "package-main"
    | "nest-bootstrap"
    | "route-handler"
    | "graphql-resolver"
    | "queue-consumer"
    | "event-handler"
    | "cli-command";
  source: string; // "core" or an adapter name
  symbol: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * Semantic-search chunk. A retrieval unit
 * anchored to an addressable node (symbol or fragment) so `search → anchor →
 * structural expand` is clean. The embedding vector lives in the sidecar.
 */
export interface ChunkRecord {
  id: string; // "<symbolId>" | "<symbolId>#partN" | "<fragmentNodeId>"
  anchor: string; // symbol id or fragment node id
  level: "class-outline" | "member" | "sub-chunk" | "fragment" | "doc";
  kind: "code" | "schema" | "doc";
  package: string;
  file: string; // FileId (or synthetic id for non-TS anchors)
  span: Span | null;
  header: string; // enrichment header embedded as context
  snippet: string; // short human-facing preview
  textHash: string; // gates incremental re-embed
  vec: Float32Array;
}

/**
 * Adapter fragment node. Uniform shape across
 * all adapters: an id-addressable node with adapter-specific `attrs`, a
 * role→symbol(s) `refs` join map into the core base map, and file provenance.
 */
export interface FragmentNodeRecord {
  id: string; // namespaced, e.g. "nest:route:GET /users/:id"
  adapter: string; // "nest"
  kind: string; // adapter-defined: "route" | "module" | "provider-binding" | ...
  attrs: Record<string, unknown>;
  refs: Record<string, string | string[]>; // role → core SymbolId(s)
  span: Span | null;
  provenance: string[]; // SourceFile.ids this node derived from
}
