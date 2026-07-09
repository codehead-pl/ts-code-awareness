// Acceptance: explain_symbol surfaces
// adapter role facets built from the fragmentsBySymbol join, gated on active
// adapters. Verify a symbol that is BOTH a route handler and a prisma:access
// caller carries route + dbAccess; a plain symbol carries none.
import { Store, buildSkeleton, hydratePackage, registerAdapter } from "@codehead-pl/tsca-core";
import { nestAdapter } from "@codehead-pl/tsca-adapter-nest";
import { prismaAdapter } from "@codehead-pl/tsca-adapter-prisma";
import { explain_symbol } from "../src/tools.ts";
import type { Project } from "../src/projects.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerAdapter(nestAdapter);
registerAdapter(prismaAdapter);

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}

const root = "fixtures/nest-monorepo";
const store = new Store(join(tmpdir(), `roles-${process.pid}.db`));
const res = buildSkeleton(store, root);
console.log("skeleton:", res, "adapters:", store.getMeta("adapters"));

const project = {
  root,
  store,
  builtAt: "",
  adapters: JSON.parse(store.getMeta("adapters") ?? "[]") as string[],
  liveData: null,
  connection: async () => {
    throw new Error("no live data in this test");
  },
  hydrate: (pkg: string) => hydratePackage(store, root, pkg),
  hydrateClosure: () => {},
} as unknown as Project;

check("both nest + prisma adapters active", project.adapters.includes("nest") && project.adapters.includes("prisma"));

// ---- the headline case: a route handler that also hits the DB -------------
const HANDLER = "@fixture/api|src/users/users.controller.ts|UsersController.findAll";
const dossier = explain_symbol(project, { symbol: HANDLER }) as {
  roles: {
    route?: Array<{ id: string; method?: string; path?: string }>;
    dbAccess?: Array<{ id: string; model?: string; op?: string; rw?: string }>;
    provider?: unknown;
    model?: unknown;
  };
};
console.log("\nfindAll roles:", JSON.stringify(dossier.roles));
check("roles.route present with GET /users", !!dossier.roles.route?.some((r) => r.method === "GET" && r.path === "/users"));
check("route id is the route fragment", !!dossier.roles.route?.some((r) => r.id === "nest:route:GET /users"));
check("roles.dbAccess present, Post count read", !!dossier.roles.dbAccess?.some((d) => d.model === "Post" && d.op === "count" && d.rw === "read"));
check("no provider/model facet on a route handler", dossier.roles.provider === undefined && dossier.roles.model === undefined);

// ---- a pure prisma:access caller (service method) → dbAccess only ---------
const SERVICE = "@fixture/api|src/users/users.service.ts|UsersService.findOne";
const svc = explain_symbol(project, { symbol: SERVICE }) as { roles: { route?: unknown; dbAccess?: Array<{ model?: string }> } };
check("service method has dbAccess (User) but no route", svc.roles.route === undefined && !!svc.roles.dbAccess?.some((d) => d.model === "User"));

// ---- a provided class → provider facet ------------------------------------
const REPO = "@fixture/worker|src/in-memory-user-repository.ts|InMemoryUserRepository";
const repo = explain_symbol(project, { symbol: REPO }) as { roles: { provider?: Array<{ token?: string }> } };
console.log("repo roles:", JSON.stringify(repo.roles));
check("provided class carries roles.provider (USER_REPOSITORY)", !!repo.roles.provider?.some((pr) => pr.token === "USER_REPOSITORY"));

// ---- a plain symbol → empty roles -----------------------------------------
const PLAIN = "@fixture/core|src/base-service.ts|BaseService.describe";
const plain = explain_symbol(project, { symbol: PLAIN }) as { roles: Record<string, unknown> };
check("plain symbol → empty roles object", plain.roles && Object.keys(plain.roles).length === 0);

store.close();
console.log(failures === 0 ? "\nPASS — all W6 role-facet checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
