import { Store, buildInto } from "../src/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store = new Store(join(tmpdir(), `chk-${process.pid}.db`));
buildInto(store, "fixtures/nest-monorepo");

// call_paths sanity: BaseService.describe -> BaseService.resourceName (1 contract hop)
const from = "@fixture/core|src/base-service.ts|BaseService.describe";
const to = "@fixture/core|src/base-service.ts|BaseService.resourceName";
const q: string[][] = [[from]];
const seen = new Set([from]);
const paths: string[][] = [];
while (q.length) {
  const p = q.shift()!;
  const t = p[p.length - 1];
  if (t === to) {
    paths.push(p);
    continue;
  }
  if (p.length > 6) continue;
  for (const e of store.edgesFrom(t, ["calls"])) {
    if (e.dst.startsWith("external:") || seen.has(e.dst)) continue;
    seen.add(e.dst);
    q.push([...p, e.dst]);
  }
}
console.log("call_paths describe -> resourceName:");
for (const p of paths) console.log("  " + p.map((id) => id.split("|").pop()).join(" -> "));

store.close();
