import { detectWorkspace } from "../src/workspace.ts";
const ws = detectWorkspace("fixtures/nest-monorepo");
console.log("tool:", ws.tool);
console.log("tsPaths:", ws.tsPaths?.paths);
for (const p of ws.packages) console.log(`  ${p.name}  deps=[${p.workspaceDeps.join(", ")}]  tsconfig=${p.tsconfig ? "yes" : "no"}`);
