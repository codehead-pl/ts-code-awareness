// Prisma adapter build. Two contributions:
//   1. schema.prisma → prisma:model / prisma:enum fragments (the ER model).
//   2. the model↔code bridge — prisma:access nodes recognized from client call
//      sites in *project source* (never the generated client): `<recv>.<delegate>
//      .<op>(args)` where the delegate maps to a schema model and the op is a
//      known Prisma op. Fields come from the argument object's keys; rw from the
//      op; confidence is `typed` when the receiver's type reaches PrismaClient,
//      else `heuristic`. Plus $queryRaw capture and a static migration report.
import { Node, SyntaxKind, type ClassDeclaration, type Expression, type SourceFile } from "ts-morph";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AdapterContext, FragmentNodeRecord, Span } from "@codehead-pl/tsca-core";
import { parseSchema, type ParsedSchema, type PrismaModel } from "./schema.ts";

const READ_OPS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const WRITE_OPS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const RAW_TAGS: Record<string, "queryRaw" | "executeRaw"> = { $queryRaw: "queryRaw", $executeRaw: "executeRaw" };
const RAW_CALLS: Record<string, "queryRaw" | "executeRaw"> = { $queryRawUnsafe: "queryRaw", $executeRawUnsafe: "executeRaw" };

export function build(ctx: AdapterContext): void {
  const schemaFiles = findSchemas(ctx.pkg.root);
  if (!schemaFiles.length) return;

  // ---- parse + merge all schema files ----------------------------------
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
  const modelNames = new Set(parsed.models.map((m) => m.name));
  const clientStale = computeClientStale(ctx.pkg.root, newestSchemaMtime);

  // delegate (camelCase) -> model, for call-site recognition
  const delegateToModel = new Map<string, PrismaModel>();
  for (const m of parsed.models) delegateToModel.set(lowerFirst(m.name), m);

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

  // ---- model↔code bridge (prisma:access + prisma:raw) ------------------
  const files = ctx.project.getSourceFiles().filter((sf) => ctx.inPackage(sf));
  const clientTypes = clientTypeSet(files);
  let accessSeq = 0;
  let rawSeq = 0;

  for (const sf of files) {
    const fid = ctx.fileIdOf(sf);
    sf.forEachDescendant((node) => {
      // raw queries: tagged template `this.prisma.$queryRaw`...`` or *Unsafe(sql)
      if (Node.isTaggedTemplateExpression(node)) {
        const tag = node.getTag();
        if (Node.isPropertyAccessExpression(tag) && RAW_TAGS[tag.getName()]) {
          emitRaw(ctx, node, RAW_TAGS[tag.getName()], node.getTemplate().getText(), rawSeq++, fid);
        }
        return;
      }
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      const op = expr.getName();

      if (RAW_CALLS[op]) {
        const arg = node.getArguments()[0];
        emitRaw(ctx, node, RAW_CALLS[op], arg ? arg.getText() : "", rawSeq++, fid);
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
  const m = stmt.match(/^\s*(?:--[^\n]*\n\s*)*(CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX|CREATE TYPE|ALTER TABLE|DROP TABLE|DROP INDEX)/i);
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

function computeClientStale(root: string, schemaMtime: number): boolean {
  for (const rel of ["node_modules/.prisma/client", "node_modules/@prisma/client"]) {
    const p = join(root, rel);
    if (existsSync(p)) return safeMtime(p) < schemaMtime;
  }
  return false; // no generated client → nothing to be stale
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
