// Nest adapter build. Reads the parsed
// program's decorators + heritage (already captured by core pass 1) and emits
// nest:* fragment nodes: modules, controllers, routes, provider-bindings, and
// bootstrap global-registrations. Runs at skeleton time — these views are
// decorator-structural and cheap, so no Tier-2 hydration is needed to query
// them. Decorator origin is verified against `@nestjs/*` imports so a
// user-defined `@Get` never masquerades as a route.
import {
  Node,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type SourceFile,
} from "ts-morph";
import type { AdapterContext, FragmentNodeRecord, Span } from "@codehead-pl/tsca-core";
import { buildGraphql } from "./graphql.ts";
import { buildMessaging } from "./messaging.ts";

const HTTP_METHODS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Delete: "DELETE",
  Patch: "PATCH",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "ALL",
};

const PARAM_IN: Record<string, string> = {
  Body: "body",
  Param: "param",
  Query: "query",
  Headers: "headers",
  Req: "request",
  Request: "request",
  Res: "response",
  Response: "response",
  Session: "session",
  Ip: "ip",
  HostParam: "host",
};

// APP_* DI token → pipeline stage.
const APP_TOKEN_KIND: Record<string, PipelineKind> = {
  APP_GUARD: "guard",
  APP_INTERCEPTOR: "interceptor",
  APP_PIPE: "pipe",
  APP_FILTER: "filter",
};

// useGlobalX bootstrap method → pipeline stage.
const USE_GLOBAL_KIND: Record<string, PipelineKind> = {
  useGlobalGuards: "guard",
  useGlobalPipes: "pipe",
  useGlobalInterceptors: "interceptor",
  useGlobalFilters: "filter",
};

// @UseX decorator → pipeline stage (guards/interceptors/pipes/filters).
const USE_DECORATOR_KIND: Record<string, PipelineKind> = {
  UseGuards: "guard",
  UseInterceptors: "interceptor",
  UsePipes: "pipe",
  UseFilters: "filter",
};

type PipelineKind = "guard" | "interceptor" | "pipe" | "filter";

interface Injection {
  injector: string; // class SymbolId whose constructor receives it
  tokenText: string; // @Inject token or the param type head name
  typeSymbol: string | null; // resolved param-type SymbolId
}

export function build(ctx: AdapterContext): void {
  const files = ctx.project.getSourceFiles().filter((sf) => ctx.inPackage(sf));
  const importMaps = new Map<SourceFile, Map<string, string>>();
  const importSource = (sf: SourceFile, name: string): string | undefined => {
    let m = importMaps.get(sf);
    if (!m) {
      m = buildImportMap(sf);
      importMaps.set(sf, m);
    }
    return m.get(name);
  };
  const isNest = (sf: SourceFile, decName: string): boolean => (importSource(sf, decName) ?? "").startsWith("@nestjs/");
  const sym = (node: Node): string | undefined => ctx.symbolIdOf(node);
  const isClassSym = (id: string): boolean => ctx.index.info.get(id)?.kind === "class";

  // ---- pass 1: classify classes ----------------------------------------
  const modules: ClassDeclaration[] = [];
  const controllers: ClassDeclaration[] = [];
  const injectables: ClassDeclaration[] = []; // DI-managed classes (own a ctor to scan)
  for (const sf of files) {
    for (const cls of sf.getClasses()) {
      if (cls.getDecorator("Module") && isNest(sf, "Module")) modules.push(cls);
      if (cls.getDecorator("Controller") && isNest(sf, "Controller")) controllers.push(cls);
      if ((cls.getDecorator("Injectable") && isNest(sf, "Injectable")) || cls.getDecorator("Controller")) injectables.push(cls);
    }
  }

  // ---- injection index (across every DI-managed class) ------------------
  const injections: Injection[] = [];
  for (const cls of injectables) {
    const clsId = sym(cls);
    if (!clsId) continue;
    const sf = cls.getSourceFile();
    const resolve = ctx.resolveName(sf);
    const ctor = cls.getConstructors()[0];
    if (!ctor) continue;
    for (const p of ctor.getParameters()) {
      const inj = p.getDecorator("Inject");
      const tokenText = inj ? tokenOf(firstArg(inj)) : typeHead(p);
      if (!tokenText) continue;
      const th = typeHead(p);
      const typeSymbol = th ? nonExternal(resolve(th)) : null;
      injections.push({ injector: clsId, tokenText, typeSymbol });
    }
  }

  // ---- modules + provider entries --------------------------------------
  const providerModule = new Map<string, string>(); // tokenText -> module name (for nest_resolve_token)
  const bindings: Array<{ node: FragmentNodeRecord; token: string; providesSymbol: string | null }> = [];
  const controllerModule = new Map<string, string>(); // controller SymbolId -> module SymbolId

  for (const cls of modules) {
    const moduleId = sym(cls);
    if (!moduleId) continue;
    const sf = cls.getSourceFile();
    const fid = ctx.fileIdOf(sf);
    const resolve = ctx.resolveName(sf);
    const modName = cls.getName() ?? "default";
    const obj = firstObjectArg(cls.getDecorator("Module"));
    const importEls = arrayProp(obj, "imports");
    const controllerEls = arrayProp(obj, "controllers");
    const providerEls = arrayProp(obj, "providers");
    const exportEls = arrayProp(obj, "exports");

    const importSyms = importEls.map((e) => nonExternal(resolve(className(e) ?? ""))).filter(nn);
    const controllerSyms = controllerEls.map((e) => nonExternal(resolve(className(e) ?? ""))).filter(nn);
    for (const cid of controllerSyms) controllerModule.set(cid, moduleId);

    const providerTokens: string[] = [];
    for (const el of providerEls) {
      const parsed = parseProvider(el);
      if (!parsed) continue;
      providerTokens.push(parsed.token);
      providerModule.set(parsed.token, modName);
      const providesSymbol = parsed.provideClassName ? nonExternal(resolve(parsed.provideClassName)) : null;
      const injectedInto = [
        ...new Set(
          injections
            .filter((j) => j.tokenText === parsed.token || (providesSymbol && j.typeSymbol === providesSymbol))
            .map((j) => j.injector),
        ),
      ];
      const app = APP_TOKEN_KIND[parsed.token];
      const refs: FragmentNodeRecord["refs"] = { module: moduleId };
      if (providesSymbol) refs.provides = providesSymbol;
      if (injectedInto.length) refs.injectedInto = injectedInto;
      const node: FragmentNodeRecord = {
        id: `nest:provide:${parsed.token}@${modName}`,
        adapter: "nest",
        kind: "provider-binding",
        attrs: {
          token: parsed.token,
          providerType: parsed.providerType,
          scope: parsed.scope ?? providerScope(providesSymbol, ctx) ?? "DEFAULT",
          className: parsed.provideClassName ?? null,
          ...(app ? { appHook: parsed.token, pipelineKind: app } : {}),
        },
        refs,
        span: parsed.span,
        provenance: fid ? [fid] : [],
      };
      bindings.push({ node, token: parsed.token, providesSymbol });
    }

    const exportSyms = exportEls.map((e) => nonExternal(resolve(className(e) ?? ""))).filter(nn);
    const moduleRefs: FragmentNodeRecord["refs"] = { module: moduleId };
    if (importSyms.length) moduleRefs.imports = importSyms;
    if (controllerSyms.length) moduleRefs.controllers = controllerSyms;
    if (exportSyms.length) moduleRefs.exports = exportSyms;
    ctx.store.upsertFragment({
      id: `nest:module:${modName}`,
      adapter: "nest",
      kind: "module",
      attrs: {
        name: modName,
        imports: importEls.map((e) => className(e) ?? e.getText()),
        controllers: controllerEls.map((e) => className(e) ?? e.getText()),
        providerTokens,
        exports: exportEls.map((e) => className(e) ?? e.getText()),
      },
      refs: moduleRefs,
      span: spanOf(cls),
      provenance: fid ? [fid] : [],
    });
  }

  for (const b of bindings) ctx.store.upsertFragment(b.node);

  // ---- controllers + routes --------------------------------------------
  for (const cls of controllers) {
    const ctrlId = sym(cls);
    if (!ctrlId) continue;
    const sf = cls.getSourceFile();
    const fid = ctx.fileIdOf(sf);
    const resolve = ctx.resolveName(sf);
    const name = cls.getName() ?? "default";
    const basePath = controllerBasePath(cls.getDecorator("Controller"));

    // controller-level pipeline decorators
    const ctrlPipeline = pipelineRefsOf(cls, resolve, isClassSym);
    const ctrlRefs: FragmentNodeRecord["refs"] = { controller: ctrlId };
    const declModule = controllerModule.get(ctrlId);
    if (declModule) ctrlRefs.module = declModule;
    mergePipelineRefs(ctrlRefs, ctrlPipeline);

    let routeCount = 0;
    for (const m of cls.getMethods()) {
      const routeDec = m.getDecorators().find((d) => HTTP_METHODS[d.getName()] && isNest(sf, d.getName()));
      if (!routeDec) continue;
      routeCount += 1;
      const handlerId = sym(m);
      const method = HTTP_METHODS[routeDec.getName()];
      const methodPath = firstStringArg(routeDec) ?? "";
      const fullPath = joinPath(basePath, methodPath);

      const params = m.getParameters().map((p) => paramInfo(p, resolve));
      const methodPipeline = pipelineRefsOf(m, resolve, isClassSym);
      const refs: FragmentNodeRecord["refs"] = { controller: ctrlId };
      if (handlerId) refs.handler = handlerId;
      const dtoSyms = params.map((p) => p.dto).filter(nn);
      if (dtoSyms.length) refs.dto = dtoSyms;
      mergePipelineRefs(refs, methodPipeline);

      const routeId = `nest:route:${method} ${fullPath}`;
      ctx.store.upsertFragment({
        id: routeId,
        adapter: "nest",
        kind: "route",
        attrs: {
          method,
          path: fullPath,
          controller: name,
          handler: m.getName(),
          params: params.map((p) => ({ name: p.name, in: p.in, key: p.key, type: p.type, ...(p.pipes.length ? { pipes: p.pipes } : {}) })),
          returns: m.getReturnTypeNode()?.getText() ?? null,
          unresolvedPipeline: [...ctrlPipeline.unresolved, ...methodPipeline.unresolved],
        },
        refs,
        span: spanOf(m),
        provenance: fid ? [fid] : [],
      });

      if (handlerId && fid) {
        ctx.store.upsertEntrypoint({
          id: `route-handler:${method} ${fullPath}`,
          kind: "route-handler",
          source: "nest",
          symbol: handlerId,
          detail: { method, path: fullPath, controller: name },
          file: fid,
        });
      }
    }

    ctx.store.upsertFragment({
      id: `nest:controller:${name}`,
      adapter: "nest",
      kind: "controller",
      attrs: { name, basePath, routeCount, unresolvedPipeline: ctrlPipeline.unresolved },
      refs: ctrlRefs,
      span: spanOf(cls),
      provenance: fid ? [fid] : [],
    });
  }

  // ---- bootstrap global registrations (useGlobalX in main.ts) ----------
  let seq = 0;
  for (const sf of files) {
    const resolve = ctx.resolveName(sf);
    const fid = ctx.fileIdOf(sf);
    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const e = node.getExpression();
      if (!Node.isPropertyAccessExpression(e)) return;
      const kind = USE_GLOBAL_KIND[e.getName()];
      if (!kind) return;
      for (const arg of node.getArguments()) {
        const r = resolvePipelineArg(arg, resolve);
        const refs: FragmentNodeRecord["refs"] = {};
        if (r.symbol) refs.provides = r.symbol;
        ctx.store.upsertFragment({
          id: `nest:global:${kind}:${ctx.pkg.name}:${seq++}`,
          adapter: "nest",
          kind: "global-registration",
          attrs: {
            pipelineKind: kind,
            className: r.className,
            style: r.style,
            resolved: r.resolved,
            source: "global-bootstrap",
            at: fid ? `${relOf(fid)}:${lineOf(arg)}` : null,
          },
          refs,
          span: spanOf(arg),
          provenance: fid ? [fid] : [],
        });
      }
    });
  }

  // ---- GraphQL sub-adapter (gated on @nestjs/graphql) -------------------
  // Only runs when this package depends on @nestjs/graphql. Emits nest:graphql
  // fragments (resolvers, ops, field resolvers) and records a feature flag so
  // the daemon can detection-gate the `nest_graphql` tool via /manifest.
  if (ctx.pkg.dependencies.includes("@nestjs/graphql")) {
    const emitted = buildGraphql(ctx);
    if (emitted) ctx.store.setMeta("nest:graphql", "true");
  }

  // ---- messaging sub-adapter (gated on @nestjs/microservices / BullMQ) --
  // Runs when the package depends on @nestjs/microservices and/or BullMQ
  // (@nestjs/bullmq / @nestjs/bull / bullmq / bull). Emits nest:messaging
  // fragments (message/event handlers, BullMQ processors) and records a feature
  // flag so the daemon can detection-gate the `nest_messaging` tool via /manifest.
  const MSG_DEPS = ["@nestjs/microservices", "@nestjs/bullmq", "@nestjs/bull", "bullmq", "bull"];
  if (MSG_DEPS.some((d) => ctx.pkg.dependencies.includes(d))) {
    const emitted = buildMessaging(ctx);
    if (emitted) ctx.store.setMeta("nest:messaging", "true");
  }
}

// ---- provider parsing ----------------------------------------------------

interface ParsedProvider {
  token: string;
  providerType: "useClass" | "useValue" | "useFactory" | "useExisting";
  provideClassName: string | null;
  scope: string | null;
  span: Span | null;
}

function parseProvider(el: Expression): ParsedProvider | null {
  if (Node.isObjectLiteralExpression(el)) {
    const provide = propInit(el, "provide");
    if (!provide) return null;
    const token = tokenOf(provide);
    if (!token) return null;
    const useClass = propInit(el, "useClass");
    const useExisting = propInit(el, "useExisting");
    const useFactory = propInit(el, "useFactory");
    const scopeInit = propInit(el, "scope");
    const scope = scopeInit ? scopeName(scopeInit.getText()) : null;
    if (useClass) return { token, providerType: "useClass", provideClassName: className(useClass), scope, span: spanOf(el) };
    if (useExisting) return { token, providerType: "useExisting", provideClassName: className(useExisting), scope, span: spanOf(el) };
    if (useFactory) return { token, providerType: "useFactory", provideClassName: null, scope, span: spanOf(el) };
    return { token, providerType: "useValue", provideClassName: null, scope, span: spanOf(el) };
  }
  // bare class reference -> useClass with token = class name
  const name = className(el);
  if (!name) return null;
  return { token: name, providerType: "useClass", provideClassName: name, scope: null, span: spanOf(el) };
}

function providerScope(providesSymbol: string | null, ctx: AdapterContext): string | null {
  if (!providesSymbol) return null;
  const s = ctx.store.getSymbol(providesSymbol);
  const inj = s?.extra.decorators?.find((d) => d.name === "Injectable");
  const arg = inj?.args?.[0];
  if (!arg) return null;
  const m = arg.match(/scope:\s*(?:Scope\.)?(\w+)/);
  return m ? m[1].toUpperCase() : null;
}

// ---- routes / params -----------------------------------------------------

export interface ParamPipe {
  className: string | null;
  symbol: string | null;
  resolved: boolean;
  style: "new" | "ref" | "unresolved";
}

interface ParamInfo {
  name: string;
  in: string;
  key: string | null;
  type: string | null;
  dto: string | null;
  pipes: ParamPipe[];
}

function paramInfo(p: ParameterDeclaration, resolve: (n: string) => string | null): ParamInfo {
  const dec = p.getDecorators().find((d) => PARAM_IN[d.getName()]);
  const where = dec ? PARAM_IN[dec.getName()] : "arg";
  const key = dec ? firstStringArg(dec) : null;
  const type = p.getTypeNode()?.getText() ?? null;
  const th = typeHead(p);
  const dto = th ? nonExternal(resolve(th)) : null;
  // Param-level pipes: every decorator arg that isn't the leading string key
  // (@Param('id', ParseIntPipe), @Body(new ValidationPipe())). A bare class ref
  // resolves via DI; a `new X()` is manual/no-DI; an unknown value is honest.
  const pipes: ParamPipe[] = [];
  if (dec) {
    for (const arg of dec.getArguments()) {
      if (Node.isStringLiteral(arg)) continue; // the param key, not a pipe
      const r = resolvePipelineArg(arg, resolve);
      pipes.push({ className: r.className, symbol: r.symbol ?? null, resolved: r.resolved, style: r.style });
    }
  }
  return { name: p.getName(), in: where, key, type, dto, pipes };
}

// ---- pipeline decorators (@UseGuards etc.) ------------------------------

export interface PipelineRefs {
  guard: string[];
  interceptor: string[];
  pipe: string[];
  filter: string[];
  unresolved: Array<{ kind: PipelineKind; text: string }>;
}

function emptyPipeline(): PipelineRefs {
  return { guard: [], interceptor: [], pipe: [], filter: [], unresolved: [] };
}

export function pipelineRefsOf(
  node: { getDecorators(): Decorator[] },
  resolve: (n: string) => string | null,
  _isClassSym: (id: string) => boolean,
): PipelineRefs {
  const out = emptyPipeline();
  for (const d of node.getDecorators()) {
    const kind = USE_DECORATOR_KIND[d.getName()];
    if (!kind) continue;
    for (const arg of d.getArguments()) {
      const r = resolvePipelineArg(arg, resolve);
      if (r.symbol) out[kind].push(r.symbol);
      else if (!r.resolved) out.unresolved.push({ kind, text: r.className ?? arg.getText().slice(0, 40) });
      // resolved-but-external (framework class): recorded via className, no symbol join
    }
  }
  return out;
}

export function mergePipelineRefs(refs: FragmentNodeRecord["refs"], p: PipelineRefs): void {
  if (p.guard.length) refs.guards = p.guard;
  if (p.interceptor.length) refs.interceptors = p.interceptor;
  if (p.pipe.length) refs.pipes = p.pipe;
  if (p.filter.length) refs.filters = p.filter;
}

interface PipelineArgResolution {
  className: string | null;
  symbol?: string; // core SymbolId when it resolves to a project class
  resolved: boolean; // false only when we can't determine which class runs
  style: "new" | "ref" | "unresolved";
}

/** Resolve a guard/pipe/interceptor/filter argument. `new X()` and bare class
 *  refs resolve statically (we know the class name even if it's a framework
 *  class with no project symbol); a value from a factory/variable we can't see
 *  is honestly `unresolved`. */
export function resolvePipelineArg(arg: Node, resolve: (n: string) => string | null): PipelineArgResolution {
  if (Node.isNewExpression(arg)) {
    const name = className(arg.getExpression());
    if (!name) return { className: null, resolved: false, style: "unresolved" };
    const sym = nonExternal(resolve(name));
    return { className: name, symbol: sym ?? undefined, resolved: true, style: "new" };
  }
  if (Node.isIdentifier(arg)) {
    const name = arg.getText();
    const target = resolve(name);
    if (!target) return { className: name, resolved: false, style: "unresolved" };
    const sym = nonExternal(target);
    return { className: name, symbol: sym ?? undefined, resolved: true, style: "ref" };
  }
  return { className: arg.getText().slice(0, 40), resolved: false, style: "unresolved" };
}

// ---- small AST helpers ---------------------------------------------------

export function buildImportMap(sf: SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of sf.getImportDeclarations()) {
    const mod = imp.getModuleSpecifierValue();
    for (const ni of imp.getNamedImports()) map.set(ni.getAliasNode()?.getText() ?? ni.getName(), mod);
    const def = imp.getDefaultImport();
    if (def) map.set(def.getText(), mod);
  }
  return map;
}

function firstObjectArg(dec: Decorator | undefined): ObjectLiteralExpression | undefined {
  const a = dec?.getArguments()[0];
  return a && Node.isObjectLiteralExpression(a) ? a : undefined;
}

function firstArg(dec: Decorator): Node | undefined {
  return dec.getArguments()[0];
}

export function firstStringArg(dec: Decorator): string | null {
  for (const a of dec.getArguments()) {
    if (Node.isStringLiteral(a)) return a.getLiteralValue();
  }
  return null;
}

function arrayProp(obj: ObjectLiteralExpression | undefined, name: string): Expression[] {
  if (!obj) return [];
  const init = propInit(obj, name);
  if (init && Node.isArrayLiteralExpression(init)) return init.getElements();
  return [];
}

export function propInit(obj: ObjectLiteralExpression, name: string): Expression | undefined {
  const p = obj.getProperty(name);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode() as unknown as Expression;
  return undefined;
}

/** Token text for a `provide:` value or `@Inject(...)` arg. */
function tokenOf(node: Node | undefined): string {
  if (!node) return "";
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  return node.getText();
}

/** Leftmost class identifier of a class reference: `X`, `new X()`,
 *  `X.forRoot()`, `mod.X` all reduce to their base name. */
export function className(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isNewExpression(node)) return className(node.getExpression());
  if (Node.isCallExpression(node)) return className(node.getExpression());
  if (Node.isPropertyAccessExpression(node)) return className(node.getExpression());
  if (Node.isExpressionWithTypeArguments(node)) return className(node.getExpression());
  return null;
}

function controllerBasePath(dec: Decorator | undefined): string {
  if (!dec) return "";
  const a = dec.getArguments()[0];
  if (!a) return "";
  if (Node.isStringLiteral(a)) return a.getLiteralValue();
  if (Node.isObjectLiteralExpression(a)) {
    const path = propInit(a, "path");
    if (path && Node.isStringLiteral(path)) return path.getLiteralValue();
  }
  return "";
}

export function typeHead(p: ParameterDeclaration): string | null {
  const t = p.getTypeNode()?.getText();
  if (!t) return null;
  const noGenerics = t.replace(/<[\s\S]*>/, "").trim();
  const seg = noGenerics.split(".").pop() ?? noGenerics;
  const m = seg.match(/[A-Za-z0-9_$]+/);
  return m ? m[0] : null;
}

function joinPath(base: string, path: string): string {
  const b = `/${base}`.replace(/\/+/g, "/").replace(/\/$/, "");
  const p = path ? `/${path}`.replace(/\/+/g, "/") : "";
  const joined = `${b}${p}`.replace(/\/+/g, "/");
  return joined === "" ? "/" : joined.replace(/(.)\/$/, "$1");
}

function scopeName(text: string): string {
  const m = text.match(/(\w+)$/);
  return m ? m[1].toUpperCase() : text.toUpperCase();
}

export function nonExternal(id: string | null): string | null {
  return id && !id.startsWith("external:") ? id : null;
}

export function nn<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

export function spanOf(node: Node): Span {
  const sf = node.getSourceFile();
  const s = sf.getLineAndColumnAtPos(node.getStart());
  const e = sf.getLineAndColumnAtPos(node.getEnd());
  return { startLine: s.line, startCol: s.column, endLine: e.line, endCol: e.column };
}

function lineOf(node: Node): number {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart()).line;
}

function relOf(fid: string): string {
  return fid.slice(fid.indexOf("|") + 1);
}
