// Per-project map manager with an LRU cap.
// One daemon serves every project; each project's map is kept warm in memory
// (here: an open SQLite handle) up to the cap, evicting least-recently-used.
import { Store, buildSkeleton, hydratePackage, incrementalRefresh } from "@codehead-pl/tsca-core";
import { loadLiveConfig, createDriver, type Driver, type LiveConfig } from "@codehead-pl/tsca-live-data";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface Project {
  root: string;
  store: Store;
  builtAt: string;
  /** Adapter names detected active for this project (e.g. ["nest"]). */
  adapters: string[];
  /** Live-data connection config, or null when the project has none. */
  liveData: LiveConfig | null;
  /** Lazily open (and cache) the read-only DB connection. */
  connection(): Promise<Driver>;
  /** Internal: the cached driver, closed on eviction. */
  _driver?: Driver;
  /** Build the Tier-2 call graph for a package on demand. Returns true if it ran. */
  hydrate(pkg: string): boolean;
  /** Hydrate a package and its whole workspace dependency closure. */
  hydrateClosure(pkg: string): void;
}

export class ProjectManager {
  private map = new Map<string, Project>();
  private lru: string[] = []; // most-recently-used at the front
  private cacheDir: string;

  constructor(private cap = Number(process.env.TSCA_LRU ?? 3)) {
    this.cacheDir = process.env.TSCA_CACHE_DIR ?? join(homedir(), ".tsca-cache");
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private dbPath(root: string): string {
    const h = createHash("sha256").update(root).digest("hex").slice(0, 16);
    return join(this.cacheDir, `${h}.db`);
  }

  /** Get the project's map, building it on first use. */
  get(root: string): Project {
    const existing = this.map.get(root);
    if (existing) {
      this.touch(root);
      return existing;
    }
    const store = new Store(this.dbPath(root));
    // Fingerprint-based staleness: on load, rebuild only the dirty set (per-file,
    // per-fragment, cross-package) rather than the whole skeleton, and re-embed
    // the semantic sidecar for just the changed packages (hash-gated — a no-op
    // when nothing changed). Cold/relocated caches fall back to a full build.
    incrementalRefresh(store, root, { reindex: true });
    const project: Project = {
      root,
      store,
      builtAt: store.getMeta("builtAt") ?? "",
      adapters: JSON.parse(store.getMeta("adapters") ?? "[]") as string[],
      liveData: loadLiveConfig(root),
      async connection() {
        if (!this._driver) this._driver = await createDriver(this.liveData!);
        return this._driver;
      },
      hydrate: (pkg: string) => hydratePackage(store, root, pkg),
      hydrateClosure: (pkg: string) => {
        const byName = new Map(store.listPackages().map((p) => [p.name, p]));
        const seen = new Set<string>();
        const stack = [pkg];
        while (stack.length) {
          const n = stack.pop()!;
          if (seen.has(n)) continue;
          seen.add(n);
          hydratePackage(store, root, n);
          for (const d of byName.get(n)?.workspaceDeps ?? []) stack.push(d);
        }
      },
    };
    this.map.set(root, project);
    this.lru.unshift(root);
    this.evict();
    return project;
  }

  rebuild(root: string): Project {
    const project = this.get(root);
    buildSkeleton(project.store, root);
    project.builtAt = project.store.getMeta("builtAt") ?? "";
    project.adapters = JSON.parse(project.store.getMeta("adapters") ?? "[]") as string[];
    return project;
  }

  private touch(root: string): void {
    this.lru = [root, ...this.lru.filter((r) => r !== root)];
  }

  private evict(): void {
    while (this.lru.length > this.cap) {
      const root = this.lru.pop()!;
      const p = this.map.get(root);
      p?.store.close();
      void p?._driver?.close(); // release the DB connection with the map
      this.map.delete(root);
    }
  }

  status(): Array<{ root: string; symbols: number; builtAt: string }> {
    return this.lru.map((root) => {
      const p = this.map.get(root)!;
      return { root, symbols: p.store.countSymbols(), builtAt: p.builtAt };
    });
  }
}
