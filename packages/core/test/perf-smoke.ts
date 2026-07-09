// Perf smoke + regression budget.
//
// Builds the monorepo fixture from scratch, prints the recorded build metrics
// and map-size block, and fails if the full build exceeds a budget. The budget
// is generous at fixture scale — the point is that the ratchet *exists* in CI,
// so a future change that makes the build pathologically slow is caught.
import { Store, buildInto, registerAdapter } from "../src/index.ts";
import { nestAdapter } from "../../adapter-nest/src/index.ts";
import { prismaAdapter } from "../../adapter-prisma/src/index.ts";
import { indexPackage } from "../src/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

registerAdapter(nestAdapter);
registerAdapter(prismaAdapter);

const BUDGET_MS = Number(process.env.TSCA_PERF_BUDGET_MS ?? 60000);
const FIXTURE = "fixtures/nest-monorepo";
const dbPath = join(tmpdir(), `perf-${process.pid}.db`);
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });

const store = new Store(dbPath);
const res = buildInto(store, FIXTURE);
// Also exercise the semantic index so indexPackage timing is recorded.
for (const p of store.listPackages()) indexPackage(store, p.name);

console.log("=== perf smoke:", FIXTURE, "===");
console.log(`full build: ${res.symbols} symbols, ${res.edges} edges, ${res.entrypoints} entrypoints in ${res.ms}ms`);
console.log(`budget: ${BUDGET_MS}ms`);

console.log("\nrecorded build metrics (op / package / ms):");
for (const m of store.metrics()) console.log(`  ${m.op}  ${m.package}  ${m.ms}ms`);

const map = store.mapSize();
console.log(`\nmap size: ${map.bytes} bytes on disk`);
for (const [t, n] of Object.entries(map.tables)) console.log(`  ${t}: ${n}`);

store.close();
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });

if (res.ms > BUDGET_MS) {
  console.log(`\nFAIL — build took ${res.ms}ms, over budget ${BUDGET_MS}ms`);
  process.exit(1);
}
console.log(`\nPASS — build within budget (${res.ms}ms <= ${BUDGET_MS}ms)`);
process.exit(0);
