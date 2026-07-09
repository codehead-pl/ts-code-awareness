#!/usr/bin/env -S npx tsx
// Stdio MCP shim. Claude Code spawns one per session in the session's working
// directory; it forwards each tool call to the shared daemon with
// X-Project-Root = the session cwd, so one daemon serves every project.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";

const DAEMON = process.env.TSCA_DAEMON ?? `http://127.0.0.1:${process.env.TSCA_PORT ?? 47600}`;
const PROJECT_ROOT = process.env.TSCA_PROJECT_ROOT ?? process.cwd();

async function callDaemon(tool: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${DAEMON}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-project-root": PROJECT_ROOT },
    body: JSON.stringify({ tool, args }),
  });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error ?? `daemon error ${res.status}`);
  return body.result;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const S = z.string();
const specs: Array<{ name: string; description: string; schema: ZodRawShape }> = [
  { name: "overview", description: "Project orientation: packages, symbol/edge/entrypoint counts, build freshness. Start here.", schema: {} },
  { name: "list_packages", description: "Workspace packages and their roots.", schema: {} },
  {
    name: "find_symbols",
    description: "Find symbols by name/kind/package. Returns SymbolIds + compact projections; chain into get_symbol/relations/usages.",
    schema: { name: S.optional(), kind: S.optional(), package: S.optional(), limit: z.number().optional() },
  },
  {
    name: "get_symbol",
    description: "Expand one symbol by SymbolId: signature, doc, location, members (+ decorators). view:'full' adds params/returns/flags.",
    schema: { symbol: S.describe("a SymbolId"), view: z.enum(["summary", "full"]).optional() },
  },
  { name: "get_file", description: "Browse a file by FileId without reading it: exports, top-level symbols, resolved imports.", schema: { file: S } },
  { name: "type_of", description: "Resolved type info for a symbol: signature, params, returns, typeText.", schema: { symbol: S } },
  {
    name: "relations",
    description: "Outbound edges from a symbol/file: calls, imports, extends, implements, references, instantiates (default all).",
    schema: { target: S.describe("a SymbolId or FileId"), kinds: z.array(S).optional() },
  },
  {
    name: "usages",
    description: "Inbound edges into a symbol/file — what uses X: calls, references, imports. Coverage-reported.",
    schema: { target: S, kinds: z.array(S).optional() },
  },
  { name: "implementers", description: "Classes implementing an interface. Complete + coverage-reported.", schema: { symbol: S } },
  { name: "subclasses", description: "Classes extending a class (transitive optional).", schema: { symbol: S, transitive: z.boolean().optional() } },
  { name: "entrypoints", description: "Entry points by kind: bin | package-main | nest-bootstrap | ...", schema: { kind: S.optional() } },
  {
    name: "call_paths",
    description: "Call path(s) between two symbols over calls/contract edges (bounded depth).",
    schema: { from: S, to: S, maxDepth: z.number().optional() },
  },
  {
    name: "explain_symbol",
    description: "Bounded dossier for one symbol: summary detail + relation/usage counts + ranked top-N pointers + coverage. One call to orient.",
    schema: { symbol: S },
  },
  // Category D — semantic search (natural-language discovery; hand the anchor to the structural tools).
  {
    name: "search",
    description: "Natural-language code/schema discovery. Returns ranked chunks → { anchor (SymbolId|fragmentId), level, kind, score, span, snippet }. kind filters code|schema|doc. The 'where is X' entry point.",
    schema: { query: S, kind: z.enum(["code", "schema", "doc"]).optional(), package: S.optional(), limit: z.number().optional() },
  },
  {
    name: "search_similar",
    description: "Symbols semantically nearest a given symbol — find analogous handlers or potential duplication.",
    schema: { symbol: S, limit: z.number().optional() },
  },
  // Category B — NestJS (registered only when the Nest adapter is active).
  {
    name: "nest_routes",
    description: "The HTTP route table: method, path, controller/handler symbols, guard summary. Filter by method/path/controller.",
    schema: { method: S.optional(), path: S.optional(), controller: S.optional(), limit: z.number().optional() },
  },
  {
    name: "nest_route",
    description: "One route fully expanded: params (with DTO links), return type, and the ordered guard→interceptor→pipe→handler→filter pipeline.",
    schema: { route: S.optional().describe("a route fragment id"), handler: S.optional().describe("a handler SymbolId") },
  },
  {
    name: "nest_pipeline_for",
    description: "What actually runs for a request: the effective guard/interceptor/pipe/filter chain across all five levels (global-bootstrap, global-di, controller, method, param) in execution order, with source/resolved tags and a `complete` flag.",
    schema: { handler: S.optional().describe("a route handler SymbolId"), controller: S.optional() },
  },
  { name: "nest_controllers", description: "Controllers with base path, route count, and declaring module.", schema: {} },
  {
    name: "nest_providers",
    description: "DI provider bindings: token, providerType (useClass|useValue|useFactory|useExisting), scope, module, concrete provider, injected-into. Filterable.",
    schema: { module: S.optional(), token: S.optional(), scope: S.optional() },
  },
  {
    name: "nest_resolve_token",
    description: "What provides a DI token: the binding(s), concrete provider symbol, and defining module.",
    schema: { token: S, fromModule: S.optional() },
  },
  {
    name: "nest_injected_into",
    description: "Where a provider/token is injected — the reverse DI edge (constructors that receive it).",
    schema: { symbol: S.optional(), token: S.optional() },
  },
  { name: "nest_module_graph", description: "Module import/export graph: each module's imports, controllers, providers, exports.", schema: {} },
  { name: "nest_module", description: "One module: imports, controllers, provider bindings, exports.", schema: { module: S.describe("module name or fragment id") } },
  // Category C — Prisma (registered only when the Prisma adapter is active).
  { name: "db_models", description: "Prisma models: name, table, field/relation summary, clientStale.", schema: { limit: z.number().optional() } },
  { name: "db_model", description: "One model fully expanded: fields (type/dbType/nullable/id/unique), relations (kind/fk), indexes, uniques.", schema: { model: S.describe("model name or prisma:model:* id") } },
  { name: "db_er", description: "Entity-relationship graph (models + relations). Filter to a subgraph around one model at a relation depth.", schema: { around: S.optional(), depth: z.number().optional() } },
  {
    name: "db_model_usage",
    description: "The model↔code bridge: where a model is read/written in project source (op, rw, fields, caller symbol, span, typed|heuristic confidence). Filter by rw.",
    schema: { model: S, rw: z.enum(["read", "write"]).optional() },
  },
  { name: "db_enums", description: "Prisma enums (name + members).", schema: {} },
  { name: "db_raw_queries", description: "Captured $queryRaw/$executeRaw sites: SQL text + caller symbol + span.", schema: { limit: z.number().optional() } },
  { name: "db_migrations", description: "Static migration report (no DB): migrations found, operations/tables, and schema↔migration table drift.", schema: {} },
  // Category E — live data (registered only when a DB connection is configured). Read-only; never mutates.
  { name: "data_tables", description: "Live tables + columns from the configured connection, reconciled against Prisma models (flags schema drift).", schema: { schema: S.optional() } },
  { name: "data_sample", description: "Sample rows from a table (read-only, hard row cap).", schema: { table: S, limit: z.number().optional() } },
  {
    name: "data_query",
    description: "Run a SELECT-only query (parsed + rejected if it mutates), with statement timeout + row cap. Never mutates.",
    schema: { sql: S, limit: z.number().optional() },
  },
  {
    name: "data_explain",
    description: "EXPLAIN a SELECT, or the query a Prisma model+op would run. analyze:true runs EXPLAIN ANALYZE (SELECT-only, config-gated by liveData.allowAnalyze).",
    schema: { sql: S.optional(), model: S.optional(), op: S.optional(), analyze: z.boolean().optional() },
  },
  { name: "data_count", description: "Fast row count / cardinality for a table (optional WHERE, still SELECT-only guarded).", schema: { table: S, where: S.optional() } },
];

/** Ask the daemon which tools are active for this project (core + detected
 *  adapters), so a plain-TS project registers only category A. On any failure
 *  fall back to the full catalog — a superfluous nest_* tool is harmless (the
 *  daemon gates it) and losing the core tools would be worse. */
async function activeTools(): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${DAEMON}/manifest`, { headers: { "x-project-root": PROJECT_ROOT } });
    if (!res.ok) return null;
    const body = (await res.json()) as { tools?: string[] };
    return body.tools ? new Set(body.tools) : null;
  } catch {
    return null;
  }
}

const active = await activeTools();
const enabled = active ? specs.filter((s) => active.has(s.name)) : specs;

const server = new McpServer({ name: "ts-code-awareness", version: "0.1.0" });
for (const spec of enabled) {
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: spec.schema },
    async (args: unknown) => textResult(await callDaemon(spec.name, args)),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[tsca] mcp shim connected → ${DAEMON} (X-Project-Root ${PROJECT_ROOT}) — ${enabled.length}/${specs.length} tools`);
