// Adapter contract + registry. Core defines the interface and a process-wide registry; the
// assembly point (the daemon) imports first-party adapters and registers them.
// Core never depends on a concrete adapter — the dependency points the other
// way (adapter → core), so a plain-TS project loads no framework code.
import type { Node, Project, SourceFile } from "ts-morph";
import type { Store } from "./store.ts";
import type { SymbolIndex } from "./build.ts";
import type { Workspace, WorkspacePackage } from "./workspace.ts";

/** Everything an adapter needs to read the parsed program + core base map and
 *  contribute fragment nodes for one detected package. */
export interface AdapterContext {
  projectRoot: string;
  workspace: Workspace;
  pkg: WorkspacePackage; // the package this build call targets
  project: Project; // the shared ts-morph program
  store: Store;
  index: SymbolIndex;
  /** SourceFile → its FileId ("pkg|relPath"), or undefined if outside the map. */
  fileIdOf(sf: SourceFile): string | undefined;
  /** AST node → the core SymbolId it was indexed as, if any. */
  symbolIdOf(node: Node): string | undefined;
  /** A name resolver bound to a file: local/import name → SymbolId | "external:…". */
  resolveName(sf: SourceFile): (name: string) => string | null;
  /** True if a SourceFile belongs to the package this build call targets. */
  inPackage(sf: SourceFile): boolean;
}

/** A tool an adapter registers. Reads the store (built at skeleton time); no
 *  checker at query time. `hydrate` lets a tool pull a package to Tier-2. */
export type AdapterTool = (store: Store, args: Record<string, unknown>, ctx?: { hydrate?: (pkg: string) => void }) => unknown;

export interface Adapter {
  name: string; // "nest"
  fingerprintGlobs: string[]; // files that invalidate this adapter's fragment
  detect(pkg: WorkspacePackage): boolean; // e.g. @nestjs/core in deps
  build(ctx: AdapterContext): void; // contribute fragment nodes for ctx.pkg
  tools: Record<string, AdapterTool>; // name → handler
  /** Optional per-tool sub-detection gate: tool name → a store meta key that
   *  must be truthy for the tool to appear in /manifest and be invokable. Lets a
   *  sub-adapter (e.g. Nest's GraphQL surface, gated on `@nestjs/graphql`) hide a
   *  tool in projects that don't use it, without a separate adapter. */
  gatedTools?: Record<string, string>;
}

const registry: Adapter[] = [];

export function registerAdapter(a: Adapter): void {
  if (!registry.some((r) => r.name === a.name)) registry.push(a);
}

export function registeredAdapters(): Adapter[] {
  return registry;
}
