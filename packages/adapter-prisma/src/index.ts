// The Prisma adapter: self-activating when a package has a schema.prisma (or a
// @prisma/client dependency). Contributes prisma:* fragments (build.ts) and the
// category-C db_* tool surface (tools.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AdapterTool, Workspace, WorkspacePackage } from "@codehead-pl/tsca-core";
import { build, packageClosure } from "./build.ts";
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

/** A package directly declares Prisma or owns a schema.prisma. */
function ownsPrisma(pkg: WorkspacePackage): boolean {
  return (
    pkg.dependencies.includes("@prisma/client") ||
    pkg.dependencies.includes("prisma") ||
    existsSync(join(pkg.root, "prisma", "schema.prisma")) ||
    existsSync(join(pkg.root, "schema.prisma"))
  );
}

export const prismaAdapter: Adapter = {
  name: "prisma",
  // Any `.ts` may hold a client call site, so a source change in a prisma-active
  // package must be able to re-derive its access/raw fragments.
  fingerprintGlobs: ["**/*.prisma", "**/prisma/migrations/**", "**/*.ts"],
  // Activate on packages that own Prisma *and* on consumers that reach it only
  // transitively (schema in a `db` package, client consumed in `apps/*`): a
  // monorepo layout where the call sites live outside the schema-owning package.
  detect: (pkg, ws) => {
    if (ownsPrisma(pkg)) return true;
    const byName = new Map(ws.packages.map((p) => [p.name, p]));
    for (const dep of packageClosure(ws, pkg.name)) {
      const p = byName.get(dep);
      if (p && p !== pkg && ownsPrisma(p)) return true;
    }
    return false;
  },
  build,
  tools,
};

export { build } from "./build.ts";
export { parseSchema } from "./schema.ts";
