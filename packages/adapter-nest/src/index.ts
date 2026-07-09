// The Nest adapter: self-activating on `@nestjs/core`/`@nestjs/common` in a
// package's deps. Contributes nest:* fragments (build.ts) and the category-B
// tool surface (tools.ts). The daemon registers it; core stays framework-blind.
import type { Adapter, AdapterTool } from "@codehead-pl/tsca-core";
import { build } from "./build.ts";
import * as t from "./tools.ts";

const tools: Record<string, AdapterTool> = {
  nest_routes: t.nest_routes,
  nest_route: t.nest_route,
  nest_pipeline_for: t.nest_pipeline_for,
  nest_controllers: t.nest_controllers,
  nest_providers: t.nest_providers,
  nest_resolve_token: t.nest_resolve_token,
  nest_injected_into: t.nest_injected_into,
  nest_module_graph: t.nest_module_graph,
  nest_module: t.nest_module,
  nest_graphql: t.nest_graphql,
  nest_messaging: t.nest_messaging,
};

export const nestAdapter: Adapter = {
  name: "nest",
  fingerprintGlobs: ["**/*.controller.ts", "**/*.module.ts", "**/*.service.ts", "**/main.ts", "**/*.guard.ts", "**/*.resolver.ts"],
  detect: (pkg) => pkg.dependencies.includes("@nestjs/core") || pkg.dependencies.includes("@nestjs/common"),
  build,
  tools,
  // nest_graphql / nest_messaging are sub-adapter surfaces: only meaningful when
  // the project uses @nestjs/graphql or @nestjs/microservices/BullMQ respectively.
  // build() sets the `nest:graphql` / `nest:messaging` meta flag on detection; the
  // daemon gates the tool out of /manifest otherwise.
  gatedTools: { nest_graphql: "nest:graphql", nest_messaging: "nest:messaging" },
};

export { build } from "./build.ts";
