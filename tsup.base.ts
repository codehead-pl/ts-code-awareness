import type { Options } from "tsup";

// Shared tsup preset for every workspace package. esbuild bundles each package's
// own `./x.ts` relative imports into a single dist/index.js — which is what lets
// the source keep its `.ts` import specifiers untouched (esbuild rewrites them on
// emit; tsc/tsx never see a change). Declared dependencies (ts-morph, @codehead-pl/tsca-*,
// the MCP SDK, zod) stay external and resolve at runtime via each package's own
// `exports` map, so cross-package imports hit the compiled dist in production.
export const preset: Options = {
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  bundle: true,
  splitting: false,
  clean: true,
  dts: false, // types are served from src via the `types` export condition
  sourcemap: true,
  shims: false,
  treeshake: true,
  // tsup strips the `node:` prefix by default. That is harmless for builtins with
  // a bare alias (node:crypto → crypto) but breaks `node:sqlite` (the store's dep,
  // Node 22.5+), which has NO bare alias — node can't resolve a bare `sqlite`.
  // Keep the prefix so the compiled output imports `node:sqlite` verbatim.
  removeNodeProtocol: false,
};
