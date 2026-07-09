export { Store } from "./store.ts";
export type { FindOpts, PackageRecord } from "./store.ts";
export { buildInto, buildSkeleton, hydratePackage, createProject, refresh, incrementalRefresh } from "./build.ts";
export type { BuildResult, SymbolIndex, IncrementalResult } from "./build.ts";
export { buildStructural, buildCalls, nameResolver } from "./graph.ts";
export { registerAdapter, registeredAdapters } from "./adapter.ts";
export type { Adapter, AdapterContext, AdapterTool } from "./adapter.ts";
export { detectWorkspace } from "./workspace.ts";
export type { Workspace, WorkspacePackage } from "./workspace.ts";
export { fingerprint, diff, auxFingerprint, diffCount } from "./fingerprint.ts";
export type { RefreshResult, FileDiff } from "./fingerprint.ts";
export { Timer, nowMs } from "./metrics.ts";
export type { Timing } from "./metrics.ts";
export { canonicalDump, canonicalJson, diffStores } from "./differential.ts";
export type { CanonicalDump } from "./differential.ts";
export {
  HashingEmbedder,
  defaultEmbedder,
  setDefaultEmbedder,
  chunkPackage,
  indexPackage,
  search,
  searchSimilar,
  cosine,
} from "./semantic.ts";
export type { Embedder, IndexResult, SearchHit } from "./semantic.ts";
export { OnnxEmbedder, loadOnnxEmbedder, warmDefaultEmbedder } from "./onnx.ts";
export type { OnnxEmbedderOptions } from "./onnx.ts";
export { fileId, symbolId, SEP } from "./ids.ts";
export type {
  SymbolRecord,
  FileRecord,
  SymbolKind,
  Span,
  SymbolExtra,
  DecoratorUse,
  Param,
  EdgeKind,
  EdgeRecord,
  Resolved,
  EntrypointRecord,
  FragmentNodeRecord,
  ChunkRecord,
} from "./types.ts";
