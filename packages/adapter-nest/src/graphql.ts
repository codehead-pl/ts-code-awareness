// Nest GraphQL sub-adapter. Gated on
// `@nestjs/graphql` in the package's deps. Like the rest of the Nest adapter this
// is decorator-structural (no Tier-2): it reads `@Resolver`/`@Query`/`@Mutation`/
// `@Subscription`/`@ResolveField` off classes already parsed by core pass 1 and
// emits `nest:graphql` fragments:
//   - `graphql-resolver`  — an `@Resolver(Type)` class, with its object type and
//                            any class-level @UseGuards/etc. pipeline.
//   - `graphql-op`        — a query/mutation/subscription/field handler, with its
//                            return type, handler symbol, parent object type, and
//                            `@Args` params linked to DTO types (like route params).
// Decorator origin is verified against the `@nestjs/graphql` import so a
// user-defined `@Query` never masquerades as a resolver op. `graphql-resolver`
// entrypoints are populated per op; pipeline composition (nest_pipeline_for)
// accepts a resolver handler by reading the same pipeline refs the routes use.
import {
  Node,
  type ClassDeclaration,
  type Decorator,
  type ParameterDeclaration,
  type SourceFile,
} from "ts-morph";
import type { AdapterContext, FragmentNodeRecord } from "@codehead-pl/tsca-core";
import {
  buildImportMap,
  className,
  firstStringArg,
  mergePipelineRefs,
  nonExternal,
  pipelineRefsOf,
  propInit,
  spanOf,
  typeHead,
  nn,
} from "./build.ts";

// GraphQL operation decorator → the kind we record on the fragment.
const OP_KIND: Record<string, "query" | "mutation" | "subscription" | "field"> = {
  Query: "query",
  Mutation: "mutation",
  Subscription: "subscription",
  ResolveField: "field",
  ResolveProperty: "field", // Nest <=7 alias
};

// GraphQL param decorator → its `in` slot (mirrors REST PARAM_IN).
const GQL_PARAM_IN: Record<string, string> = {
  Args: "args",
  Parent: "parent",
  Root: "parent",
  Context: "context",
  Info: "info",
};

interface GqlParam {
  name: string;
  in: string;
  key: string | null;
  type: string | null;
  dto: string | null;
}

/** Emit `nest:graphql` fragments for one package. Returns true when at least one
 *  `@Resolver` class was found (so the caller can set the detection flag). */
export function buildGraphql(ctx: AdapterContext): boolean {
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
  const isGql = (sf: SourceFile, decName: string): boolean => (importSource(sf, decName) ?? "").startsWith("@nestjs/graphql");
  const sym = (node: Node): string | undefined => ctx.symbolIdOf(node);
  const isClassSym = (id: string): boolean => ctx.index.info.get(id)?.kind === "class";

  let found = false;
  for (const sf of files) {
    for (const cls of sf.getClasses()) {
      const resolverDec = cls.getDecorator("Resolver");
      if (!resolverDec || !isGql(sf, "Resolver")) continue;
      found = true;
      emitResolver(ctx, cls, resolverDec, sf, isGql, sym, isClassSym);
    }
  }
  return found;
}

function emitResolver(
  ctx: AdapterContext,
  cls: ClassDeclaration,
  resolverDec: Decorator,
  sf: SourceFile,
  isGql: (sf: SourceFile, name: string) => boolean,
  sym: (node: Node) => string | undefined,
  isClassSym: (id: string) => boolean,
): void {
  const clsId = sym(cls);
  if (!clsId) return;
  const fid = ctx.fileIdOf(sf);
  const resolve = ctx.resolveName(sf);
  const name = cls.getName() ?? "default";
  const objectType = gqlTypeArg(resolverDec);
  const objectTypeSym = objectType ? nonExternal(resolve(headOfType(objectType) ?? "")) : null;

  // Resolver-class-level pipeline (@UseGuards on the class) — the resolver plays
  // the "controller" role for pipeline composition.
  const clsPipeline = pipelineRefsOf(cls, resolve, isClassSym);
  const clsRefs: FragmentNodeRecord["refs"] = { resolver: clsId };
  if (objectTypeSym) clsRefs.objectType = objectTypeSym;
  mergePipelineRefs(clsRefs, clsPipeline);

  let opCount = 0;
  for (const m of cls.getMethods()) {
    const opDec = m.getDecorators().find((d) => OP_KIND[d.getName()] && isGql(sf, d.getName()));
    if (!opDec) continue;
    opCount += 1;
    const graphqlKind = OP_KIND[opDec.getName()];
    const handlerId = sym(m);
    const field = gqlFieldName(opDec, m.getName());
    const returns = gqlTypeArg(opDec) ?? m.getReturnTypeNode()?.getText() ?? null;
    const returnSym = returns ? nonExternal(resolve(headOfType(returns) ?? "")) : null;
    const params = m.getParameters().map((p) => gqlParamInfo(p, resolve));

    const opPipeline = pipelineRefsOf(m, resolve, isClassSym);
    const refs: FragmentNodeRecord["refs"] = { resolver: clsId };
    if (handlerId) refs.handler = handlerId;
    const dtoSyms = [...params.map((p) => p.dto), returnSym].filter(nn);
    if (dtoSyms.length) refs.dto = [...new Set(dtoSyms)];
    mergePipelineRefs(refs, opPipeline);

    const opId = `nest:graphql:op:${name}.${m.getName()}`;
    ctx.store.upsertFragment({
      id: opId,
      adapter: "nest",
      kind: "graphql-op",
      attrs: {
        graphqlKind,
        field,
        resolver: name,
        handler: m.getName(),
        returns,
        objectType,
        params: params.map((p) => ({ name: p.name, in: p.in, key: p.key, type: p.type })),
        unresolvedPipeline: [...clsPipeline.unresolved, ...opPipeline.unresolved],
      },
      refs,
      span: spanOf(m),
      provenance: fid ? [fid] : [],
    });

    if (handlerId && fid) {
      ctx.store.upsertEntrypoint({
        id: `graphql-resolver:${graphqlKind} ${name}.${field}`,
        kind: "graphql-resolver",
        source: "nest",
        symbol: handlerId,
        detail: { graphqlKind, field, resolver: name, objectType },
        file: fid,
      });
    }
  }

  ctx.store.upsertFragment({
    id: `nest:graphql:resolver:${name}`,
    adapter: "nest",
    kind: "graphql-resolver",
    attrs: { name, objectType, opCount, unresolvedPipeline: clsPipeline.unresolved },
    refs: clsRefs,
    span: spanOf(cls),
    provenance: fid ? [fid] : [],
  });
}

// ---- GraphQL AST helpers -------------------------------------------------

/** Extract a GraphQL type from a decorator's leading type-function arg:
 *  `@Query(() => [User])` → "[User]", `@Resolver(() => User)` → "User",
 *  `@Resolver(User)` → "User", `@Resolver('User')` → "User". */
function gqlTypeArg(dec: Decorator): string | null {
  const a = dec.getArguments()[0];
  if (!a) return null;
  if (Node.isStringLiteral(a)) return null; // a string is a field name, not a type
  if (Node.isArrowFunction(a)) return a.getBody().getText();
  if (Node.isIdentifier(a)) return a.getText();
  if (Node.isArrayLiteralExpression(a)) return a.getText();
  return null;
}

/** The exposed GraphQL field name: an explicit string arg or `{ name }` option,
 *  else the handler method name. */
function gqlFieldName(dec: Decorator, methodName: string): string {
  const args = dec.getArguments();
  for (const a of args) if (Node.isStringLiteral(a)) return a.getLiteralValue();
  for (const a of args) {
    if (Node.isObjectLiteralExpression(a)) {
      const n = propInit(a, "name");
      if (n && Node.isStringLiteral(n)) return n.getLiteralValue();
    }
  }
  return methodName;
}

function gqlParamInfo(p: ParameterDeclaration, resolve: (n: string) => string | null): GqlParam {
  const dec = p.getDecorators().find((d) => GQL_PARAM_IN[d.getName()]);
  const where = dec ? GQL_PARAM_IN[dec.getName()] : "arg";
  const key = dec ? firstStringArg(dec) : null;
  const type = p.getTypeNode()?.getText() ?? null;
  const th = typeHead(p);
  const dto = th ? nonExternal(resolve(th)) : null;
  return { name: p.getName(), in: where, key, type, dto };
}

/** Head identifier of a GraphQL type text: strips `[]`/`!`/generics.
 *  "[User]" → "User", "User!" → "User". */
function headOfType(text: string): string | null {
  const m = text.replace(/[[\]!]/g, "").trim().match(/[A-Za-z0-9_$]+/);
  return m ? m[0] : null;
}
