// Prisma adapter build. Two contributions:
//   1. schema.prisma → prisma:model / prisma:enum fragments (the ER model).
//   2. the model↔code bridge — prisma:access nodes recognized from client call
//      sites in *project source* (never the generated client): `<recv>.<delegate>
//      .<op>(args)` where the delegate maps to a schema model and the op is a
//      known Prisma op. Fields come from the argument object's keys; rw from the
//      op; confidence is `typed` when the receiver's type reaches PrismaClient,
//      else `heuristic`. Plus $queryRaw capture and a static migration report.
import { Node, SyntaxKind, type ClassDeclaration, type Expression, type SourceFile } from "ts-morph";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { AdapterContext, FragmentNodeRecord, Span, Workspace } from "@codehead-pl/tsca-core";
import { parseSchema, type ParsedSchema, type PrismaModel } from "./schema.ts";

const READ_OPS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const WRITE_OPS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);
// Maps, not plain objects: a plain-object lookup like `RAW_CALLS["toLocaleString"]`
// would resolve to `Object.prototype.toLocaleString` (and `toString`, `valueOf`,
// `constructor`, `hasOwnProperty`, …) — a truthy inherited function — and falsely
// capture those ordinary call sites as raw queries.
const RAW_TAGS = new Map<string, "queryRaw" | "executeRaw">([
  ["$queryRaw", "queryRaw"],
  ["$executeRaw", "executeRaw"],
]);
const RAW_CALLS = new Map<string, "queryRaw" | "executeRaw">([
  ["$queryRawUnsafe", "queryRaw"],
  ["$executeRawUnsafe", "executeRaw"],
]);

/** Transitive workspace-dependency closure of a package (incl. itself). */
export function packageClosure(ws: Workspace, pkg: string): Set<string> {
  const byName = new Map(ws.packages.map((p) => [p.name, p]));
  const out = new Set<string>();
  const stack = [pkg];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    for (const d of byName.get(n)?.workspaceDeps ?? []) stack.push(d);
  }
  return out;
}

const pkgOfFid = (fid: string): string => fid.slice(0, fid.indexOf("|"));

export function build(ctx: AdapterContext): void {
  const byName = new Map(ctx.workspace.packages.map((p) => [p.name, p]));
  const closure = packageClosure(ctx.workspace, ctx.pkg.name);

  // Schema files reachable from this package: its own, plus those owned by any
  // package in its workspace-dependency closure. In a split monorepo the schema
  // lives in a `db`/`shared` package while the client is consumed elsewhere, so
  // a consumer must reach the schema through the closure to recognize its calls.
  const closureSchemaFiles: string[] = [];
  for (const name of closure) {
    const p = byName.get(name);
    if (p) for (const s of findSchemas(p.root)) closureSchemaFiles.push(s);
  }
  if (!closureSchemaFiles.length) return;

  const parsed: ParsedSchema = { models: [], enums: [] };
  for (const abs of closureSchemaFiles) {
    const p = parseSchema(readFileSync(abs, "utf8"));
    parsed.models.push(...p.models);
    parsed.enums.push(...p.enums);
  }
  const modelNames = new Set(parsed.models.map((m) => m.name));

  // delegate (camelCase) -> model, for call-site recognition
  const delegateToModel = new Map<string, PrismaModel>();
  for (const m of parsed.models) delegateToModel.set(lowerFirst(m.name), m);

  // ---- schema-owned fragments (models / enums / migrations) ------------
  // Only the package that physically holds the schema emits these, so consumer
  // packages that reach the schema through the closure don't duplicate them.
  if (findSchemas(ctx.pkg.root).length) emitSchema(ctx, modelNames);

  // ---- model↔code bridge (prisma:access + prisma:raw) ------------------
  // Recognized in THIS package's own sources (fragments carry file provenance,
  // so each package owns the access/raw nodes for its own call sites). The
  // PrismaClient-heritage fixpoint is computed across the closure so a
  // `PrismaService extends PrismaClient` defined in the schema package still
  // types receivers in the consumer packages.
  const closureFiles = ctx.project.getSourceFiles().filter((sf) => {
    const fid = ctx.fileIdOf(sf);
    return !!fid && closure.has(pkgOfFid(fid));
  });
  const clientTypes = clientTypeSet(closureFiles);
  const files = closureFiles.filter((sf) => ctx.inPackage(sf));
  let accessSeq = 0;
  let rawSeq = 0;

  for (const sf of files) {
    const fid = ctx.fileIdOf(sf);
    sf.forEachDescendant((node) => {
      // raw queries: tagged template `this.prisma.$queryRaw`...`` or *Unsafe(sql)
      if (Node.isTaggedTemplateExpression(node)) {
        const tag = node.getTag();
        const tagKind = Node.isPropertyAccessExpression(tag) ? RAW_TAGS.get(tag.getName()) : undefined;
        if (tagKind) emitRaw(ctx, node, tagKind, node.getTemplate().getText(), rawSeq++, fid);
        return;
      }
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      const op = expr.getName();

      const rawKind = RAW_CALLS.get(op);
      if (rawKind) {
        const arg = node.getArguments()[0];
        emitRaw(ctx, node, rawKind, arg ? arg.getText() : "", rawSeq++, fid);
        return;
      }
      if (!READ_OPS.has(op) && !WRITE_OPS.has(op)) return;
      const delegateAccess = expr.getExpression();
      if (!Node.isPropertyAccessExpression(delegateAccess)) return;
      const model = delegateToModel.get(delegateAccess.getName());
      if (!model) return;

      const clientRecv = delegateAccess.getExpression();
      const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
      const confidence = confidenceOf(clientRecv, cls, clientTypes);
      const rw = READ_OPS.has(op) ? "read" : "write";
      const fields = argFields(node.getArguments()[0], new Set(model.fields.map((f) => f.name)));
      const caller = enclosingCallable(ctx, node);
      const refs: FragmentNodeRecord["refs"] = {};
      if (caller) refs.caller = caller;

      ctx.store.upsertFragment({
        id: `prisma:access:${caller ?? fid ?? "?"}#${accessSeq++}`,
        adapter: "prisma",
        kind: "access",
        attrs: { model: model.name, modelNode: `prisma:model:${model.name}`, op, rw, fields, confidence },
        refs,
        span: spanOf(node),
        provenance: fid ? [fid] : [],
      });
    });
  }
}

/** Emit the schema-owned fragments (model / enum / migration) for the package
 *  that physically holds the schema files at `ctx.pkg.root`. */
function emitSchema(ctx: AdapterContext, closureModelNames: Set<string>): void {
  const schemaFiles = findSchemas(ctx.pkg.root);
  const parsed: ParsedSchema = { models: [], enums: [] };
  let newestSchemaMtime = 0;
  const schemaProvenance: string[] = [];
  for (const abs of schemaFiles) {
    const p = parseSchema(readFileSync(abs, "utf8"));
    parsed.models.push(...p.models);
    parsed.enums.push(...p.enums);
    newestSchemaMtime = Math.max(newestSchemaMtime, safeMtime(abs));
    schemaProvenance.push(synthId(ctx.pkg.name, ctx.pkg.root, abs));
  }
  const modelNames = closureModelNames;
  const clientStale = computeClientStale(ctx.pkg.root, ctx.projectRoot, newestSchemaMtime);

  // ---- model + enum fragments ------------------------------------------
  for (const m of parsed.models) {
    ctx.store.upsertFragment({
      id: `prisma:model:${m.name}`,
      adapter: "prisma",
      kind: "model",
      attrs: {
        name: m.name,
        table: m.table,
        idFields: m.idFields,
        fields: m.fields.map((f) => ({
          name: f.name,
          type: f.type,
          dbType: f.dbType,
          nullable: f.optional,
          isId: f.isId,
          isUnique: f.isUnique,
          isList: f.isList,
          isRelation: modelNames.has(f.type),
          default: f.default,
          column: f.column,
        })),
        relations: m.relations,
        indexes: m.indexes,
        uniques: m.uniques,
        clientStale,
      },
      refs: {},
      span: line(m.line),
      provenance: schemaProvenance,
    });
  }
  for (const e of parsed.enums) {
    ctx.store.upsertFragment({
      id: `prisma:enum:${e.name}`,
      adapter: "prisma",
      kind: "enum",
      attrs: { name: e.name, members: e.members },
      refs: {},
      span: line(e.line),
      provenance: schemaProvenance,
    });
  }

  // ---- static migration report -----------------------------------------
  emitMigrations(ctx);
}

// ---- raw queries ---------------------------------------------------------

function emitRaw(ctx: AdapterContext, node: Node, kind: "queryRaw" | "executeRaw", sql: string, seq: number, fid: string | undefined): void {
  const caller = enclosingCallable(ctx, node);
  const refs: FragmentNodeRecord["refs"] = {};
  if (caller) refs.caller = caller;
  ctx.store.upsertFragment({
    id: `prisma:raw:${ctx.pkg.name}:${seq}`,
    adapter: "prisma",
    kind: "raw-query",
    attrs: { kind, rw: kind === "queryRaw" ? "read" : "write", sql: sql.trim() },
    refs,
    span: spanOf(node),
    provenance: fid ? [fid] : [],
  });
}

// ---- migrations ----------------------------------------------------------

function emitMigrations(ctx: AdapterContext): void {
  const dir = join(ctx.pkg.root, "prisma", "migrations");
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const sqlPath = join(dir, name, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    const sql = readFileSync(sqlPath, "utf8");
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
    const operations = statements.map(operationOf).filter(Boolean) as string[];
    const tables = [...new Set([...sql.matchAll(/CREATE TABLE\s+"?([A-Za-z0-9_]+)"?/gi)].map((m) => m[1]))];
    ctx.store.upsertFragment({
      id: `prisma:migration:${name}`,
      adapter: "prisma",
      kind: "migration",
      attrs: { name, statements: statements.length, operations, tables },
      refs: {},
      span: null,
      provenance: [synthId(ctx.pkg.name, ctx.pkg.root, sqlPath)],
    });
  }
}

function operationOf(stmt: string): string | null {
  const m = stmt.match(
    /^\s*(?:--[^\n]*\n\s*)*(CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX|CREATE TYPE|CREATE EXTENSION|CREATE SCHEMA|ALTER TABLE|ALTER TYPE|DROP TABLE|DROP INDEX|DROP TYPE)/i,
  );
  return m ? m[1].toUpperCase() : null;
}

// ---- confidence / client typing -----------------------------------------

/** Class names whose heritage chain reaches PrismaClient (fixpoint over the
 *  package's classes), so `extends PrismaClient` in a NestJS PrismaService is
 *  recognized as a typed client receiver. */
function clientTypeSet(files: SourceFile[]): Set<string> {
  const set = new Set(["PrismaClient"]);
  const classes = files.flatMap((sf) => sf.getClasses());
  let changed = true;
  while (changed) {
    changed = false;
    for (const cls of classes) {
      const name = cls.getName();
      if (!name || set.has(name)) continue;
      const ext = classNameOf(cls.getExtends()?.getExpression());
      if (ext && set.has(ext)) {
        set.add(name);
        changed = true;
      }
    }
  }
  return set;
}

function confidenceOf(recv: Expression, cls: ClassDeclaration | undefined, clientTypes: Set<string>): "typed" | "heuristic" {
  const head = receiverTypeHead(recv, cls);
  if (head && clientTypes.has(head)) return "typed";
  return "heuristic";
}

/** The declared type-name of a client receiver, when statically knowable:
 *  `this.<field>` via the enclosing class's field/ctor-property types, or a
 *  bare identifier (`const db = new PrismaClient(); db.user...`) via its
 *  lexically-resolved declaration's declared/initializer type. */
function receiverTypeHead(recv: Expression, cls: ClassDeclaration | undefined): string | null {
  if (Node.isPropertyAccessExpression(recv) && Node.isThisExpression(recv.getExpression()) && cls) {
    return fieldTypeMap(cls).get(recv.getName()) ?? null;
  }
  if (Node.isIdentifier(recv)) {
    return identifierTypeHead(recv);
  }
  return null;
}

/** Resolve a bare-identifier client receiver's declaration lexically (walking
 *  enclosing scopes within the package closure) and read its statically-known
 *  type head: an explicit annotation, else a `new X()` initializer's class. */
function identifierTypeHead(id: Expression): string | null {
  const name = id.getText();
  let scope: Node | undefined = id.getParent();
  while (scope) {
    // Function/method/ctor parameters: `constructor(db: PrismaService)`.
    if (Node.isFunctionDeclaration(scope) || Node.isFunctionExpression(scope) || Node.isArrowFunction(scope) || Node.isMethodDeclaration(scope) || Node.isConstructorDeclaration(scope) || Node.isGetAccessorDeclaration(scope) || Node.isSetAccessorDeclaration(scope)) {
      for (const p of scope.getParameters()) {
        if (p.getName() === name) return typeHeadText(p.getTypeNode()?.getText());
      }
    }
    // Block / source-file scope: `const db = new PrismaClient()`.
    if (Node.isBlock(scope) || Node.isSourceFile(scope) || Node.isModuleBlock(scope) || Node.isCaseClause(scope) || Node.isDefaultClause(scope) || Node.isForStatement(scope) || Node.isForOfStatement(scope) || Node.isForInStatement(scope)) {
      const head = varDeclTypeHead(scope, name);
      if (head) return head;
    }
    scope = scope.getParent();
  }
  return null;
}

/** Type head of a `let/const/var <name>` declared directly in `scope`: an
 *  explicit annotation if present, else the class of a `new X()` initializer. */
function varDeclTypeHead(scope: Node, name: string): string | null {
  for (const vd of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (vd.getName() !== name) continue;
    // Only accept declarations that belong to this scope, not nested ones,
    // so an inner shadowing binding does not leak outward.
    if (nearestScope(vd) !== scope) continue;
    const annotated = typeHeadText(vd.getTypeNode()?.getText());
    if (annotated) return annotated;
    const init = vd.getInitializer();
    if (init && Node.isNewExpression(init)) return classNameOf(init.getExpression());
    return null;
  }
  return null;
}

/** The nearest enclosing lexical scope of a node (block / source-file /
 *  function-like / loop), matching the walk in `identifierTypeHead`. */
function nearestScope(node: Node): Node | undefined {
  let a: Node | undefined = node.getParent();
  while (a) {
    if (Node.isBlock(a) || Node.isSourceFile(a) || Node.isModuleBlock(a) || Node.isCaseClause(a) || Node.isDefaultClause(a) || Node.isForStatement(a) || Node.isForOfStatement(a) || Node.isForInStatement(a)) return a;
    a = a.getParent();
  }
  return undefined;
}

function fieldTypeMap(cls: ClassDeclaration): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of cls.getProperties()) {
    const h = typeHeadText(p.getTypeNode()?.getText());
    if (h) m.set(p.getName(), h);
  }
  for (const ctor of cls.getConstructors()) {
    for (const p of ctor.getParameters()) {
      const h = typeHeadText(p.getTypeNode()?.getText());
      if (h) m.set(p.getName(), h);
    }
  }
  return m;
}

// ---- argument field extraction ------------------------------------------

/** Field names referenced in a Prisma op argument: every key nested under
 *  where/data/select/orderBy/... intersected with the model's real fields. */
function argFields(arg: Node | undefined, modelFields: Set<string>): string[] {
  if (!arg || !Node.isObjectLiteralExpression(arg)) return [];
  const keys = new Set<string>();
  collectKeys(arg, keys);
  return [...keys].filter((k) => modelFields.has(k));
}

function collectKeys(obj: Node, out: Set<string>): void {
  if (!Node.isObjectLiteralExpression(obj)) return;
  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      out.add(prop.getName());
      const init = prop.getInitializer();
      if (init) collectFrom(init, out);
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      out.add(prop.getName());
    }
  }
}

function collectFrom(node: Node, out: Set<string>): void {
  if (Node.isObjectLiteralExpression(node)) collectKeys(node, out);
  else if (Node.isArrayLiteralExpression(node)) for (const el of node.getElements()) collectFrom(el, out);
}

// ---- small helpers -------------------------------------------------------

function enclosingCallable(ctx: AdapterContext, node: Node): string | null {
  let a: Node | undefined = node.getParent();
  while (a) {
    if (Node.isMethodDeclaration(a) || Node.isConstructorDeclaration(a) || Node.isFunctionDeclaration(a) || Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a)) {
      const id = ctx.symbolIdOf(a);
      if (id) return id;
    }
    a = a.getParent();
  }
  return null;
}

function classNameOf(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isPropertyAccessExpression(node)) return node.getName();
  if (Node.isExpressionWithTypeArguments(node)) return classNameOf(node.getExpression());
  return null;
}

function typeHeadText(text: string | undefined): string | null {
  if (!text) return null;
  const noGenerics = text.replace(/<[\s\S]*>/, "").trim();
  const seg = noGenerics.split(".").pop() ?? noGenerics;
  const m = seg.match(/[A-Za-z0-9_$]+/);
  return m ? m[0] : null;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function findSchemas(root: string): string[] {
  const primary = join(root, "prisma", "schema.prisma");
  if (existsSync(primary)) return [primary];
  const prismaDir = join(root, "prisma");
  if (existsSync(prismaDir)) {
    try {
      const found = readdirSync(prismaDir).filter((n) => n.endsWith(".prisma")).map((n) => join(prismaDir, n));
      if (found.length) return found;
    } catch {
      /* ignore */
    }
  }
  const flat = join(root, "schema.prisma");
  return existsSync(flat) ? [flat] : [];
}

/** Is the generated Prisma client older than the schema? We stat the *actual
 *  generated output* (`.prisma/client/index.d.ts`), never the `@prisma/client`
 *  package directory — under pnpm the latter is a symlink into the store whose
 *  mtime is the install time, not the `prisma generate` time (that gave a false
 *  `clientStale` on every model). Indeterminate (can't resolve the output) →
 *  `false`, so we never cry wolf. */
export function computeClientStale(root: string, projectRoot: string, schemaMtime: number): boolean {
  const generated = resolveGeneratedClient(root, projectRoot);
  if (!generated) return false;
  return safeMtime(generated) < schemaMtime;
}

/** Locate the generated client output file for a package, walking up to the
 *  workspace root. Handles both the hoisted layout (`.prisma/client` directly
 *  under a `node_modules`) and pnpm's symlinked `@prisma/client` (whose real
 *  location has the generated `.prisma/client` as a sibling in the store). */
function resolveGeneratedClient(root: string, projectRoot: string): string | null {
  const outputs = [".prisma/client/index.d.ts", ".prisma/client/index.js"];
  let dir = root;
  for (;;) {
    const nm = join(dir, "node_modules");
    // Hoisted / co-located generated client.
    for (const rel of outputs) {
      const p = join(nm, rel);
      if (existsSync(p)) return p;
    }
    // pnpm: `@prisma/client` is a symlink into the store; the generated
    // `.prisma/client` sits next to it in the store's node_modules.
    const link = join(nm, "@prisma", "client");
    if (existsSync(link)) {
      try {
        const storeNm = dirname(dirname(realpathSync(link)));
        for (const rel of outputs) {
          const p = join(storeNm, rel);
          if (existsSync(p)) return p;
        }
      } catch {
        /* ignore */
      }
    }
    if (dir === projectRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function synthId(pkg: string, root: string, abs: string): string {
  return `${pkg}|${relative(root, abs).split(sep).join("/")}`;
}

function line(n: number): Span {
  return { startLine: n, startCol: 1, endLine: n, endCol: 1 };
}

function spanOf(node: Node): Span {
  const sf = node.getSourceFile();
  const s = sf.getLineAndColumnAtPos(node.getStart());
  const e = sf.getLineAndColumnAtPos(node.getEnd());
  return { startLine: s.line, startCol: s.column, endLine: e.line, endCol: e.column };
}
