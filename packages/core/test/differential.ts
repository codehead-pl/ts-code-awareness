// Differential correctness harness.
//
// Proves the build is *deterministic*: two independent from-scratch builds of
// the same fixture produce byte-identical maps after canonicalization (sorted
// symbols, edges, entrypoints, fragments; volatile timestamps/timings excluded).
// This is the reusable oracle incremental invalidation is validated
// against — incremental == full-rebuild reduces to `diffStores(...).equal`.
import { Store, buildInto, incrementalRefresh, indexPackage, canonicalJson, diffStores, registerAdapter } from "../src/index.ts";
import { nestAdapter } from "../../adapter-nest/src/index.ts";
import { prismaAdapter } from "../../adapter-prisma/src/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";

// Register the adapters so fragment tables participate in the equality proof —
// the differential oracle must cover the adapter layer, not just the base map.
registerAdapter(nestAdapter);
registerAdapter(prismaAdapter);

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}

const FIXTURE = "fixtures/nest-monorepo";
const pathA = join(tmpdir(), `diff-a-${process.pid}.db`);
const pathB = join(tmpdir(), `diff-b-${process.pid}.db`);
for (const p of [pathA, pathB, `${pathA}-wal`, `${pathB}-wal`, `${pathA}-shm`, `${pathB}-shm`]) rmSync(p, { force: true });

console.log("=== differential: two from-scratch builds of", FIXTURE, "===");

const a = new Store(pathA);
const resA = buildInto(a, FIXTURE);
console.log(`  build A: ${resA.symbols} symbols, ${resA.edges} edges in ${resA.ms}ms`);

const b = new Store(pathB);
const resB = buildInto(b, FIXTURE);
console.log(`  build B: ${resB.symbols} symbols, ${resB.edges} edges in ${resB.ms}ms`);

check("build produced a non-empty map", resA.symbols > 0 && resA.edges > 0);
check("row counts match across builds", resA.symbols === resB.symbols && resA.edges === resB.edges && resA.entrypoints === resB.entrypoints);

const jsonA = canonicalJson(a);
const jsonB = canonicalJson(b);
check("canonical dumps are byte-identical", jsonA === jsonB);

const d = diffStores(a, b);
check("diffStores reports equal", d.equal === true);
if (!d.equal) console.log(`     first divergence in table ${d.table} at row ${d.index}\n       A: ${JSON.stringify(d.a)}\n       B: ${JSON.stringify(d.b)}`);

// Sanity: the fixture's adapter layer is actually exercised (fragments present),
// so the equality proof is covering the adapters, not just the empty base case.
const frag = a.mapSize().tables.fragment_nodes;
check("adapter fragments are present in the dump (non-degenerate)", frag > 0);

a.close();
b.close();
for (const p of [pathA, pathB, `${pathA}-wal`, `${pathB}-wal`, `${pathA}-shm`, `${pathB}-shm`]) rmSync(p, { force: true });

// === incremental invalidation == full rebuild, over an edit battery =====
// The contract: for every kind of edit, an incrementalRefresh applied to a
// warm map is byte-identical (post-canonicalization) to a from-scratch build of
// the edited tree. Plus the scope claims: a one-line body edit rebuilds exactly
// one file's rows and re-embeds exactly one chunk.
console.log("\n=== W4 incremental battery: incremental == full-rebuild ===");

let scratchSeq = 0;
const scratch = (tag: string) => join(tmpdir(), `w4-${tag}-${process.pid}-${scratchSeq++}`);
function freshCopy(tag: string): string {
  const dir = scratch(tag);
  rmSync(dir, { recursive: true, force: true });
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
function edit(dir: string, rel: string, fn: (src: string) => string): void {
  const p = join(dir, rel);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
}
function purge(...paths: string[]): void {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}

type ApplyFn = (dir: string) => void;

/** Build warm → apply edit → incremental, vs the same edited tree built cold;
 *  diff. Both stores build against the *same* project dir (DB files kept out of
 *  the scanned tree) so absolute package paths match — the comparison is purely
 *  of derived content. */
function battery(name: string, apply: ApplyFn): ReturnType<typeof incrementalRefresh> {
  const dir = freshCopy(name);
  const dbI = scratch(`${name}-i.db`);
  const dbF = scratch(`${name}-f.db`);

  const si = new Store(dbI);
  buildInto(si, dir);
  apply(dir);
  const res = incrementalRefresh(si, dir);

  const sf = new Store(dbF);
  buildInto(sf, dir);

  const d = diffStores(si, sf);
  check(`[${name}] incremental DB == full-rebuild DB`, d.equal === true);
  if (!d.equal) console.log(`     first divergence: table ${d.table} row ${d.index}\n       INC:  ${JSON.stringify(d.a)}\n       FULL: ${JSON.stringify(d.b)}`);

  si.close();
  sf.close();
  purge(dir, dbI, dbF, `${dbI}-wal`, `${dbF}-wal`, `${dbI}-shm`, `${dbF}-shm`);
  return res;
}

const USERS_SVC = "packages/api/src/users/users.service.ts";

// 1) body edit — a one-line string change inside a method body (non-structural).
const bodyRes = battery("body-edit", (dir) => edit(dir, USERS_SVC, (s) => s.replace("not found", "was not found")));
check("[body-edit] rebuilt exactly one file's rows", bodyRes.rebuilt.length === 1 && bodyRes.rebuilt[0].endsWith("users.service.ts"));

// 2) rename — a class member renamed (structural: symbol-id set changes).
battery("rename", (dir) => edit(dir, "packages/core/src/base-service.ts", (s) => s.replace(/makeKey/g, "buildKey")));

// 3) add file — a brand-new exported symbol in an existing package.
battery("add-file", (dir) => writeFileSync(join(dir, "packages/core/src/w4-extra.ts"), "export function w4helper(): number {\n  return 42;\n}\n"));

// 4) delete file — remove a leaf module (its rows + fragments must vanish).
battery("delete-file", (dir) => rmSync(join(dir, "packages/api/src/stats/post-stats.ts"), { force: true }));

// 5) cross-package signature change — new optional param on a core interface
//    method (non-structural: the symbol id is stable, only the signature moves).
const xpkgRes = battery("xpkg-signature", (dir) =>
  edit(dir, "packages/core/src/repository.ts", (s) => s.replace("save(entity: T): Promise<T>", "save(entity: T, force?: boolean): Promise<T>")),
);
check(
  "[xpkg-signature] a stable-id signature change rebuilds exactly one file",
  xpkgRes.rebuilt.length === 1 && xpkgRes.rebuilt[0].endsWith("repository.ts"),
);

// 6) .prisma edit — a schema field attribute change (adapter-fragment only).
battery("prisma-edit", (dir) =>
  edit(dir, "packages/api/prisma/schema.prisma", (s) => s.replace("name  String?", "name  String? @db.VarChar(120)")),
);

// Scope claim: a one-line body edit re-embeds exactly one semantic chunk.
{
  const dir = freshCopy("reembed");
  const dbp = scratch("reembed.db");
  const s = new Store(dbp);
  buildInto(s, dir);
  for (const p of s.listPackages()) indexPackage(s, p.name);
  edit(dir, USERS_SVC, (t) => t.replace("not found", "was not found"));
  const r = incrementalRefresh(s, dir, { reindex: true });
  const embedded = r.reindexed.reduce((acc, x) => acc + x.embedded, 0);
  check("[reembed] one-line body edit re-embeds exactly one chunk", embedded === 1);
  s.close();
  purge(dir, dbp, `${dbp}-wal`, `${dbp}-shm`);
}

console.log(failures === 0 ? "\nPASS — differential harness green (deterministic + incremental == full)" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
