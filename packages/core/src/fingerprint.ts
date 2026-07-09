// Cheap source fingerprint + diff. At session start the daemon re-fingerprints
// (I/O only, no parse) and rebuilds only what changed — the common "nothing
// changed" case is a fast no-op. This module is deliberately *pure* (no build
// dependency): `refresh`/`incrementalRefresh`, which consume a diff to drive a
// dirty-set rebuild, live in build.ts.
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative, sep, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileId } from "./ids.ts";
import type { Workspace } from "./workspace.ts";

export interface RefreshResult {
  rebuilt: boolean;
  changed: number;
}

/** File-id sets that changed between two fingerprints (added/changed/deleted). */
export interface FileDiff {
  added: Set<string>;
  changed: Set<string>;
  deleted: Set<string>;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
}

function packageInfo(fileDir: string, projectRoot: string): { name: string; root: string } {
  let dir = fileDir;
  while (dir.startsWith(projectRoot)) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const json = JSON.parse(readFileSync(pj, "utf8")) as { name?: string };
        if (json.name) return { name: json.name, root: dir };
      } catch {
        /* ignore */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { name: ".", root: projectRoot };
}

/** fileId -> content hash, without parsing. */
export function fingerprint(rootInput: string): Map<string, string> {
  const projectRoot = resolve(rootInput);
  const files: string[] = [];
  walk(projectRoot, files);
  const map = new Map<string, string>();
  const pkgCache = new Map<string, { name: string; root: string }>();
  for (const abs of files) {
    const dir = dirname(abs);
    let pkg = pkgCache.get(dir);
    if (!pkg) {
      pkg = packageInfo(dir, projectRoot);
      pkgCache.set(dir, pkg);
    }
    const rel = relative(pkg.root, abs).split(sep).join("/");
    const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
    map.set(fileId(pkg.name, rel), hash);
  }
  return map;
}

/** Adapter-relevant *non-`.ts`* sources (`.prisma` schemas + migration files),
 *  keyed as `pkg|relPath` so a diff can attribute a change to a package and
 *  re-run that package's adapters. `.ts` adapter inputs are covered by the
 *  ordinary source fingerprint. Stored in `meta` (excluded from the map dump),
 *  so tracking them never perturbs the canonical, structural equality. */
export function auxFingerprint(ws: Workspace): Map<string, string> {
  const map = new Map<string, string>();
  for (const pkg of ws.packages) {
    for (const abs of auxFiles(pkg.root)) {
      const rel = relative(pkg.root, abs).split(sep).join("/");
      map.set(`${pkg.name}|${rel}`, createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  }
  return map;
}

function auxFiles(pkgRoot: string, out: string[] = [], dir = pkgRoot): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) auxFiles(pkgRoot, out, p);
    else if (name.endsWith(".prisma") || p.includes(`${sep}migrations${sep}`)) out.push(p);
  }
  return out;
}

/** Count of files that differ (added/changed/deleted). */
export function diffCount(prev: Map<string, string>, cur: Map<string, string>): number {
  let n = 0;
  for (const [fid, h] of cur) if (prev.get(fid) !== h) n += 1;
  for (const fid of prev.keys()) if (!cur.has(fid)) n += 1;
  return n;
}

/** Identity-level diff: which file-ids were added / changed / deleted. */
export function diff(prev: Map<string, string>, cur: Map<string, string>): FileDiff {
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const [fid, h] of cur) {
    if (!prev.has(fid)) added.add(fid);
    else if (prev.get(fid) !== h) changed.add(fid);
  }
  for (const fid of prev.keys()) if (!cur.has(fid)) deleted.add(fid);
  return { added, changed, deleted };
}
