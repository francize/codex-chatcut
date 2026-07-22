// @ts-check

import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectUpstream } from "./verify-upstream.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} path */
async function requireFile(path) {
  await access(resolve(root, path));
}

/** @param {string} path */
async function rejectReplacement(path) {
  try {
    await access(resolve(root, path));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Replacement editor code is not allowed in the source MVP: ${path}`);
}

export async function buildSourcePlugin() {
  const upstream = await inspectUpstream();
  const plugin = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));

  for (const path of [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "mcp/server.mjs",
    "skills/open-chatcut/SKILL.md",
    "vendor/openchatcut/package.json",
  ]) {
    await requireFile(path);
  }
  for (const path of [
    "src/widget/app.ts",
    "src/widget/editor.html",
    "mcp/lib/editor-session.mjs",
    "mcp/lib/timeline-patch.mjs",
    "scripts/build-widget.mjs",
  ]) {
    await rejectReplacement(path);
  }

  if (plugin.mcpServers !== "./.mcp.json" || plugin.skills !== "./skills/") {
    throw new Error("Plugin manifest must expose the stdio proxy and open-chatcut skill.");
  }
  if (!mcp.mcpServers?.codex_chatcut) {
    throw new Error(".mcp.json must declare the codex_chatcut server.");
  }

  return {
    artifactType: "source-plugin",
    editorImplementation: "vendor/openchatcut",
    upstreamRevision: upstream.revision,
    hostPatchCount: upstream.patches.length,
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const report = await buildSourcePlugin();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report));
  else {
    console.log(
      `OK: source plugin reuses OpenChatCut ${report.upstreamRevision} with ${report.hostPatchCount} host patches.`,
    );
  }
}
