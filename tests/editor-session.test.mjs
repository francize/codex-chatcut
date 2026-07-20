import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);

/** @param {string} workspaceRoot */
async function connect(workspaceRoot) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    stderr: "pipe",
    env: { ...inheritedEnv, CODEX_CHATCUT_WORKSPACE_ROOT: workspaceRoot },
  });
  const client = new Client({ name: "editor-session-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/**
 * @param {Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<any>}
 */
async function callOk(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

test("Editor Session persists project and selection while enforcing its workspace boundary", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "chatcut-workspace-"));
  const projectRoot = join(workspaceRoot, "video-project");
  const outsideRoot = await mkdtemp(join(tmpdir(), "chatcut-outside-"));
  await mkdir(projectRoot);

  let client = await connect(workspaceRoot);
  try {
    const tools = await client.listTools();
    for (const name of [
      "open_chatcut_session",
      "get_chatcut_session",
      "save_chatcut_selection",
      "get_chatcut_context",
    ]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `${name} must be discoverable`);
    }

    const opened = await callOk(client, "open_chatcut_session", { projectRoot });
    assert.equal(opened.projectRoot, await realpath(projectRoot));
    assert.equal(opened.document.schemaVersion, 1);
    assert.equal(opened.document.revision, 0);
    assert.deepEqual(opened.document.timeline, { id: "main", fps: 30, items: [] });
    assert.match(opened.sessionId, /^session_/);

    const rendered = await callOk(client, "render_chatcut_editor_widget", {
      displayMode: "inline",
      sessionId: opened.sessionId,
    });
    assert.equal(rendered.sessionId, opened.sessionId);
    assert.equal(rendered.projectId, opened.document.projectId);
    assert.equal(rendered.revision, 0);

    const saved = await callOk(client, "save_chatcut_selection", {
      sessionId: opened.sessionId,
      selection: {
        timelineId: "main",
        selectedItemIds: [],
        playheadFrame: 12,
        range: { startFrame: 10, endFrame: 20 },
        revision: 0,
      },
    });
    assert.equal(saved.ok, true);

    const context = await callOk(client, "get_chatcut_context", {
      sessionId: opened.sessionId,
    });
    assert.deepEqual(context.selection, {
      timelineId: "main",
      selectedItemIds: [],
      playheadFrame: 12,
      range: { startFrame: 10, endFrame: 20 },
      revision: 0,
    });
    assert.equal(context.document.revision, 0);

    const unknownItem = await client.callTool({
      name: "save_chatcut_selection",
      arguments: {
        sessionId: opened.sessionId,
        selection: {
          timelineId: "main",
          selectedItemIds: ["item_missing"],
          playheadFrame: 0,
          range: null,
          revision: 0,
        },
      },
    });
    assert.equal(unknownItem.isError, true);

    const escapedRoot = await client.callTool({
      name: "open_chatcut_session",
      arguments: { projectRoot: outsideRoot },
    });
    assert.equal(escapedRoot.isError, true);

    await client.close();
    client = await connect(workspaceRoot);

    const reopened = await callOk(client, "open_chatcut_session", { projectRoot });
    assert.notEqual(reopened.sessionId, opened.sessionId);
    const restored = await callOk(client, "get_chatcut_context", {
      sessionId: reopened.sessionId,
    });
    assert.deepEqual(restored.selection, context.selection);
    assert.deepEqual(restored.document, context.document);
  } finally {
    await client.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
