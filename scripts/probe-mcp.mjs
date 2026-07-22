// @ts-check

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);

export async function probeOpenChatCutProxy() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-probe-"));
  const sidecarEntry = new URL("../tests/fixtures/fake-openchatcut-sidecar.mjs", import.meta.url)
    .pathname;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    stderr: "pipe",
    env: {
      ...inheritedEnv,
      CODEX_CHATCUT_SIDECAR_ENTRY: sidecarEntry,
      CODEX_CHATCUT_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  const client = new Client({ name: "codex-chatcut-probe", version: "0.1.0" });

  try {
    await client.connect(transport);
    const before = await client.listTools();
    assert.ok(before.tools.some((tool) => tool.name === "start_chatcut"));
    assert.ok(!before.tools.some((tool) => tool.name === "create_project"));

    const started = await client.callTool({ name: "start_chatcut", arguments: {} });
    assert.notEqual(started.isError, true);
    assert.doesNotMatch(JSON.stringify(started), /bearer|mcpToken|browserToken|secret/i);

    const after = await client.listTools();
    for (const name of ["create_project", "get_editor_url", "fake_add_item"]) {
      assert.ok(after.tools.some((tool) => tool.name === name), `${name} must be proxied`);
    }

    const created = await client.callTool({
      name: "create_project",
      arguments: { name: "Codex ChatCut Probe" },
    });
    assert.notEqual(created.isError, true);
    const result = /** @type {{editorUrl?: unknown}} */ (created.structuredContent ?? {});
    assert.match(String(result.editorUrl), /^http:\/\/127\.0\.0\.1:\d+\/\?host=codex#\/editor\//);
    assert.doesNotMatch(JSON.stringify(created), /bearer|token|secret/i);
  } finally {
    await client.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await probeOpenChatCutProxy();
  console.log("OK: stdio MCP owns and proxies a windowless OpenChatCut sidecar.");
}
