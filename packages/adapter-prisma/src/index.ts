// The Prisma adapter: self-activating when a package has a schema.prisma (or a
// @prisma/client dependency). Contributes prisma:* fragments (build.ts) and the
// category-C db_* tool surface (tools.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterTool } from "@tsca/core";
import { build } from "./build.ts";
import * as t from "./tools.ts";

const tools: Record<string, AdapterTool> = {
  db_models: t.db_models,
  db_model: t.db_model,
  db_er: t.db_er,
  db_model_usage: t.db_model_usage,
  db_enums: t.db_enums,
  db_raw_queries: t.db_raw_queries,
  db_migrations: t.db_migrations,
};

export const prismaAdapter: Adapter = {
  name: "prisma",
  fingerprintGlobs: ["**/*.prisma", "**/prisma/migrations/**", "**/*.service.ts"],
  detect: (pkg) =>
    pkg.dependencies.includes("@prisma/client") ||
    pkg.dependencies.includes("prisma") ||
    existsSync(join(pkg.root, "prisma", "schema.prisma")) ||
    existsSync(join(pkg.root, "schema.prisma")),
  build,
  tools,
};

export { build } from "./build.ts";
export { parseSchema } from "./schema.ts";
