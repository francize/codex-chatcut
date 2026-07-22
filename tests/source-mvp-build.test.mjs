import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** @param {URL} url */
async function isPresent(url) {
  try {
    await access(url);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

test("the source MVP packages OpenChatCut integration without a replacement editor", async () => {
  const root = new URL("../", import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const pluginJson = JSON.parse(
    await readFile(new URL(".codex-plugin/plugin.json", root), "utf8"),
  );
  const mcpConfig = JSON.parse(await readFile(new URL(".mcp.json", root), "utf8"));

  assert.equal(pluginJson.version, "0.2.0");
  assert.equal(packageJson.version, pluginJson.version);
  assert.equal(packageJson.engines.node, ">=24 <25");
  assert.equal(packageJson.scripts.build, "node scripts/build.mjs");
  assert.match(mcpConfig.mcpServers.codex_chatcut.description, /OpenChatCut sidecar/i);

  for (const path of [
    "src/widget/app.ts",
    "src/widget/editor.html",
    "mcp/lib/editor-session.mjs",
    "mcp/lib/timeline-patch.mjs",
    "scripts/build-widget.mjs",
  ]) {
    assert.equal(await isPresent(new URL(path, root)), false, `${path} must stay removed`);
  }

  const { stdout } = await execFileAsync(process.execPath, ["scripts/build.mjs", "--json"], {
    cwd: new URL(root).pathname,
    encoding: "utf8",
  });
  const report = JSON.parse(stdout);
  assert.equal(report.artifactType, "source-plugin");
  assert.equal(report.editorImplementation, "vendor/openchatcut");
  assert.match(report.upstreamRevision, /^[0-9a-f]{40}$/);
});
