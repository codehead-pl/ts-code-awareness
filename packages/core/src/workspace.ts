// Workspace detection: enumerate packages, their tsconfigs, and the workspace
// dependency DAG. Supports pnpm /
// npm / yarn workspaces + nx / turbo flavouring. Also loads the root tsconfig's
// path aliases so the ts-morph program resolves cross-package imports.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";

export interface WorkspacePackage {
  name: string;
  root: string; // absolute
  tsconfig: string | null; // absolute
  packageJson: string; // absolute
  workspaceDeps: string[]; // names of other workspace packages depended on
  dependencies: string[]; // all dependency names (deps+dev+peer) — feeds adapter detect()
}

export interface Workspace {
  root: string;
  tool: string; // "pnpm" | "npm" | "yarn" | "nx" | "turbo" | "single" (+ combos)
  packages: WorkspacePackage[];
  /** merged tsconfig path aliases from the root base tsconfig */
  tsPaths: { baseUrl: string; paths: Record<string, string[]> } | null;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Minimal parse of a pnpm-workspace.yaml `packages:` list. */
function pnpmGlobs(root: string): string[] | null {
  const p = join(root, "pnpm-workspace.yaml");
  if (!existsSync(p)) return null;
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
      if (m) globs.push(m[1]);
      else if (/^\S/.test(line)) break; // next top-level key
    }
  }
  return globs;
}

function workspacesFromPackageJson(root: string): string[] | null {
  const pj = readJson<{ workspaces?: string[] | { packages?: string[] } }>(join(root, "package.json"));
  if (!pj?.workspaces) return null;
  return Array.isArray(pj.workspaces) ? pj.workspaces : (pj.workspaces.packages ?? []);
}

/** Expand a glob of the form "dir/*" or exact "dir" to package directories. */
function expandGlob(root: string, glob: string): string[] {
  const clean = glob.replace(/\/$/, "");
  if (clean.endsWith("/*")) {
    const base = join(root, clean.slice(0, -2));
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .map((n) => join(base, n))
      .filter((d) => {
        try {
          return statSync(d).isDirectory() && existsSync(join(d, "package.json"));
        } catch {
          return false;
        }
      });
  }
  const dir = join(root, clean);
  return existsSync(join(dir, "package.json")) ? [dir] : [];
}

interface TsConfigShape {
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  extends?: string;
}

/** Merge compilerOptions.paths through the tsconfig `extends` chain. */
function loadTsPaths(root: string): Workspace["tsPaths"] {
  const candidates = ["tsconfig.base.json", "tsconfig.json"].map((f) => join(root, f)).filter(existsSync);
  for (const start of candidates) {
    const merged: Record<string, string[]> = {};
    let baseUrl = root;
    let cur: string | null = start;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const cfg: TsConfigShape | null = readJson<TsConfigShape>(cur);
      if (!cfg) break;
      const co = cfg.compilerOptions ?? {};
      if (co.baseUrl) baseUrl = resolve(dirname(cur), co.baseUrl);
      const paths: Record<string, string[]> = co.paths ?? {};
      for (const k of Object.keys(paths)) if (!(k in merged)) merged[k] = paths[k];
      cur = cfg.extends ? resolve(dirname(cur), cfg.extends.endsWith(".json") ? cfg.extends : `${cfg.extends}.json`) : null;
    }
    if (Object.keys(merged).length) return { baseUrl, paths: merged };
  }
  return null;
}

export function detectWorkspace(rootInput: string): Workspace {
  const root = resolve(rootInput);
  const tools: string[] = [];
  let globs = pnpmGlobs(root);
  if (globs) tools.push("pnpm");
  if (!globs) {
    globs = workspacesFromPackageJson(root);
    if (globs) tools.push(existsSync(join(root, "yarn.lock")) ? "yarn" : "npm");
  }
  if (existsSync(join(root, "nx.json"))) tools.push("nx");
  if (existsSync(join(root, "turbo.json"))) tools.push("turbo");

  const dirs = new Set<string>();
  for (const g of globs ?? []) for (const d of expandGlob(root, g)) dirs.add(d);
  if (dirs.size === 0) {
    // no workspace config — treat the root as a single package if it has one
    if (existsSync(join(root, "package.json"))) dirs.add(root);
    tools.push("single");
  }

  const raw = [...dirs].map((dir) => {
    const pj = readJson<{ name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }>(join(dir, "package.json"));
    const tsconfig = ["tsconfig.json", "tsconfig.lib.json"].map((f) => join(dir, f)).find(existsSync) ?? null;
    return {
      name: pj?.name ?? ".",
      root: dir,
      tsconfig,
      packageJson: join(dir, "package.json"),
      deps: { ...pj?.dependencies, ...pj?.devDependencies, ...pj?.peerDependencies },
    };
  });

  const names = new Set(raw.map((p) => p.name));
  const packages: WorkspacePackage[] = raw.map((p) => ({
    name: p.name,
    root: p.root,
    tsconfig: p.tsconfig,
    packageJson: p.packageJson,
    workspaceDeps: Object.keys(p.deps).filter((d) => names.has(d) && d !== p.name),
    dependencies: Object.keys(p.deps),
  }));

  return { root, tool: tools.join("+") || "single", packages, tsPaths: loadTsPaths(root) };
}
