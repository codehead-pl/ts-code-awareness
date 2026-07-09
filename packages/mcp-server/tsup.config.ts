import { defineConfig } from "tsup";
import { readFile } from "node:fs/promises";
import { preset } from "../../tsup.base.ts";

// The stdio shim ships as an executable bin. Its source shebang runs it under
// tsx for dev; the compiled bin must run under plain node. esbuild preserves the
// source shebang, so a load plugin strips it and the banner adds a node one.
export default defineConfig({
  ...preset,
  banner: { js: "#!/usr/bin/env node" },
  esbuildPlugins: [
    {
      name: "strip-dev-shebang",
      setup(build) {
        build.onLoad({ filter: /[/\\]src[/\\]index\.ts$/ }, async (args) => {
          const code = await readFile(args.path, "utf8");
          return { contents: code.replace(/^#!.*\r?\n/, ""), loader: "ts" };
        });
      },
    },
  ],
});
