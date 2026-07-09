// Booted-runtime pipeline oracle.
//
// This is the trustworthy oracle that the fast structural check (nest.ts) is
// NOT: it actually instantiates the fixture Nest application, derives the REAL
// effective guard/interceptor/pipe/filter chain from Nest's own runtime sources,
// and asserts `nest_pipeline_for(handler)` equals that chain for every fixture
// route — with `complete:false` appearing exactly where a bootstrap global is
// genuinely dynamic.
//
// How the runtime chain is derived (each element from an independent runtime
// source, never hardcoded):
//   * bootstrap globals (level 1) — replay main.ts's real `registerGlobals()`
//     against a recorder; the "dynamic" guard resolves to a concrete instance,
//     which is exactly what static analysis honestly cannot see.
//   * DI globals    (level 2) — enumerate APP_GUARD/PIPE/INTERCEPTOR/FILTER
//     providers over the booted module tree.
//   * controller    (level 3) — Reflector metadata on the controller class.
//   * method        (level 4) — Reflector metadata on the handler method.
//   * param pipes   (level 5) — ROUTE_ARGS_METADATA pipes, at the pipe tail.
//
// The @nestjs/* runtime is resolved from the fixture's own node_modules (via a
// createRequire rooted there) so the test shares a single Nest instance with the
// booted app. The app is compiled (full DI container built + every singleton
// instantiated) but NOT `init()`-ed: Prisma constructs lazily, so no live DB is
// needed; only $connect (an onModuleInit side effect we skip) would touch one.
//
// Run: `pnpm test:nest:runtime`. Exits non-zero on any regression.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Store, buildSkeleton, registerAdapter } from "@codehead-pl/tsca-core";
import { nestAdapter } from "../src/index.ts";
import * as t from "../src/tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const FIX_ROOT = join(REPO, "fixtures/nest-monorepo");
const FIX_API = join(FIX_ROOT, "packages/api");

// PrismaClient reads its datasource url at construction; a dummy is enough since
// we never connect (no init / no $connect).
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/fixture";

// Resolve the Nest runtime from the fixture's node_modules so the test and the
// booted app share one @nestjs instance (a second copy would break DI).
const fixReq = createRequire(FIX_API + "/");
fixReq("reflect-metadata");
const { Test } = fixReq("@nestjs/testing");
const nestCore = fixReq("@nestjs/core");
const C = fixReq("@nestjs/common/constants");
const { APP_GUARD, APP_PIPE, APP_INTERCEPTOR, APP_FILTER } = nestCore;
const MM = C.MODULE_METADATA;

type Kind = "guard" | "interceptor" | "pipe" | "filter";
const KIND_META: Record<Kind, string> = {
  guard: C.GUARDS_METADATA,
  interceptor: C.INTERCEPTORS_METADATA,
  pipe: C.PIPES_METADATA,
  filter: C.EXCEPTION_FILTERS_METADATA,
};
const APP_TOKEN: Record<string, Kind> = {
  [APP_GUARD]: "guard",
  [APP_PIPE]: "pipe",
  [APP_INTERCEPTOR]: "interceptor",
  [APP_FILTER]: "filter",
};

// reflect-metadata (loaded above via fixReq) augments the global Reflect, but
// TypeScript's lib doesn't declare it — read through a typed shim.
const getMeta = (key: unknown, target: unknown, prop?: unknown): any =>
  (Reflect as any).getMetadata(key, target, prop);

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}

/** A runtime enhancer instance or class → its class name. */
function nameOf(x: any): string {
  if (typeof x === "function") return x.name;
  return x?.constructor?.name ?? String(x);
}

const empty = (): Record<Kind, string[]> => ({ guard: [], interceptor: [], pipe: [], filter: [] });

/** Reflector-derived @UseGuards/@UsePipes/... on a class or a method function. */
function localEnhancers(target: any): Record<Kind, string[]> {
  const out = empty();
  for (const kind of Object.keys(KIND_META) as Kind[]) {
    for (const e of (getMeta(KIND_META[kind], target) as any[] | undefined) ?? []) {
      out[kind].push(nameOf(e));
    }
  }
  return out;
}

/** Level-5 param pipes (@Param('id', ParseIntPipe), @Body(new ValidationPipe())). */
function paramPipes(ctrl: any, method: string): string[] {
  const args = (getMeta(C.ROUTE_ARGS_METADATA, ctrl, method) as Record<string, any>) ?? {};
  const out: string[] = [];
  for (const entry of Object.values(args).sort((a, b) => a.index - b.index)) {
    for (const p of entry.pipes ?? []) out.push(nameOf(p));
  }
  return out;
}

/** Assert one static stage equals the runtime stage in execution order.
 *  Returns the count of honestly-unresolved (dynamic bootstrap) static slots. */
function compareStage(routeLabel: string, stage: string, staticEls: any[], runtimeNames: string[]): number {
  check(`${routeLabel} · ${stage}: chain length ${staticEls.length} == runtime ${runtimeNames.length}`,
    staticEls.length === runtimeNames.length);
  let dynamicSlots = 0;
  const n = Math.max(staticEls.length, runtimeNames.length);
  for (let i = 0; i < n; i++) {
    const s = staticEls[i];
    const r = runtimeNames[i];
    if (!s || r === undefined) {
      check(`${routeLabel} · ${stage}[${i}]: present on both sides`, false);
      continue;
    }
    if (s.resolved) {
      check(`${routeLabel} · ${stage}[${i}]: ${String(s.name)} (static) == ${r} (runtime)`,
        String(s.name) === String(r));
    } else {
      // The only place static is allowed to disagree: a dynamic bootstrap global
      // that the analyzer cannot resolve but the runtime turns into a concrete
      // instance. Assert that's exactly what this slot is.
      check(`${routeLabel} · ${stage}[${i}]: dynamic bootstrap global — static unresolved '${String(s.name)}', runtime concrete '${r}'`,
        s.source === "global-bootstrap" && typeof r === "string" && r.length > 0);
      dynamicSlots += 1;
    }
  }
  return dynamicSlots;
}

async function main(): Promise<void> {
  // This script is launched with cwd = the fixture's api package so tsx locks in
  // that package's tsconfig (experimentalDecorators + emitDecoratorMetadata) for
  // every transform — Nest DI needs the emitted `design:paramtypes`. tsx fixes
  // its tsconfig at startup, so we can now restore cwd to the repo root, which is
  // what buildSkeleton's file globbing expects.
  process.chdir(REPO);

  // ---- static side: build the skeleton, capture nest_pipeline_for per route --
  registerAdapter(nestAdapter);
  const store = new Store(join(tmpdir(), `nest-runtime-${process.pid}.db`));
  const skel = buildSkeleton(store, FIX_ROOT);
  console.log("skeleton:", skel, "adapters:", store.getMeta("adapters"));
  check("nest adapter active", store.getMeta("adapters") === '["nest"]');

  const routes = (t.nest_routes(store, {}) as {
    routes: Array<{ id: string; method: string; path: string; handler?: { id: string; name: string } }>;
  }).routes;
  check("routes discovered", routes.length === 3);

  // ---- boot the fixture app (real DI container, real provider instances) -----
  const { AppModule } = await import(join(FIX_API, "src/app.module.ts"));
  const { UsersService } = await import(join(FIX_API, "src/users/users.service.ts"));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  check("fixture app boots (DI container compiled)", !!moduleRef);
  // Retrieving a provider proves the graph actually instantiated (UsersService
  // needs PrismaService + the cross-package USER_REPOSITORY — if DI or the
  // PrismaClient construction had failed, compile() would have thrown).
  const svc = moduleRef.get(UsersService, { strict: false });
  check("UsersService instantiated via real DI", svc?.constructor?.name === "UsersService");

  // ---- runtime derivation: the three app-wide levels (shared by all routes) --
  // Level 1 — bootstrap globals: replay main.ts's real registration.
  const boot = empty();
  const recorder = {
    useGlobalGuards: (...gs: any[]) => gs.forEach((g) => boot.guard.push(nameOf(g))),
    useGlobalPipes: (...ps: any[]) => ps.forEach((p) => boot.pipe.push(nameOf(p))),
    useGlobalInterceptors: (...is: any[]) => is.forEach((i) => boot.interceptor.push(nameOf(i))),
    useGlobalFilters: (...fs: any[]) => fs.forEach((f) => boot.filter.push(nameOf(f))),
  };
  const { registerGlobals } = await import(join(FIX_API, "src/main.ts"));
  registerGlobals(recorder);
  console.log("runtime bootstrap globals:", boot);

  // Level 2 — DI globals: enumerate APP_* providers over the booted module tree.
  const di = empty();
  const seen = new Set<any>();
  const mods: any[] = [];
  const ctrlByName = new Map<string, any>();
  const walk = (m: any): void => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    mods.push(m);
    for (const c of (getMeta(MM.CONTROLLERS, m) as any[] | undefined) ?? []) {
      ctrlByName.set(c.name, c);
    }
    for (let im of (getMeta(MM.IMPORTS, m) as any[] | undefined) ?? []) {
      if (im && typeof im === "object" && "module" in im) im = im.module; // dynamic module
      if (typeof im === "function") walk(im);
    }
  };
  walk(AppModule);
  for (const m of mods) {
    for (const p of (getMeta(MM.PROVIDERS, m) as any[] | undefined) ?? []) {
      if (p && typeof p === "object" && "provide" in p && APP_TOKEN[p.provide]) {
        di[APP_TOKEN[p.provide]].push(nameOf(p.useClass ?? p.useValue ?? p.useExisting));
      }
    }
  }
  console.log("runtime DI globals:", di);
  check("DI-global guard is RolesGuard (APP_GUARD)", di.guard.join(",") === "RolesGuard");

  // ---- per-route comparison --------------------------------------------------
  let routesChecked = 0;
  for (const route of routes) {
    const handlerId = route.handler?.id;
    if (!handlerId) {
      check(`route ${route.id} has a handler symbol`, false);
      continue;
    }
    // handler symbol id = `pkg|file|Controller.method`
    const tail = handlerId.split("|").pop() ?? "";
    const dot = tail.lastIndexOf(".");
    const ctrlName = tail.slice(0, dot);
    const method = tail.slice(dot + 1);
    const label = `${route.method} ${route.path} (${ctrlName}.${method})`;

    const ctrl = ctrlByName.get(ctrlName);
    check(`${label}: controller class found at runtime`, !!ctrl);
    if (!ctrl) continue;
    check(`${label}: handler method exists on prototype`, typeof ctrl.prototype[method] === "function");

    const ctrlLocal = localEnhancers(ctrl);
    const methodLocal = localEnhancers(ctrl.prototype[method]);
    const params = paramPipes(ctrl, method);

    // Effective runtime chain, in execution order:
    //   guards/interceptors/filters: global(bootstrap → DI) → controller → method
    //   pipes: global(bootstrap → DI) → controller → method → param (tail)
    // (bootstrap-vs-DI sub-order within the global level is the representational
    //  convention nest_pipeline_for uses; both are global and precede controller.)
    const runtime: Record<Kind, string[]> = {
      guard: [...boot.guard, ...di.guard, ...ctrlLocal.guard, ...methodLocal.guard],
      interceptor: [...boot.interceptor, ...di.interceptor, ...ctrlLocal.interceptor, ...methodLocal.interceptor],
      pipe: [...boot.pipe, ...di.pipe, ...ctrlLocal.pipe, ...methodLocal.pipe, ...params],
      filter: [...boot.filter, ...di.filter, ...ctrlLocal.filter, ...methodLocal.filter],
    };

    const pf = t.nest_pipeline_for(store, { handler: handlerId }) as {
      guards: any[]; interceptors: any[]; pipes: any[]; filters: any[];
      complete: boolean; unresolved?: Array<{ source: string }>;
    };

    let dyn = 0;
    dyn += compareStage(label, "guards", pf.guards, runtime.guard);
    dyn += compareStage(label, "interceptors", pf.interceptors, runtime.interceptor);
    dyn += compareStage(label, "pipes", pf.pipes, runtime.pipe);
    dyn += compareStage(label, "filters", pf.filters, runtime.filter);

    // complete:false exactly when (and where) a dynamic bootstrap global exists.
    check(`${label}: complete flag matches reality (complete=${pf.complete}, dynamic slots=${dyn})`,
      pf.complete === (dyn === 0));
    for (const u of pf.unresolved ?? []) {
      check(`${label}: incompleteness is a bootstrap global (source=${u.source})`, u.source === "global-bootstrap");
    }
    routesChecked += 1;
  }

  check("every fixture route validated against the booted runtime", routesChecked === 3);

  await moduleRef.close();
  store.close();
  console.log(failures === 0
    ? "\nPASS — nest_pipeline_for matches the booted runtime for every route"
    : `\nFAIL — ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
