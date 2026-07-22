import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dataRoot = process.env.OPENCHATCUT_DATA_ROOT;
const mcpToken = process.env.OPENCHATCUT_MCP_TOKEN;
const browserToken = process.env.OPENCHATCUT_BROWSER_TOKEN;
if (!dataRoot || !mcpToken || !browserToken) {
  throw new Error("error fixture requires sidecar data and credentials");
}

process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
await writeFile(
  resolve(dataRoot, "error-sidecar-secrets.json"),
  JSON.stringify({ mcpToken, browserToken, pid: process.pid }),
);
process.send?.({
  type: "openchatcut-error",
  message: `BOOT_FAILURE credential=${mcpToken} browser=${browserToken}`,
});
setInterval(() => {}, 60_000);
