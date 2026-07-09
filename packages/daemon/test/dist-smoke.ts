// Acceptance: the engine ships as
// compiled JS, not tsx-only. This smoke starts the daemon from the COMPILED dist
// output — `node packages/daemon/dist/index.js`, plain node, no tsx, and no
// `development` export condition — so every `@tsca/*` import resolves to that
// package's dist/index.js (production `default` condition). It then drives real
// tool calls end-to-end over HTTP against the monorepo fixture: a core tool
// (overview) and an adapter tool (nest_routes), proving the compiled adapters
// load and run too. If dist is stale/missing the daemon fails to import and the
// smoke fails — which is the point.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const daemonDist = join(repoRoot, "packages/daemon/dist/index.js");
const projectRoot = join(repoRoot, "fixtures/nest-monorepo");
const PORT = Number(process.env.TSCA_SMOKE_PORT ?? 47699);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}`);
  if (!cond) failures += 1;
}

// Every package's compiled entry must exist — the daemon can only import them if
// the whole workspace was built.
for (const p of ["core", "adapter-nest", "adapter-prisma", "live-data", "daemon"]) {
  check(`dist built: ${p}`, existsSync(join(repoRoot, "packages", p, "dist/index.js")));
}
if (!existsSync(daemonDist)) {
  console.error("\nFAIL — daemon dist not built; run `pnpm build` first");
  process.exit(1);
}

async function rpc(tool: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-project-root": projectRoot },
    body: JSON.stringify({ tool, args }),
  });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error ?? `daemon error ${res.status}`);
  return body.result;
}

async function waitHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Start the daemon from COMPILED JS. Deliberately plain `node` (no tsx) and no
// `--conditions=development`, so cross-package imports hit dist, not src.
const daemon = spawn(process.execPath, [daemonDist], {
  cwd: repoRoot,
  env: { ...process.env, TSCA_PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});

let exitedEarly: number | null = null;
daemon.on("exit", (code) => {
  if (failures === 0 && exitedEarly === null) exitedEarly = code ?? -1;
});

function shutdown(): void {
  if (!daemon.killed) daemon.kill("SIGTERM");
}

try {
  const healthy = await waitHealthy(20_000);
  check("compiled daemon booted and serves /health", healthy);
  if (!healthy) throw new Error("daemon never became healthy");

  // Core tool end-to-end (first call also builds the fixture map).
  const overview = (await rpc("overview", {})) as {
    workspace?: { packages?: unknown[] };
    counts?: { symbols?: number; edges?: number };
  };
  check("overview returns packages", Array.isArray(overview.workspace?.packages) && overview.workspace!.packages!.length > 0);
  check("overview reports symbols", (overview.counts?.symbols ?? 0) > 0);

  // Adapter tool end-to-end — proves the compiled Nest adapter dist loaded.
  const routes = (await rpc("nest_routes", {})) as { routes?: Array<{ method?: string; path?: string }> };
  const routeList = routes.routes ?? (Array.isArray(routes) ? (routes as unknown as Array<{ method?: string; path?: string }>) : []);
  check("nest_routes returns the fixture route table", routeList.length > 0);
  check(
    "nest_routes includes GET /users",
    routeList.some((r) => r.method === "GET" && r.path === "/users"),
  );
} catch (err) {
  console.error("smoke error:", err instanceof Error ? err.message : String(err));
  failures += 1;
} finally {
  shutdown();
}

if (exitedEarly !== null) {
  console.error(`\nFAIL — compiled daemon exited early with code ${exitedEarly}`);
  process.exit(1);
}
console.log(failures === 0 ? "\nPASS — daemon serves real tool calls from compiled dist" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
