// Manual smoke test for the core build+store.
//   pnpm smoke:core                    -> runs against the tiny sample
//   pnpm smoke:core <projectRoot>      -> runs against any project
import { Store } from "../src/store.ts";
import { buildInto } from "../src/build.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.argv[2] ?? join(import.meta.dirname, "sample");
const dbPath = join(tmpdir(), `tsca-smoke-${process.pid}.db`);

const store = new Store(dbPath);
const t0 = performance.now();
const res = buildInto(store, root);
const ms = Math.round(performance.now() - t0);

console.log(`built ${res.files} files, ${res.symbols} symbols in ${ms}ms`);
console.log(`db: ${store.counts().symbols} symbols, ${store.counts().files} files\n`);

const needle = process.argv[3] ?? "Service";
console.log(`find_symbols({ name: "${needle}" }):`);
for (const s of store.findSymbols({ name: needle, limit: 10 })) {
  console.log(`  ${s.kind.padEnd(11)} ${s.name.padEnd(24)} ${s.signature ?? ""}`);
  console.log(`              id=${s.id}`);
}

const first = store.findSymbols({ name: needle, limit: 1 })[0];
if (first) {
  console.log(`\nget_symbol("${first.id}"):`);
  const detail = store.getSymbol(first.id);
  console.log(JSON.stringify(detail, null, 2));
  const members = store.membersOf(first.id);
  if (members.length) {
    console.log(`  members: ${members.map((m) => `${m.name}`).join(", ")}`);
  }
}

store.close();
