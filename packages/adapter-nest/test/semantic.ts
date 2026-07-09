// Acceptance: index the fixture
// and assert NL queries return the intended symbol in the top hits, search_similar
// finds the analogous handler, and incremental re-embed is hash-gated (re-index =
// 0 embeds; a one-line body edit re-embeds exactly one chunk). Lives under
// adapter-nest/test so both adapters contribute code + schema chunks.
import { Store, buildSkeleton, registerAdapter, indexPackage, search, searchSimilar, HashingEmbedder, loadOnnxEmbedder, type Embedder, type OnnxEmbedder } from "@tsca/core";
import { nestAdapter } from "../src/index.ts";
import { prismaAdapter } from "@tsca/adapter-prisma";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";

registerAdapter(nestAdapter);
registerAdapter(prismaAdapter);

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}
const indexAll = (store: Store) => {
  const t = { embedded: 0, skipped: 0, removed: 0 };
  for (const p of store.listPackages()) {
    const r = indexPackage(store, p.name);
    t.embedded += r.embedded;
    t.skipped += r.skipped;
    t.removed += r.removed;
  }
  return t;
};
const anchors = (hits: Array<{ anchor: string }>) => hits.map((h) => h.anchor);

// ---- part 1: search quality (read-only main fixture) ---------------------
const store = new Store(join(tmpdir(), `sem-${process.pid}.db`));
buildSkeleton(store, "fixtures/nest-monorepo");
const built = indexAll(store);
console.log("index:", built, "chunks:", store.countChunks());
check("index built (>0 chunks, nothing skipped on first pass)", store.countChunks() > 0 && built.skipped === 0 && built.embedded === store.countChunks());

const byId = search(store, "find a user by id", { limit: 5 });
check("'find a user by id' → UsersService.findOne in top 5", anchors(byId).includes("@fixture/api|src/users/users.service.ts|UsersService.findOne"));
check("'find a user by id' → top hit is a find-by-id method", /findById|findOne/i.test(byId[0]?.anchor ?? ""));

const create = search(store, "create a new user", { limit: 3 });
check("'create a new user' → a create handler is the top hit", /\.create$/.test(create[0]?.anchor ?? ""));

const guard = search(store, "guard that checks the authorization header", { limit: 3 });
check("'authorization header guard' → AuthGuard.canActivate in top 3", anchors(guard).includes("@fixture/api|src/common/guards/auth.guard.ts|AuthGuard.canActivate"));

const schema = search(store, "user table email column", { kind: "schema", limit: 3 });
check("schema query → prisma:model:User is the top schema hit", schema[0]?.anchor === "prisma:model:User" && schema[0]?.kind === "schema");

const kindFilter = search(store, "user", { kind: "schema", limit: 10 });
check("kind:'schema' filter returns only schema chunks", kindFilter.every((h) => h.kind === "schema"));

const similar = searchSimilar(store, "@fixture/api|src/users/users.controller.ts|UsersController.findOne", 5);
check("search_similar(UsersController.findOne) → UsersService.findOne is nearest", similar[0]?.anchor === "@fixture/api|src/users/users.service.ts|UsersService.findOne");

// ---- part 2: hash-gated incremental re-embed -----------------------------
const reindex = indexAll(store);
check("re-index with no change is a no-op (0 embedded, 0 removed)", reindex.embedded === 0 && reindex.removed === 0 && reindex.skipped === store.countChunks());
store.close();

// one-line edit → exactly one chunk re-embedded (on a throwaway copy)
const workdir = join(tmpdir(), `sem-edit-${process.pid}`);
rmSync(workdir, { recursive: true, force: true });
cpSync("fixtures/nest-monorepo", workdir, { recursive: true });
const store2 = new Store(join(tmpdir(), `sem2-${process.pid}.db`));
buildSkeleton(store2, workdir);
indexAll(store2);

const svc = join(workdir, "packages/api/src/users/users.service.ts");
const src = readFileSync(svc, "utf8");
writeFileSync(svc, src.replace("if (!user) {", "if (!user) {\n      /* semantic-edit-marker */"));
buildSkeleton(store2, workdir); // spans refresh; chunks (sidecar) survive
const edit = indexPackage(store2, "@fixture/api");
console.log("\nafter 1-line edit to UsersService.findOne:", edit);
check("one-line body edit re-embeds exactly 1 chunk", edit.embedded === 1 && edit.removed === 0);
store2.close();
rmSync(workdir, { recursive: true, force: true });

// ---- part 3: learned local embedder --------------------------------
// A quality bench: index the SAME fixture with the hashing baseline and with the
// learned ONNX embedder, then assert the learned one ranks the intended symbol
// as the top hit on a natural-language set and beats hashing across that set. If
// the model can't be fetched/loaded the learned path is skipped (CI stays green
// on the hashing fallback); when present, the assertions below must hold.
console.log("\n-- learned embedder (W12) --");
let onnx: OnnxEmbedder | null = null;
try {
  onnx = await loadOnnxEmbedder();
  console.log(`loaded learned embedder: ${onnx.id} (dim ${onnx.dim})`);
} catch (err) {
  console.log(`  skip  learned embedder unavailable (falling back to hashing): ${(err as Error).message}`);
}

if (onnx) {
  const hashing = new HashingEmbedder();
  const indexWith = (store: Store, e: Embedder) => {
    for (const p of store.listPackages()) indexPackage(store, p.name, e);
  };
  const rankOf = (store: Store, e: Embedder, query: string, anchor: string, kind?: string): number => {
    const hits = search(store, query, { limit: 100, kind }, e);
    const i = hits.findIndex((h) => h.anchor === anchor);
    return i < 0 ? 999 : i + 1;
  };

  // Two independent indexes over the same skeleton: one per embedder.
  const hStore = new Store(join(tmpdir(), `sem-h-${process.pid}.db`));
  buildSkeleton(hStore, "fixtures/nest-monorepo");
  indexWith(hStore, hashing);
  const oStore = new Store(join(tmpdir(), `sem-o-${process.pid}.db`));
  buildSkeleton(oStore, "fixtures/nest-monorepo");
  indexWith(oStore, onnx);

  // Natural-language paraphrases with deliberately low lexical overlap with the
  // target — the regime where a learned model should beat lexical hashing.
  const A = "@fixture/api|src";
  const NL: Array<{ q: string; anchor: string; kind?: string }> = [
    { q: "retrieve a single account using its identifier", anchor: `${A}/users/users.service.ts|UsersService.findOne` },
    { q: "register a brand new member in the system", anchor: `${A}/users/users.service.ts|UsersService.create` },
    { q: "reject requests that lack valid credentials", anchor: `${A}/common/guards/auth.guard.ts|AuthGuard.canActivate` },
    { q: "restrict access based on the caller's permission level", anchor: `${A}/common/guards/roles.guard.ts|RolesGuard.canActivate` },
    { q: "add up a list of integers and return the total", anchor: `${A}/messaging/math.controller.ts|MathController.accumulate` },
    { q: "look people up by the domain part of their email address", anchor: `${A}/users/users.service.ts|UsersService.searchByEmailDomain` },
    { q: "how many records are currently stored", anchor: `${A}/users/users.service.ts|UsersService.count` },
    { q: "handle a fire-and-forget notification that a profile was added", anchor: `${A}/messaging/math.controller.ts|MathController.handleUserCreated` },
  ];

  let onnxSum = 0;
  let hashSum = 0;
  let strictlyBetter = 0;
  let everGeq = true; // learned rank <= hashing rank on every query
  for (const { q, anchor, kind } of NL) {
    const ro = rankOf(oStore, onnx, q, anchor, kind);
    const rh = rankOf(hStore, hashing, q, anchor, kind);
    onnxSum += ro;
    hashSum += rh;
    if (ro < rh) strictlyBetter += 1;
    if (ro > rh) everGeq = false;
    console.log(`  learned=${String(ro).padStart(3)} hashing=${String(rh).padStart(3)}  ${ro < rh ? "WIN " : ro > rh ? "LOSS" : "tie "}  ${q}`);
  }
  const onnxMean = onnxSum / NL.length;
  const hashMean = hashSum / NL.length;
  console.log(`  learned meanRank=${onnxMean.toFixed(2)}  hashing meanRank=${hashMean.toFixed(2)}  strictlyBetter=${strictlyBetter}/${NL.length}`);

  check("learned embedder ranks each NL target at least as high as hashing", everGeq);
  check("learned embedder strictly beats hashing on several NL queries", strictlyBetter >= 4);
  check("learned embedder has a strictly better mean rank than hashing", onnxMean < hashMean);

  // The learned embedder returns the intended symbol as the TOP hit for clearly
  // semantic queries where lexical hashing cannot.
  const TOP: Array<{ q: string; anchor: string; kind?: string }> = [
    { q: "reject requests that lack valid credentials", anchor: `${A}/common/guards/auth.guard.ts|AuthGuard.canActivate` },
    { q: "restrict access based on the caller's permission level", anchor: `${A}/common/guards/roles.guard.ts|RolesGuard.canActivate` },
    { q: "add up a list of integers and return the total", anchor: `${A}/messaging/math.controller.ts|MathController.accumulate` },
    { q: "handle a fire-and-forget notification that a profile was added", anchor: `${A}/messaging/math.controller.ts|MathController.handleUserCreated` },
  ];
  for (const { q, anchor, kind } of TOP) {
    check(`learned top hit for '${q}'`, rankOf(oStore, onnx, q, anchor, kind) === 1);
  }

  // Re-embed on model change: an index built with hashing, re-indexed with the
  // learned embedder, re-embeds every chunk of the package (meta/gate machinery).
  const apiChunks = hStore.chunkHashes("@fixture/api").size;
  const swap = indexPackage(hStore, "@fixture/api", onnx);
  check("switching embedder model re-embeds every chunk (0 skipped)", swap.embedded === apiChunks && swap.skipped === 0);
  const swapAgain = indexPackage(hStore, "@fixture/api", onnx);
  check("re-index with the same learned model is a no-op", swapAgain.embedded === 0 && swapAgain.skipped === apiChunks);
  hStore.close();
  oStore.close();

  // One-line body edit still re-embeds exactly one chunk under the learned model.
  const ewd = join(tmpdir(), `sem-onnx-edit-${process.pid}`);
  rmSync(ewd, { recursive: true, force: true });
  cpSync("fixtures/nest-monorepo", ewd, { recursive: true });
  const eStore = new Store(join(tmpdir(), `sem-onnx-e-${process.pid}.db`));
  buildSkeleton(eStore, ewd);
  indexPackage(eStore, "@fixture/api", onnx);
  const esvc = join(ewd, "packages/api/src/users/users.service.ts");
  writeFileSync(esvc, readFileSync(esvc, "utf8").replace("if (!user) {", "if (!user) {\n      /* onnx-edit-marker */"));
  buildSkeleton(eStore, ewd);
  const oedit = indexPackage(eStore, "@fixture/api", onnx);
  console.log("  after 1-line edit (learned):", oedit);
  check("one-line body edit re-embeds exactly 1 chunk under the learned model", oedit.embedded === 1 && oedit.removed === 0);
  eStore.close();
  rmSync(ewd, { recursive: true, force: true });

  onnx.close();
}

console.log(failures === 0 ? "\nPASS — all semantic-search acceptance checks green" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
