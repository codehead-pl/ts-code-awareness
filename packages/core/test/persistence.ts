// Store persistence regression.
//
// A built map MUST survive a close/reopen of its on-disk DB — that durability is
// the whole point of the daemon's ~/.tsca-cache/<hash>.db and of fingerprint-
// gated incremental (a cold session should load the prior map, not rebuild).
//
// Guards against Store.reset() wiping the `storeSchema` sentinel in `meta`:
// init() only writes that sentinel in the constructor, so the next open would
// read a null version, take the version-mismatch branch, and DROP every table —
// silently loading empty and full-rebuilding every cold session.
import { Store, buildInto, registerAdapter } from "../src/index.ts";
import { nestAdapter } from "../../adapter-nest/src/index.ts";
import { prismaAdapter } from "../../adapter-prisma/src/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

registerAdapter(nestAdapter);
registerAdapter(prismaAdapter);

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}

const FIXTURE = "fixtures/nest-monorepo";
const dbPath = join(tmpdir(), `persist-${process.pid}.db`);
const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
for (const p of sidecars) rmSync(p, { force: true });

console.log("=== persistence: build → close → reopen the same DB file ===");

// Build, capture counts, then close (this is what a first session does).
const first = new Store(dbPath);
const built = buildInto(first, FIXTURE);
console.log(`  built: ${built.symbols} symbols, ${built.edges} edges`);
check("build produced a non-empty map", built.symbols > 0 && built.edges > 0);
// The reset() inside buildInto must have LEFT the schema sentinel intact.
check("storeSchema sentinel survives a build (reset kept it)", first.getMeta("storeSchema") !== null);
first.close();

// Reopen a fresh Store on the same path — this is exactly a cold daemon load.
const reopened = new Store(dbPath);
const after = reopened.counts();
console.log(`  reopened: ${after.symbols} symbols, ${after.edges} edges`);
check("rows survive close/reopen — the cache is not silently dropped", after.symbols > 0);
check(
  "reopened counts match the built map exactly",
  after.symbols === built.symbols && after.edges === built.edges && after.entrypoints === built.entrypoints,
);
// Fragments (adapter layer) must persist too, not just base symbols.
check("adapter fragments survive reopen", reopened.mapSize().tables.fragment_nodes > 0);
reopened.close();

for (const p of sidecars) rmSync(p, { force: true });

console.log(failures === 0 ? "\nPASS — the on-disk map persists across close/reopen" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
