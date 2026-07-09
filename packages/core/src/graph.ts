// Edge extraction, split by tier (docs/design/02-map-schema.md §6.1):
//   buildStructural — Tier-1: imports, extends, implements, overrides,
//                     package entrypoints. Cheap; run for all packages.
//   buildCalls      — Tier-2: calls, instantiates, nest-bootstrap. The body
//                     walk; run lazily per package (onlyPackage).
// Resolution is AST + index based; external / unresolvable references are
// recorded honestly (§3.5).
import { Node, SyntaxKind, type Project, type SourceFile, type ClassDeclaration } from "ts-morph";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { SymbolIndex } from "./build.ts";
import type { Resolved } from "./types.ts";

const pkgOf = (fid: string): string => fid.slice(0, fid.indexOf("|"));
const relOf = (fid: string): string => fid.slice(fid.indexOf("|") + 1);

/** Tier-1 structural edges. Returns heritageIds (symbolId -> base symbolIds). */
export function buildStructural(
  project: Project,
  store: Store,
  index: SymbolIndex,
  opts: { writeEdges: boolean; onlyFiles?: Set<string> },
): Map<string, string[]> {
  // `onlyFiles` (incremental) restricts *edge* writes to a dirty file set while
  // still visiting every file so heritageIds is complete for cross-file member
  // resolution. Package entrypoints are idempotent upserts and re-emitted freely.
  const writeAll = opts.writeEdges;
  const writeFor = (fid: string) => writeAll && (!opts.onlyFiles || opts.onlyFiles.has(fid));
  const heritageIds = new Map<string, string[]>();
  const loc = (sf: SourceFile, node: Node) =>
    `${relOf(index.fileByAbs.get(sf.getFilePath()) ?? "")}:${sf.getLineAndColumnAtPos(node.getStart()).line}`;

  for (const sf of project.getSourceFiles()) {
    const fid = index.fileByAbs.get(sf.getFilePath());
    if (!fid) continue;
    const F = fid;
    const write = writeFor(fid);
    const resolveName = nameResolver(sf, index, fid);

    if (write) {
      for (const imp of sf.getImportDeclarations()) {
        const spec = imp.getModuleSpecifierValue();
        const targetSf = imp.getModuleSpecifierSourceFile();
        const tfid = targetSf ? index.fileByAbs.get(targetSf.getFilePath()) : undefined;
        if (tfid) store.insertEdge({ src: fid, dst: tfid, kind: "imports", resolved: "exact", via: null, callee: null, file: F });
        else store.insertEdge({ src: fid, dst: `external:${spec}`, kind: "imports", resolved: "unresolved", via: null, callee: null, file: F });
      }
    }

    for (const cls of sf.getClasses()) {
      const cid = index.byNode.get(cls);
      if (!cid) continue;
      const bases: string[] = [];
      const record = (expr: Node, kind: "extends" | "implements") => {
        const name = headName(expr);
        const target = name ? resolveName(name) : null;
        if (target && !target.startsWith("external:")) {
          if (write) store.insertEdge({ src: cid, dst: target, kind, resolved: "exact", via: loc(sf, expr), callee: null, file: F });
          bases.push(target);
        } else if (write) {
          store.insertEdge({ src: cid, dst: target ?? `external:${name ?? "?"}`, kind, resolved: "unresolved", via: loc(sf, expr), callee: name, file: F });
        }
      };
      const ext = cls.getExtends();
      if (ext) record(ext.getExpression(), "extends");
      for (const impl of cls.getImplements()) record(impl.getExpression(), "implements");
      heritageIds.set(cid, bases);
    }

    for (const iface of sf.getInterfaces()) {
      const iid = index.byNode.get(iface);
      if (!iid) continue;
      const bases: string[] = [];
      for (const ext of iface.getExtends()) {
        const name = headName(ext.getExpression());
        const target = name ? resolveName(name) : null;
        if (target && !target.startsWith("external:")) {
          if (write) store.insertEdge({ src: iid, dst: target, kind: "extends", resolved: "exact", via: loc(sf, ext), callee: null, file: F });
          bases.push(target);
        }
      }
      heritageIds.set(iid, bases);
    }
  }

  // overrides (needs full heritageIds)
  const resolveMember = memberResolver(index, heritageIds);
  for (const sf of project.getSourceFiles()) {
    const fid = index.fileByAbs.get(sf.getFilePath());
    if (!fid || !writeFor(fid)) continue;
    const F = fid;
    for (const cls of sf.getClasses()) {
      const cid = index.byNode.get(cls);
      if (!cid) continue;
      const bases = heritageIds.get(cid) ?? [];
      for (const m of cls.getMethods()) {
        const mid = index.membersByOwner.get(cid)?.get(m.getName());
        if (!mid) continue;
        for (const base of bases) {
          const r = resolveMember(base, m.getName());
          if (r) {
            store.insertEdge({ src: mid, dst: r.memberId, kind: "overrides", resolved: "exact", via: `${relOf(fid)}:${sf.getLineAndColumnAtPos(m.getStart()).line}`, callee: null, file: F });
            break;
          }
        }
      }
    }
  }

  // package entrypoints: bin / main (idempotent upserts — re-emitted on any
  // write pass, including a scoped incremental one).
  if (writeAll) {
    for (const pkg of store.listPackages()) {
      const pjPath = join(pkg.root, "package.json");
      if (!existsSync(pjPath)) continue;
      let json: { main?: string; module?: string; bin?: unknown } = {};
      try {
        json = JSON.parse(readFileSync(pjPath, "utf8"));
      } catch {
        continue;
      }
      const provenance = `${pkg.name}|package.json`;
      const main = json.main ?? json.module;
      if (main) store.upsertEntrypoint({ id: `package-main:${pkg.name}`, kind: "package-main", source: "core", symbol: null, detail: { main }, file: provenance });
      if (json.bin) store.upsertEntrypoint({ id: `bin:${pkg.name}`, kind: "bin", source: "core", symbol: null, detail: { bin: json.bin }, file: provenance });
    }
  }

  return heritageIds;
}

/** Tier-2 call graph. Writes calls/instantiates for files in `onlyPackage`. */
export function buildCalls(
  project: Project,
  store: Store,
  index: SymbolIndex,
  heritageIds: Map<string, string[]>,
  opts: { onlyPackage?: string; onlyFiles?: Set<string> } = {},
): void {
  const fieldTypeCache = new Map<ClassDeclaration, Map<string, string>>();
  const resolveMember = memberResolver(index, heritageIds);
  const refSeen = new Set<string>();
  const isContract = (ownerId: string, memberId: string) =>
    index.info.get(ownerId)?.kind === "interface" || !!index.info.get(memberId)?.abstract;
  const loc = (sf: SourceFile, node: Node) =>
    `${relOf(index.fileByAbs.get(sf.getFilePath()) ?? "")}:${sf.getLineAndColumnAtPos(node.getStart()).line}`;

  for (const sf of project.getSourceFiles()) {
    const fid = index.fileByAbs.get(sf.getFilePath());
    if (!fid) continue;
    if (opts.onlyPackage && pkgOf(fid) !== opts.onlyPackage) continue;
    if (opts.onlyFiles && !opts.onlyFiles.has(fid)) continue;
    const F = fid;
    const resolveName = nameResolver(sf, index, fid);

    const call = (src: string, target: string | null, resolved: Resolved, callee: string | null, via: string | null) => {
      const real = target && !target.startsWith("external:");
      store.insertEdge({ src, dst: real ? target! : `external:${callee ?? "?"}`, kind: "calls", resolved: real ? resolved : "unresolved", via, callee: real ? null : callee, file: F });
    };

    sf.forEachDescendant((node) => {
      if (Node.isNewExpression(node)) {
        const enc = enclosingCallable(node, index);
        if (!enc) return;
        const name = headName(node.getExpression());
        const target = name ? resolveName(name) : null;
        const real = target && !target.startsWith("external:");
        store.insertEdge({ src: enc, dst: real ? target! : `external:${name ?? "?"}`, kind: "instantiates", resolved: real ? "exact" : "unresolved", via: loc(sf, node), callee: name, file: F });
      } else if (Node.isCallExpression(node)) {
        const enc = enclosingCallable(node, index);
        if (!enc) return;
        const expr = node.getExpression();
        const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        const currentClassId = cls ? index.byNode.get(cls) : undefined;

        if (Node.isIdentifier(expr)) {
          const target = resolveName(expr.getText());
          call(enc, target, target && !target.startsWith("external:") ? "exact" : "unresolved", expr.getText(), loc(sf, expr));
          return;
        }
        if (Node.isPropertyAccessExpression(expr)) {
          const methodName = expr.getName();
          const recv = expr.getExpression();
          let ownerTypeId: string | null = null;
          if (Node.isThisExpression(recv)) {
            ownerTypeId = currentClassId ?? null;
          } else if (Node.isPropertyAccessExpression(recv) && Node.isThisExpression(recv.getExpression()) && cls) {
            const typeName = fieldTypesOf(cls, fieldTypeCache).get(recv.getName());
            ownerTypeId = typeName ? resolveName(typeName) : null;
            if (ownerTypeId?.startsWith("external:")) ownerTypeId = null;
          }
          if (ownerTypeId) {
            const r = resolveMember(ownerTypeId, methodName);
            if (r) {
              store.insertEdge({ src: enc, dst: r.memberId, kind: "calls", resolved: isContract(r.ownerId, r.memberId) ? "contract" : "exact", via: loc(sf, expr), callee: methodName, file: F });
              return;
            }
          }
          call(enc, null, "unresolved", methodName, loc(sf, expr));
          return;
        }
        call(enc, null, "unresolved", expr.getText().slice(0, 40), loc(sf, node));
      }
    });

    // nest-bootstrap entrypoint
    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const e = node.getExpression();
      if (Node.isPropertyAccessExpression(e) && e.getName() === "create" && e.getExpression().getText() === "NestFactory") {
        store.upsertEntrypoint({ id: `nest-bootstrap:${fid}`, kind: "nest-bootstrap", source: "core", symbol: enclosingCallable(node, index) ?? null, detail: { at: loc(sf, node) }, file: F });
      }
    });

    // references: value- and type-position uses of a symbol that are NOT already
    // calls / instantiates / imports / heritage. Same resolution model as the
    // call sweep (same-file locals + resolved imports), tagged exact|contract|
    // unresolved, provenance `file`. De-duped against the other edge kinds by
    // construction (callee/new/type-name/heritage/import contexts are skipped)
    // and against duplicate sites via refSeen.
    const emitRef = (src: string, dst: string, via: string) => {
      if (src === dst || dst.startsWith("external:")) return;
      const key = `${src} ${dst} ${via}`;
      if (refSeen.has(key)) return;
      refSeen.add(key);
      const resolved: Resolved = index.info.get(dst)?.kind === "interface" ? "contract" : "exact";
      store.insertEdge({ src, dst, kind: "references", resolved, via, callee: null, file: F });
    };

    sf.forEachDescendant((node) => {
      // (A) Type-position references — a type used in a signature, property
      //     annotation reached through a callable, etc. Heritage clauses use
      //     ExpressionWithTypeArguments (not TypeReference), so extends/implements
      //     are never double-counted here.
      if (Node.isTypeReference(node)) {
        const enc = enclosingCallable(node, index);
        if (!enc) return;
        const tn = node.getTypeName();
        const name = Node.isIdentifier(tn) ? tn.getText() : Node.isQualifiedName(tn) ? tn.getRight().getText() : null;
        const target = name ? resolveName(name) : null;
        if (target) emitRef(enc, target, loc(sf, node));
        return;
      }
      // (B) Enum-member reads — `Enum.Member` in value position resolves to the
      //     specific enum-member symbol.
      if (Node.isPropertyAccessExpression(node)) {
        const recv = node.getExpression();
        if (!Node.isIdentifier(recv)) return;
        const ownerId = resolveName(recv.getText());
        if (!ownerId || ownerId.startsWith("external:") || index.info.get(ownerId)?.kind !== "enum") return;
        const memberId = index.membersByOwner.get(ownerId)?.get(node.getName());
        if (!memberId) return;
        const enc = enclosingCallable(node, index);
        if (enc) emitRef(enc, memberId, loc(sf, node));
        return;
      }
      // (C) Value-position identifier references — e.g. a class/function/enum
      //     passed as an argument or read as a value, where the use is not a
      //     call callee, a `new` target, a property name, or a type name.
      if (Node.isIdentifier(node)) {
        const parent = node.getParent();
        if (!parent) return;
        if (Node.isCallExpression(parent) && parent.getExpression() === node) return; // callee → calls
        if (Node.isNewExpression(parent) && parent.getExpression() === node) return; // ctor → instantiates
        if (Node.isPropertyAccessExpression(parent)) return; // receiver (B) or member name
        if (Node.isTypeReference(parent) || Node.isQualifiedName(parent)) return; // type name → (A)
        if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) return; // object key
        const target = resolveName(node.getText());
        if (!target || target.startsWith("external:")) return;
        const enc = enclosingCallable(node, index);
        if (enc) emitRef(enc, target, loc(sf, node));
      }
    });
  }
}

// ---- helpers ------------------------------------------------------------

function memberResolver(index: SymbolIndex, heritageIds: Map<string, string[]>) {
  return function resolveMember(ownerId: string, name: string, seen = new Set<string>()): { memberId: string; ownerId: string } | null {
    if (seen.has(ownerId)) return null;
    seen.add(ownerId);
    const direct = index.membersByOwner.get(ownerId)?.get(name);
    if (direct) return { memberId: direct, ownerId };
    for (const base of heritageIds.get(ownerId) ?? []) {
      const r = resolveMember(base, name, seen);
      if (r) return r;
    }
    return null;
  };
}

export function nameResolver(sf: SourceFile, index: SymbolIndex, fid: string): (name: string) => string | null {
  const local = index.localByFile.get(fid) ?? new Map<string, string>();
  const imported = new Map<string, string>();
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    const targetSf = imp.getModuleSpecifierSourceFile();
    const tfid = targetSf ? index.fileByAbs.get(targetSf.getFilePath()) : undefined;
    const targetLocals = tfid ? index.localByFile.get(tfid) : undefined;
    const pkgExports = index.exportsByPackage.get(spec);
    for (const ni of imp.getNamedImports()) {
      const importedName = ni.getName();
      const localName = ni.getAliasNode()?.getText() ?? importedName;
      imported.set(localName, targetLocals?.get(importedName) ?? pkgExports?.get(importedName) ?? `external:${spec}`);
    }
    const def = imp.getDefaultImport();
    if (def) imported.set(def.getText(), `external:${spec}`);
    const ns = imp.getNamespaceImport();
    if (ns) imported.set(ns.getText(), `external:${spec}`);
  }
  return (name: string) => local.get(name) ?? imported.get(name) ?? null;
}

function enclosingCallable(node: Node, index: SymbolIndex): string | null {
  let a: Node | undefined = node.getParent();
  while (a) {
    if (
      Node.isMethodDeclaration(a) ||
      Node.isConstructorDeclaration(a) ||
      Node.isFunctionDeclaration(a) ||
      Node.isGetAccessorDeclaration(a) ||
      Node.isSetAccessorDeclaration(a)
    ) {
      const id = index.byNode.get(a);
      if (id) return id;
    }
    a = a.getParent();
  }
  return null;
}

function fieldTypesOf(cls: ClassDeclaration, cache: Map<ClassDeclaration, Map<string, string>>): Map<string, string> {
  let m = cache.get(cls);
  if (m) return m;
  m = new Map();
  for (const p of cls.getProperties()) {
    const t = p.getTypeNode()?.getText();
    if (t) m.set(p.getName(), headOfType(t));
  }
  for (const ctor of cls.getConstructors()) {
    for (const param of ctor.getParameters()) {
      if (param.getScope() !== undefined || param.isReadonly()) {
        const t = param.getTypeNode()?.getText();
        if (t) m.set(param.getName(), headOfType(t));
      }
    }
  }
  cache.set(cls, m);
  return m;
}

function headOfType(text: string): string {
  const noGenerics = text.replace(/<[\s\S]*>/, "").trim();
  const seg = noGenerics.split(".").pop() ?? noGenerics;
  const m = seg.match(/[A-Za-z0-9_$]+/);
  return m ? m[0] : seg;
}

function headName(expr: Node): string | null {
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  if (Node.isExpressionWithTypeArguments(expr)) return headName(expr.getExpression());
  const t = expr.getText();
  return t ? headOfType(t) : null;
}
