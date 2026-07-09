// Shared multi-tenant HTTP daemon. Started by the SessionStart hook, outlives
// individual sessions. Each request carries X-Project-Root; the daemon routes
// to that project's warm map (building on first use).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { registerAdapter, registeredAdapters, warmDefaultEmbedder } from "@codehead-pl/tsca-core";
import { nestAdapter } from "@codehead-pl/tsca-adapter-nest";
import { prismaAdapter } from "@codehead-pl/tsca-adapter-prisma";
import { liveTools } from "@codehead-pl/tsca-live-data";
import { ProjectManager } from "./projects.ts";
import * as tools from "./tools.ts";
import type { ToolArgs } from "./tools.ts";
import type { Project } from "./projects.ts";

const PORT = Number(process.env.TSCA_PORT ?? 47600);
const HOST = "127.0.0.1";

// Assembly point: register first-party adapters. Core stays framework-blind;
// buildSkeleton runs each adapter over the packages it detects.
registerAdapter(nestAdapter);
registerAdapter(prismaAdapter);

const pm = new ProjectManager();

const CORE_TOOLS: Record<string, (p: Project, args: ToolArgs) => unknown> = {
  overview: tools.overview,
  list_packages: tools.list_packages,
  find_symbols: tools.find_symbols,
  get_symbol: tools.get_symbol,
  get_file: tools.get_file,
  type_of: tools.type_of,
  relations: tools.relations,
  usages: tools.usages,
  implementers: tools.implementers,
  subclasses: tools.subclasses,
  entrypoints: tools.entrypoints,
  call_paths: tools.call_paths,
  explain_symbol: tools.explain_symbol,
  search: tools.search,
  search_similar: tools.search_similar,
};

// Adapter tools, wrapped to the (Project, args) shape and gated by which
// adapter owns each tool (so a non-Nest project can't invoke nest_*).
const ADAPTER_TOOLS: Record<string, { adapter: string; run: (p: Project, args: ToolArgs) => unknown }> = {};
const TOOLS_BY_ADAPTER: Record<string, string[]> = {};
// Sub-detection gates: tool name → a store meta key that must be truthy for the
// tool to appear/run (e.g. nest_graphql gated on the `nest:graphql` flag the Nest
// adapter sets when it finds @nestjs/graphql). Absent key ⇒ ungated.
const GATED_TOOLS: Record<string, string> = {};
for (const a of registeredAdapters()) {
  TOOLS_BY_ADAPTER[a.name] = Object.keys(a.tools);
  for (const [tool, key] of Object.entries(a.gatedTools ?? {})) GATED_TOOLS[tool] = key;
  for (const [name, fn] of Object.entries(a.tools)) {
    ADAPTER_TOOLS[name] = {
      adapter: a.name,
      run: (p, args) => fn(p.store, (args ?? {}) as Record<string, unknown>, { hydrate: p.hydrate }),
    };
  }
}

/** A sub-detection-gated tool is active only when its meta flag is truthy for
 *  the project. Ungated tools are always active. */
function toolGateActive(project: Project, tool: string): boolean {
  const key = GATED_TOOLS[tool];
  return !key || project.store.getMeta(key) === "true";
}

// Live-data tools (category E) — only when the project configures a connection.
// Each opens the project's own read-only driver; the guard/caps live in the tool.
const LIVE_TOOLS: Record<string, (p: Project, args: ToolArgs) => Promise<unknown>> = {
  data_tables: async (p, a) => liveTools.data_tables(p.store, await p.connection(), p.liveData!, a as Record<string, unknown>),
  data_sample: async (p, a) => liveTools.data_sample(p.store, await p.connection(), p.liveData!, a as Record<string, unknown>),
  data_query: async (p, a) => liveTools.data_query(p.store, await p.connection(), p.liveData!, a as Record<string, unknown>),
  data_explain: async (p, a) => liveTools.data_explain(p.store, await p.connection(), p.liveData!, a as Record<string, unknown>),
  data_count: async (p, a) => liveTools.data_count(p.store, await p.connection(), p.liveData!, a as Record<string, unknown>),
};

/** Tool names available for a project: core always + each active adapter's +
 *  the live-data tools when a DB connection is configured. */
function manifestFor(project: Project): string[] {
  const names = Object.keys(CORE_TOOLS);
  for (const a of project.adapters) names.push(...(TOOLS_BY_ADAPTER[a] ?? []).filter((t) => toolGateActive(project, t)));
  if (project.liveData) names.push(...Object.keys(LIVE_TOOLS));
  return names;
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        coreTools: Object.keys(CORE_TOOLS),
        adapterTools: TOOLS_BY_ADAPTER,
        projects: pm.status(),
      });
    }

    // Per-project tool manifest: core tools + tools of each detected adapter.
    // The MCP shim fetches this at startup and registers only active tools, so
    // a plain-TS project never sees nest_*.
    if (req.method === "GET" && req.url === "/manifest") {
      const root = req.headers["x-project-root"];
      if (typeof root !== "string" || !root) {
        return json(res, 400, { error: "missing X-Project-Root header" });
      }
      const project = pm.get(root);
      return json(res, 200, { tools: manifestFor(project), adapters: project.adapters });
    }

    if (req.method === "POST" && req.url === "/rpc") {
      const root = req.headers["x-project-root"];
      if (typeof root !== "string" || !root) {
        return json(res, 400, { error: "missing X-Project-Root header" });
      }
      const { tool, args } = JSON.parse((await readBody(req)) || "{}") as {
        tool?: string;
        args?: ToolArgs;
      };
      const core = tool ? CORE_TOOLS[tool] : undefined;
      const adapterTool = tool ? ADAPTER_TOOLS[tool] : undefined;
      const liveTool = tool ? LIVE_TOOLS[tool] : undefined;
      if (!core && !adapterTool && !liveTool) return json(res, 404, { error: `unknown tool: ${tool}` });
      const project = pm.get(root);
      if (adapterTool && !project.adapters.includes(adapterTool.adapter)) {
        return json(res, 400, { error: `tool ${tool} requires the ${adapterTool.adapter} adapter, which is not active for this project` });
      }
      if (adapterTool && tool && !toolGateActive(project, tool)) {
        return json(res, 400, { error: `tool ${tool} requires the ${GATED_TOOLS[tool]} feature, which is not active for this project` });
      }
      if (liveTool && !project.liveData) {
        return json(res, 400, { error: `tool ${tool} requires a live-data connection; configure liveData in tsca.config.json at the project root` });
      }
      const result = core
        ? core(project, args ?? {})
        : adapterTool
          ? adapterTool.run(project, args ?? {})
          : await liveTool!(project, args ?? {});
      return json(res, 200, { result });
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  // stderr so nothing pollutes any stdio consumer
  console.error(`[tsca] daemon listening on http://${HOST}:${PORT} (LRU cap ${process.env.TSCA_LRU ?? 3})`);
});

// Learned local embedder, opt-in via TSCA_EMBEDDER=onnx. Loaded once and
// shared across every warm project; on failure (offline / unsupported) the
// engine keeps the offline HashingEmbedder. Fire-and-forget so boot isn't
// blocked; already-built indexes re-embed lazily on model change (hash-gated).
if (["onnx", "learned"].includes((process.env.TSCA_EMBEDDER ?? "").toLowerCase())) {
  warmDefaultEmbedder({ modelId: process.env.TSCA_EMBEDDER_MODEL })
    .then((e) => console.error(`[tsca] learned embedder loaded: ${e.id} (dim ${e.dim})`))
    .catch((err) => console.error(`[tsca] learned embedder unavailable, using hashing fallback: ${err.message}`));
}
