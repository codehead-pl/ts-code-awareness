// nest_* tools. Thin, compact projections over the
// nest:* fragments built at skeleton time. No checker at query time.
import type { Store, FragmentNodeRecord } from "@tsca/core";

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function relPath(id: string): string {
  const parts = id.split("|");
  return parts[1] ?? id;
}

/** Compact reference to a core symbol (or an external/unknown id). */
function symRef(store: Store, id: string | undefined): Record<string, unknown> | undefined {
  if (!id) return undefined;
  if (id.startsWith("external:")) return { id, external: id.slice("external:".length) };
  const s = store.getSymbol(id);
  if (!s) return { id };
  return { id, name: s.name, kind: s.kind, loc: `${relPath(s.file)}:${s.span.startLine}-${s.span.endLine}` };
}

function asArray(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// ---- routes / controllers -----------------------------------------------

export function nest_routes(store: Store, args: Args) {
  const method = str(args.method)?.toUpperCase();
  const pathFilter = str(args.path);
  const controller = str(args.controller);
  let routes = store.fragments("nest", "route");
  if (method) routes = routes.filter((r) => r.attrs.method === method);
  if (pathFilter) routes = routes.filter((r) => String(r.attrs.path).includes(pathFilter));
  if (controller) routes = routes.filter((r) => r.attrs.controller === controller || first(r.refs.controller) === controller);
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const shown = routes.slice(0, limit);
  return {
    count: routes.length,
    routes: shown.map((r) => ({
      id: r.id,
      method: r.attrs.method,
      path: r.attrs.path,
      controller: symRef(store, first(r.refs.controller)),
      handler: symRef(store, first(r.refs.handler)),
      guards: asArray(r.refs.guards).map((g) => symRef(store, g)?.name ?? g),
      span: r.span,
    })),
    ...(routes.length > limit ? { nextCursor: String(limit) } : {}),
  };
}

export function nest_controllers(store: Store, _args: Args) {
  return {
    controllers: store.fragments("nest", "controller").map((c) => ({
      id: c.id,
      name: c.attrs.name,
      basePath: c.attrs.basePath,
      routeCount: c.attrs.routeCount,
      controller: symRef(store, first(c.refs.controller)),
      module: symRef(store, first(c.refs.module)),
    })),
  };
}

export function nest_route(store: Store, args: Args) {
  const node = resolveRoute(store, args);
  if (!node) return { error: "nest_route requires `route` (a route id) or `handler` (a SymbolId) that matches a route" };
  const pipeline = composePipeline(store, node);
  return {
    id: node.id,
    method: node.attrs.method,
    path: node.attrs.path,
    controller: symRef(store, first(node.refs.controller)),
    handler: symRef(store, first(node.refs.handler)),
    params: (node.attrs.params as unknown[]) ?? [],
    returns: node.attrs.returns ?? null,
    dtos: asArray(node.refs.dto).map((d) => symRef(store, d)),
    pipeline,
  };
}

// ---- GraphQL -------------------------------------------------------------

/** nest_graphql. Projects the nest:graphql
 *  fragments: resolver classes with their object type + guard chain, and each
 *  query/mutation/subscription/field handler with return type, handler symbol,
 *  and `@Args`→DTO links. `kind` filters to one facet:
 *  `resolver|query|mutation|subscription|field`. Detection-gated: only present
 *  when the project depends on `@nestjs/graphql`. */
export function nest_graphql(store: Store, args: Args) {
  const kind = str(args.kind);
  const resolvers = store.fragments("nest", "graphql-resolver");
  const ops = store.fragments("nest", "graphql-op");

  if (kind && kind !== "resolver") {
    // Flat list of ops of a single graphqlKind (query/mutation/subscription/field).
    const matched = ops.filter((o) => o.attrs.graphqlKind === kind);
    return { kind, count: matched.length, ops: matched.map((o) => renderGqlOp(store, o)) };
  }

  const opsByResolver = new Map<string, FragmentNodeRecord[]>();
  for (const o of ops) {
    const r = String(o.attrs.resolver);
    (opsByResolver.get(r) ?? opsByResolver.set(r, []).get(r)!).push(o);
  }

  return {
    count: resolvers.length,
    resolvers: resolvers.map((r) => {
      const name = String(r.attrs.name);
      const rops = opsByResolver.get(name) ?? [];
      const of = (k: string) => rops.filter((o) => o.attrs.graphqlKind === k).map((o) => renderGqlOp(store, o));
      return {
        id: r.id,
        name,
        objectType: r.attrs.objectType ?? null,
        resolver: symRef(store, first(r.refs.resolver)),
        guards: asArray(r.refs.guards).map((g) => symRef(store, g)?.name ?? g),
        queries: of("query"),
        mutations: of("mutation"),
        subscriptions: of("subscription"),
        fields: of("field"),
      };
    }),
  };
}

function renderGqlOp(store: Store, o: FragmentNodeRecord) {
  return {
    id: o.id,
    graphqlKind: o.attrs.graphqlKind,
    field: o.attrs.field,
    resolver: o.attrs.resolver,
    handler: symRef(store, first(o.refs.handler)),
    returns: o.attrs.returns ?? null,
    objectType: o.attrs.objectType ?? null,
    args: (o.attrs.params as unknown[]) ?? [],
    dtos: asArray(o.refs.dto).map((d) => symRef(store, d)),
  };
}

// ---- messaging -----------------------------------------------------------

/** nest_messaging. Projects the nest:messaging
 *  fragments: consumer classes (microservices controllers + BullMQ processors)
 *  with their transport/queue + guard chain, and each `@MessagePattern` /
 *  `@EventPattern` / BullMQ `@Process` handler with its pattern/topic or job
 *  name, transport, handler symbol, and `@Payload` → DTO link. `kind` filters to
 *  one facet: `message|event|process`. Detection-gated: only present when the
 *  project depends on `@nestjs/microservices` and/or BullMQ. */
export function nest_messaging(store: Store, args: Args) {
  const kind = str(args.kind);
  const consumers = store.fragments("nest", "messaging-controller");
  const handlers = store.fragments("nest", "messaging-handler");

  if (kind) {
    // Flat list of handlers of a single messagingKind (message/event/process).
    const matched = handlers.filter((h) => h.attrs.messagingKind === kind);
    return { kind, count: matched.length, handlers: matched.map((h) => renderMsgHandler(store, h)) };
  }

  const byConsumer = new Map<string, FragmentNodeRecord[]>();
  for (const h of handlers) {
    const c = String(h.attrs.consumer);
    (byConsumer.get(c) ?? byConsumer.set(c, []).get(c)!).push(h);
  }

  return {
    count: consumers.length,
    consumers: consumers.map((c) => {
      const name = String(c.attrs.name);
      const hs = byConsumer.get(name) ?? [];
      const of = (k: string) => hs.filter((h) => h.attrs.messagingKind === k).map((h) => renderMsgHandler(store, h));
      return {
        id: c.id,
        name,
        transport: c.attrs.transport,
        queue: c.attrs.queue ?? null,
        consumer: symRef(store, first(c.refs.consumer)),
        guards: asArray(c.refs.guards).map((g) => symRef(store, g)?.name ?? g),
        messages: of("message"),
        events: of("event"),
        processes: of("process"),
      };
    }),
  };
}

function renderMsgHandler(store: Store, h: FragmentNodeRecord) {
  return {
    id: h.id,
    messagingKind: h.attrs.messagingKind,
    transport: h.attrs.transport ?? null,
    pattern: h.attrs.pattern ?? null,
    queue: h.attrs.queue ?? null,
    jobName: h.attrs.jobName ?? null,
    consumer: h.attrs.consumer,
    handler: symRef(store, first(h.refs.handler)),
    payload: h.attrs.payload ?? null,
    dtos: asArray(h.refs.dto).map((d) => symRef(store, d)),
  };
}

// ---- pipeline_for: the five-level effective chain ------------------------

export function nest_pipeline_for(store: Store, args: Args) {
  const handler = str(args.handler);
  const controller = str(args.controller);
  let route: FragmentNodeRecord | undefined;
  // A handler may be a REST route, a GraphQL resolver op, or a messaging handler
  // — all carry the same pipeline refs, so composition treats them uniformly.
  if (handler) route = store.fragmentsBySymbol(handler, "handler").find((n) => n.kind === "route" || n.kind === "graphql-op" || n.kind === "messaging-handler");
  if (!route && controller) {
    // Controller-only view: synthesize a routeless node carrying the controller.
    const ctrl = store.fragmentsBySymbol(controller, "controller").find((n) => n.kind === "controller");
    if (!ctrl) return { error: `no Nest controller/route found for ${controller}` };
    return composePipeline(store, undefined, ctrl);
  }
  if (!route) return { error: "nest_pipeline_for requires `handler` (a route handler SymbolId) or `controller`" };
  return composePipeline(store, route);
}

type PipelineKind = "guard" | "interceptor" | "pipe" | "filter";
interface Element {
  name: unknown;
  symbol?: Record<string, unknown>;
  source: string;
  resolved: boolean;
  style?: string;
}

/** Compose the effective guard/interceptor/pipe/filter chain across all five
 *  registration levels in Nest's execution order. */
function composePipeline(store: Store, route?: FragmentNodeRecord, controllerNode?: FragmentNodeRecord) {
  // The class-level node is a REST controller, a GraphQL resolver, or a messaging
  // consumer — each carries `@UseGuards`/etc. that stack under the global levels.
  // A graphql-op references its class under `resolver`; a messaging-handler under
  // `consumer`; a route under `controller`.
  const refsOf = route ?? controllerNode;
  const ctrlId = refsOf ? (first(refsOf.refs.controller) ?? first(refsOf.refs.resolver) ?? first(refsOf.refs.consumer)) : undefined;
  const ctrl =
    controllerNode ??
    (ctrlId
      ? store.fragmentsBySymbol(ctrlId, "controller").find((n) => n.kind === "controller") ??
        store.fragmentsBySymbol(ctrlId, "resolver").find((n) => n.kind === "graphql-resolver") ??
        store.fragmentsBySymbol(ctrlId, "consumer").find((n) => n.kind === "messaging-controller")
      : undefined);

  const stages: Record<PipelineKind, Element[]> = { guard: [], interceptor: [], pipe: [], filter: [] };
  const push = (kind: PipelineKind, e: Element) => stages[kind].push(e);

  // Level 1: global via bootstrap (useGlobalX in main.ts) — runs first.
  for (const g of store.fragments("nest", "global-registration")) {
    const kind = g.attrs.pipelineKind as PipelineKind;
    push(kind, {
      name: g.attrs.className,
      symbol: symRef(store, first(g.refs.provides)),
      source: "global-bootstrap",
      resolved: g.attrs.resolved === true,
      style: g.attrs.style as string,
    });
  }
  // Level 2: global via DI (APP_* providers).
  for (const b of store.fragments("nest", "provider-binding")) {
    const kind = b.attrs.pipelineKind as PipelineKind | undefined;
    if (!kind || !b.attrs.appHook) continue;
    push(kind, {
      name: b.attrs.className ?? b.attrs.token,
      symbol: symRef(store, first(b.refs.provides)),
      source: "global-di",
      resolved: true,
      style: String(b.attrs.providerType),
    });
  }
  // Level 3: controller-level @UseX.
  if (ctrl) addLocal(store, ctrl, "controller", push);
  // Level 4: method-level @UseX.
  if (route) addLocal(store, route, "method", push);
  // Level 5: param-level pipes (@Param('id', ParseIntPipe), @Body(new
  // ValidationPipe())). Nest runs these after all global/controller/method
  // pipes, so they land at the pipe-stage tail.
  if (route) addParamPipes(store, route, push);

  const complete = (["guard", "interceptor", "pipe", "filter"] as PipelineKind[]).every((k) => stages[k].every((e) => e.resolved));
  const unresolved = (["guard", "interceptor", "pipe", "filter"] as PipelineKind[]).flatMap((k) => stages[k].filter((e) => !e.resolved).map((e) => ({ kind: k, ...e })));

  return {
    handler: route ? symRef(store, first(route.refs.handler)) : undefined,
    controller: symRef(store, ctrlId),
    route: route && route.kind === "route" ? { method: route.attrs.method, path: route.attrs.path } : undefined,
    ...(route && route.kind === "graphql-op"
      ? { graphql: { kind: route.attrs.graphqlKind, field: route.attrs.field, objectType: route.attrs.objectType } }
      : {}),
    ...(route && route.kind === "messaging-handler"
      ? { messaging: { kind: route.attrs.messagingKind, transport: route.attrs.transport, pattern: route.attrs.pattern ?? null, queue: route.attrs.queue ?? null, jobName: route.attrs.jobName ?? null } }
      : {}),
    order: "guards → interceptors(pre) → pipes → handler → interceptors(post) → filters",
    guards: stages.guard,
    interceptors: stages.interceptor,
    pipes: stages.pipe,
    filters: stages.filter,
    complete,
    ...(unresolved.length ? { unresolved } : {}),
  };
}

function addLocal(
  store: Store,
  node: FragmentNodeRecord,
  source: string,
  push: (kind: PipelineKind, e: Element) => void,
): void {
  const roles: Array<[PipelineKind, string]> = [
    ["guard", "guards"],
    ["interceptor", "interceptors"],
    ["pipe", "pipes"],
    ["filter", "filters"],
  ];
  for (const [kind, role] of roles) {
    for (const id of asArray(node.refs[role])) {
      const r = symRef(store, id);
      push(kind, { name: r?.name ?? id, symbol: r, source, resolved: true, style: "useX" });
    }
  }
  for (const u of (node.attrs.unresolvedPipeline as Array<{ kind: PipelineKind; text: string }> | undefined) ?? []) {
    push(u.kind, { name: u.text, source, resolved: false, style: "unresolved" });
  }
}

interface ParamPipe {
  className: string | null;
  symbol: string | null;
  resolved: boolean;
  style: string;
}
interface RouteParam {
  name: string;
  in: string;
  pipes?: ParamPipe[];
}

/** Level 5: fold each param decorator's pipe args into the pipe stage, tagged
 *  `source:'param'` and ordered at the tail (Nest's documented order). */
function addParamPipes(
  store: Store,
  route: FragmentNodeRecord,
  push: (kind: PipelineKind, e: Element) => void,
): void {
  for (const p of (route.attrs.params as RouteParam[] | undefined) ?? []) {
    for (const pipe of p.pipes ?? []) {
      const symbol = pipe.symbol ? symRef(store, pipe.symbol) : undefined;
      push("pipe", {
        name: symbol?.name ?? pipe.className ?? "unknown",
        symbol,
        source: "param",
        resolved: pipe.resolved,
        style: pipe.style,
      });
    }
  }
}

function resolveRoute(store: Store, args: Args): FragmentNodeRecord | undefined {
  const route = str(args.route);
  if (route) {
    const n = store.fragment(route);
    if (n && n.kind === "route") return n;
  }
  const handler = str(args.handler);
  if (handler) return store.fragmentsBySymbol(handler, "handler").find((n) => n.kind === "route");
  return undefined;
}

// ---- DI ------------------------------------------------------------------

export function nest_providers(store: Store, args: Args) {
  const moduleFilter = str(args.module);
  const token = str(args.token);
  const scope = str(args.scope)?.toUpperCase();
  let bindings = store.fragments("nest", "provider-binding");
  if (token) bindings = bindings.filter((b) => b.attrs.token === token);
  if (scope) bindings = bindings.filter((b) => String(b.attrs.scope).toUpperCase() === scope);
  if (moduleFilter) bindings = bindings.filter((b) => b.id.endsWith(`@${moduleFilter}`));
  return {
    providers: bindings.map((b) => renderBinding(store, b)),
  };
}

export function nest_resolve_token(store: Store, args: Args) {
  const token = str(args.token);
  if (!token) return { error: "nest_resolve_token requires `token`" };
  const bindings = store.fragments("nest", "provider-binding").filter((b) => b.attrs.token === token);
  if (!bindings.length) return { token, bindings: [], note: "no provider binds this token in the analyzed packages" };
  return { token, bindings: bindings.map((b) => renderBinding(store, b)) };
}

export function nest_injected_into(store: Store, args: Args) {
  const symbol = str(args.symbol);
  const token = str(args.token);
  let bindings: FragmentNodeRecord[] = [];
  if (symbol) bindings = store.fragmentsBySymbol(symbol, "provides").filter((n) => n.kind === "provider-binding");
  if (!bindings.length && token) bindings = store.fragments("nest", "provider-binding").filter((b) => b.attrs.token === token);
  const injectors = new Map<string, Record<string, unknown>>();
  for (const b of bindings) for (const id of asArray(b.refs.injectedInto)) injectors.set(id, symRef(store, id)!);
  return { hits: [...injectors.values()], coverage: { scanned: store.hydratedPackages().length, total: store.counts().packages, unit: "packages", complete: true, note: "DI edges are structural — complete at skeleton" } };
}

function renderBinding(store: Store, b: FragmentNodeRecord) {
  return {
    id: b.id,
    token: b.attrs.token,
    providerType: b.attrs.providerType,
    scope: b.attrs.scope,
    module: symRef(store, first(b.refs.module)),
    provides: symRef(store, first(b.refs.provides)),
    injectedInto: asArray(b.refs.injectedInto).map((i) => symRef(store, i)),
    ...(b.attrs.appHook ? { appHook: b.attrs.appHook } : {}),
  };
}

// ---- modules -------------------------------------------------------------

export function nest_module_graph(store: Store, _args: Args) {
  const modules = store.fragments("nest", "module");
  return {
    modules: modules.map((m) => ({
      id: m.id,
      name: m.attrs.name,
      module: symRef(store, first(m.refs.module)),
      imports: m.attrs.imports,
      controllers: m.attrs.controllers,
      providers: m.attrs.providerTokens,
      exports: m.attrs.exports,
    })),
  };
}

export function nest_module(store: Store, args: Args) {
  const module = str(args.module);
  if (!module) return { error: "nest_module requires `module` (a module name or its fragment id)" };
  const id = module.startsWith("nest:module:") ? module : `nest:module:${module}`;
  const m = store.fragment(id);
  if (!m) return { error: `module not found: ${module}` };
  return {
    id: m.id,
    name: m.attrs.name,
    module: symRef(store, first(m.refs.module)),
    imports: asArray(m.refs.imports).map((i) => symRef(store, i)),
    controllers: asArray(m.refs.controllers).map((c) => symRef(store, c)),
    providers: store.fragments("nest", "provider-binding").filter((b) => b.id.endsWith(`@${m.attrs.name}`)).map((b) => renderBinding(store, b)),
    exports: asArray(m.refs.exports).map((e) => symRef(store, e)),
  };
}
