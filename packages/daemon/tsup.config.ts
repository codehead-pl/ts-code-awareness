import { defineConfig } from "tsup";
import { preset } from "../../tsup.base.ts";

// The daemon ships as an executable bin (`tsca-daemon`), started by the plugin's
// SessionStart hook via `npx`. Its source has no shebang, so the banner adds a
// node one; tsup marks the output executable because it begins with a shebang.
export default defineConfig({
  ...preset,
  banner: { js: "#!/usr/bin/env node" },
});
