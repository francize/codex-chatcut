import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);

const SANDBOX_META_KEY = "codex/sandbox-state-meta";

/**
 * @param {string} name
 * @param {string} workspaceRoot
 * @param {Record<string, unknown>} [argumentsValue]
 */
function withWorkspace(name, workspaceRoot, argumentsValue = {}) {
  return {
    name,
    arguments: argumentsValue,
    _meta: {
      [SANDBOX_META_KEY]: { sandboxCwd: pathToFileURL(workspaceRoot).href },
    },
  };
}

/** @param {string} url */
async function eventuallyUnreachable(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(url);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`sidecar remained reachable after stdio proxy closed: ${url}`);
}

/** @param {string} path */
async function eventuallyExists(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`fixture marker was not created: ${path}`);
}

test("stdio MCP owns a loopback sidecar and preserves upstream tools without leaking credentials", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-proxy-"));
  const otherWorkspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-other-"));
  const sidecarEntry = new URL("./fixtures/fake-openchatcut-sidecar.mjs", import.meta.url).pathname;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    stderr: "pipe",
    env: {
      ...inheritedEnv,
      CODEX_CHATCUT_SIDECAR_ENTRY: sidecarEntry,
    },
  });
  const client = new Client({ name: "stdio-proxy-test", version: "0.1.0" });
  let origin;

  try {
    await client.connect(transport);
    const before = await client.listTools();
    assert.ok(before.tools.some((tool) => tool.name === "start_chatcut"));
    assert.ok(before.tools.some((tool) => tool.name === "chatcut_status"));
    assert.ok(!before.tools.some((tool) => tool.name === "create_project"));

    const [started, duplicateStart] = await Promise.all([
      client.callTool(withWorkspace("start_chatcut", workspaceRoot)),
      client.callTool(withWorkspace("start_chatcut", workspaceRoot)),
    ]);
    assert.notEqual(started.isError, true);
    assert.notEqual(duplicateStart.isError, true);
    const startedContent = /** @type {any} */ (started.structuredContent);
    const duplicateContent = /** @type {any} */ (duplicateStart.structuredContent);
    origin = startedContent.origin;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(duplicateContent.origin, origin, "concurrent starts must share one sidecar");
    assert.doesNotMatch(JSON.stringify(started), /bearer|mcpToken|browserToken|secret/i);

    const missingMetadataStatus = await client.callTool({
      name: "chatcut_status",
      arguments: {},
    });
    assert.equal(missingMetadataStatus.isError, true);
    assert.doesNotMatch(JSON.stringify(missingMetadataStatus), /127\.0\.0\.1|codex-chatcut-proxy/);

    const crossWorkspaceStatus = await client.callTool(
      withWorkspace("chatcut_status", otherWorkspaceRoot),
    );
    assert.equal(crossWorkspaceStatus.isError, true);
    assert.doesNotMatch(JSON.stringify(crossWorkspaceStatus), /127\.0\.0\.1|codex-chatcut-proxy/);

    const crossWorkspaceStart = await client.callTool(
      withWorkspace("start_chatcut", otherWorkspaceRoot),
    );
    assert.equal(crossWorkspaceStart.isError, true);
    assert.doesNotMatch(JSON.stringify(crossWorkspaceStart), /127\.0\.0\.1|codex-chatcut-proxy/);

    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);

    const after = await client.listTools();
    for (const name of ["create_project", "get_editor_url", "fake_add_item"]) {
      assert.ok(after.tools.some((tool) => tool.name === name), `${name} must be proxied`);
    }

    const crossWorkspaceCreate = await client.callTool(
      withWorkspace("create_project", otherWorkspaceRoot, { name: "Must not leak" }),
    );
    assert.equal(crossWorkspaceCreate.isError, true);
    assert.doesNotMatch(JSON.stringify(crossWorkspaceCreate), /127\.0\.0\.1|codex-chatcut-proxy/);

    const created = await client.callTool(
      withWorkspace("create_project", workspaceRoot, { name: "Reuse OpenChatCut" }),
    );
    const createdContent = /** @type {any} */ (created.structuredContent);
    assert.equal(createdContent.name, "Reuse OpenChatCut");
    assert.equal(
      createdContent.editorUrl,
      `${origin}/?host=codex#/editor/${createdContent.id}`,
    );

    const edited = await client.callTool(
      withWorkspace("fake_add_item", workspaceRoot, {
        projectId: createdContent.id,
        name: "Intro",
      }),
    );
    const editedContent = /** @type {any} */ (edited.structuredContent);
    assert.equal(editedContent.item.name, "Intro");
    assert.equal(editedContent.itemCount, 1);

    const status = await client.callTool(withWorkspace("chatcut_status", workspaceRoot));
    assert.deepEqual(status.structuredContent, { running: true, origin });
    assert.doesNotMatch(JSON.stringify(status), /bearer|token|secret/i);
  } finally {
    await client.close();
    if (origin) await eventuallyUnreachable(`${origin}/health`);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(otherWorkspaceRoot, { recursive: true, force: true });
  }
});

test("cancelling a stdio tool call cancels the forwarded upstream mutation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-cancel-"));
  const sidecarEntry = new URL("./fixtures/fake-openchatcut-sidecar.mjs", import.meta.url).pathname;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    stderr: "pipe",
    env: {
      ...inheritedEnv,
      CODEX_CHATCUT_SIDECAR_ENTRY: sidecarEntry,
    },
  });
  const client = new Client({ name: "stdio-proxy-cancel-test", version: "0.1.0" });
  const startedMarker = join(
    workspaceRoot,
    ".codex-chatcut/openchatcut/slow-mutation-started",
  );
  const committedMarker = join(
    workspaceRoot,
    ".codex-chatcut/openchatcut/slow-mutation-committed",
  );

  try {
    await client.connect(transport);
    await client.callTool(withWorkspace("start_chatcut", workspaceRoot));
    const controller = new AbortController();
    const outcome = client.callTool(
      withWorkspace("fake_slow_mutation", workspaceRoot, { delayMs: 250 }),
      undefined,
      { signal: controller.signal },
    ).then(
      () => null,
      (error) => error,
    );
    await eventuallyExists(startedMarker);
    controller.abort(new Error("test cancellation"));

    const error = await outcome;
    assert.ok(error instanceof Error);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    await assert.rejects(access(committedMarker), /ENOENT/);
  } finally {
    await client.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
