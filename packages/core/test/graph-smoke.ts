import { Store, buildInto } from "../src/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.argv[2] ?? join(import.meta.dirname, "sample");
const db = join(tmpdir(), `tsca-graph-${process.pid}.db`);
const store = new Store(db);

const t0 = performance.now();
const res = buildInto(store, root);
console.log("built:", res, `in ${Math.round(performance.now() - t0)}ms`);
console.log("counts:", store.counts());

const one = (name: string, kind?: string) => store.findSymbols({ name, kind, limit: 1 })[0];

const repo = one("Repository", "interface");
if (repo) {
  console.log(`\nimplementers of ${repo.id}:`);
  for (const e of store.edgesTo(repo.id, ["implements"])) console.log(`  <- ${e.src} (${e.resolved})`);
}

const base = one("BaseService", "class");
if (base) {
  const describe = store.membersOf(base.id).find((m) => m.name === "describe");
  if (describe) {
    console.log(`\ncalls out of ${describe.id}:`);
    for (const e of store.edgesFrom(describe.id, ["calls"])) console.log(`  -> ${e.dst} (${e.resolved})`);
  }
  const resourceName = store.membersOf(base.id).find((m) => m.name === "resourceName");
  if (resourceName) {
    console.log(`\noverriders of ${resourceName.id}:`);
    for (const e of store.edgesTo(resourceName.id, ["overrides"])) console.log(`  <- ${e.src} (${e.resolved})`);
  }
}

console.log("\nentrypoints:");
for (const e of store.listEntrypoints()) console.log(`  ${e.kind}: ${e.symbol ?? JSON.stringify(e.detail)}`);

store.close();
