// Smoke test: spawn the shim as a real MCP server over stdio and drive it like
// Claude Code would. Requires the daemon to be running.
//   pnpm exec tsx packages/mcp-server/test/client.ts <projectRoot>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = process.argv[2] ?? process.cwd();

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", new URL("../src/index.ts", import.meta.url).pathname],
  env: { ...process.env, TSCA_PROJECT_ROOT: projectRoot } as Record<string, string>,
});

const client = new Client({ name: "tsca-smoke-client", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools/list:", tools.tools.map((t) => t.name).join(", "));

const found = await client.callTool({
  name: "find_symbols",
  arguments: { name: "UsersController" },
});
console.log("\nfind_symbols({name:'UsersController'}):");
console.log((found.content as Array<{ text: string }>)[0].text);

const detail = await client.callTool({
  name: "get_symbol",
  arguments: { symbol: "@fixture/api|src/users/users.controller.ts|UsersController" },
});
console.log("\nget_symbol(UsersController):");
console.log((detail.content as Array<{ text: string }>)[0].text);

await client.close();
