import { Store, buildSkeleton, hydratePackage } from "../src/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store = new Store(join(tmpdir(), `tiers-${process.pid}.db`));

console.log("=== buildSkeleton (Tier-1: structural, all packages) ===");
const t0 = performance.now();
const res = buildSkeleton(store, "fixtures/nest-monorepo");
console.log("skeleton:", res, `in ${Math.round(performance.now() - t0)}ms`);
console.log("hydrated packages:", store.hydratedPackages());

const countKind = (k: string) => {
  let n = 0;
  for (const s of store.findSymbols({ limit: 500 })) n += store.edgesFrom(s.id, [k as never]).length;
  return n;
};
console.log("structural edges present — implements:", countKind("implements"), "overrides:", countKind("overrides"));
console.log("call edges (should be 0 before hydration):", countKind("calls"));

// path-alias resolution: worker's `@fixture/core` import should resolve to a file
console.log("\nworker file imports (tsPaths resolution):");
for (const e of store.edgesFrom("@fixture/worker|src/in-memory-user-repository.ts", ["imports"]))
  console.log(`  -> ${e.dst} (${e.resolved})`);

console.log("\nimplementers of Repository (structural, complete at Tier-1):");
for (const e of store.edgesTo("@fixture/core|src/repository.ts|Repository", ["implements"])) console.log(`  <- ${e.src}`);

console.log("\n=== hydratePackage(@fixture/core) ===");
console.log("ran:", hydratePackage(store, "fixtures/nest-monorepo", "@fixture/core"));
console.log("hydrated packages:", store.hydratedPackages());
console.log("core call edges now:", countKind("calls"));
console.log("BaseService.describe calls:");
for (const e of store.edgesFrom("@fixture/core|src/base-service.ts|BaseService.describe", ["calls"]))
  console.log(`  -> ${e.dst} (${e.resolved})`);

console.log("\nhydratePackage(@fixture/core) again (idempotent):", hydratePackage(store, "fixtures/nest-monorepo", "@fixture/core"));

// ---- references edges ------------------------------------------------
// `references` is a Tier-2 edge (built by the per-package sweep next to
// calls/instantiates), so it is only present after hydration. Drive the exact
// store methods that relations()/usages() wrap: edgesFrom == relations,
// edgesTo == usages.
const ROLE = "@fixture/core|src/types.ts|Role";
const ROLE_USER = "@fixture/core|src/types.ts|Role.User";
const ID = "@fixture/core|src/types.ts|Id";
const DEFAULT_ROLE = "@fixture/core|src/base-service.ts|BaseService.defaultRole";
const MAKE_KEY = "@fixture/core|src/base-service.ts|BaseService.makeKey";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
};

console.log("\n=== references edges (W2) ===");
console.log("relations(BaseService.defaultRole, references):");
const fromDefault = store.edgesFrom(DEFAULT_ROLE, ["references"]);
for (const e of fromDefault) console.log(`  -> ${e.dst} (${e.resolved})`);

// Type used in a signature: defaultRole(): Role  → references Role (enum, exact).
assert(
  fromDefault.some((e) => e.dst === ROLE && e.resolved === "exact"),
  "defaultRole references the Role enum via its return-type annotation (exact)",
);
// Enum-member read: return Role.User  → references the specific enum-member.
assert(
  fromDefault.some((e) => e.dst === ROLE_USER && e.resolved === "exact"),
  "defaultRole references the Role.User enum member (value-position read)",
);

// Type used in a signature on another method: makeKey(id: Id) → references Id.
const fromMakeKey = store.edgesFrom(MAKE_KEY, ["references"]);
assert(
  fromMakeKey.some((e) => e.dst === ID),
  "makeKey references the Id type alias via its parameter type",
);

// usages() surface: reverse-lookup the enum member finds the referencing method.
console.log("usages(Role.User, references):");
const toRoleUser = store.edgesTo(ROLE_USER, ["references"]);
for (const e of toRoleUser) console.log(`  <- ${e.src} (${e.resolved})`);
assert(
  toRoleUser.some((e) => e.src === DEFAULT_ROLE),
  "usages of Role.User surfaces BaseService.defaultRole as a reference site",
);
assert(
  store.edgesTo(ROLE, ["references"]).some((e) => e.src === DEFAULT_ROLE),
  "usages of Role surfaces BaseService.defaultRole as a reference site",
);

// De-dup guard: heritage / calls / instantiates must NOT leak into references.
// BaseService.describe() only calls this.resourceName()/this.count() (member
// calls) — no top-level symbol is used in value/type position there.
assert(
  store.edgesFrom("@fixture/core|src/base-service.ts|BaseService.describe", ["references"]).length === 0,
  "describe() emits no spurious references (member calls are not references)",
);

store.close();
console.log("\nOK: references edges surface via edgesFrom/edgesTo (relations/usages).");
