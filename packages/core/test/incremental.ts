// Verify fingerprint-based incremental: no-op when unchanged, rebuild on change.
import { Store, refresh } from "../src/index.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "tsca-inc-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "inc-fixture" }));
writeFileSync(join(root, "src", "a.ts"), "export class A { foo(): void {} }\n");
writeFileSync(join(root, "src", "b.ts"), "export function b(): number { return 1; }\n");

const store = new Store(join(root, ".map.db"));

console.log("1) first refresh:", refresh(store, root), "symbols:", store.countSymbols());
console.log("2) refresh, no change:", refresh(store, root));

writeFileSync(join(root, "src", "a.ts"), "export class A { foo(): void {} bar(): void {} }\n");
console.log("3) refresh after editing a.ts:", refresh(store, root), "symbols:", store.countSymbols());

console.log("4) refresh, no change again:", refresh(store, root));

store.close();
