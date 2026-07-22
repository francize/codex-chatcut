import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { resolveCodexWorkspaceRoot } from "../mcp/lib/workspace-root.mjs";

const SANDBOX_META_KEY = "codex/sandbox-state-meta";
const inheritedEnv = /** @type {Record<string, string>} */ (Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
));

/** @param {string} workspaceRoot */
function sandboxMeta(workspaceRoot) {
  return {
    [SANDBOX_META_KEY]: {
      sandboxCwd: pathToFileURL(workspaceRoot).href,
    },
  };
}

/** @param {Record<string, string>} env */
function makeTransport(env) {
  return new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    stderr: "pipe",
    env,
  });
}

test("the server advertises Codex sandbox metadata and binds its canonical tool-call cwd", async () => {
  const parent = await mkdtemp(join(tmpdir(), "codex-chatcut-root-parent-"));
  const workspaceRoot = join(parent, "workspace with spaces");
  const workspaceAlias = join(parent, "workspace-alias");
  await mkdir(workspaceRoot);
  // The sidecar fixture only accepts the canonical directory, proving the
  // sandboxCwd file URI was converted and realpath-resolved before startup.
  await symlink(workspaceRoot, workspaceAlias, "dir");
  const canonicalRoot = await realpath(workspaceRoot);
  const sidecarEntry = new URL("./fixtures/fake-openchatcut-sidecar.mjs", import.meta.url).pathname;
  const env = { ...inheritedEnv };
  delete env.CODEX_CHATCUT_WORKSPACE_ROOT;
  env.CODEX_CHATCUT_SIDECAR_ENTRY = sidecarEntry;
  env.CODEX_CHATCUT_EXPECTED_WORKSPACE_ROOT = canonicalRoot;
  const client = new Client({ name: "sandbox-meta-test", version: "0.1.0" });

  try {
    await client.connect(makeTransport(env));
    assert.deepEqual(
      client.getServerCapabilities()?.experimental?.[SANDBOX_META_KEY],
      {},
    );
    const listed = await client.listTools();
    const startTool = listed.tools.find((tool) => tool.name === "start_chatcut");
    assert.deepEqual(startTool?.inputSchema?.properties, {});
    assert.equal("workspaceRoot" in (startTool?.inputSchema?.properties ?? {}), false);

    const started = await client.callTool({
      name: "start_chatcut",
      arguments: {},
      _meta: sandboxMeta(workspaceAlias),
    });
    assert.notEqual(started.isError, true, JSON.stringify(started.content));
    const data = /** @type {{origin?: unknown}} */ (started.structuredContent ?? {});
    assert.match(String(data.origin), /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await client.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("the explicit workspace environment remains a non-Codex fallback", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-env-root-"));
  const sidecarEntry = new URL("./fixtures/fake-openchatcut-sidecar.mjs", import.meta.url).pathname;
  const env = {
    ...inheritedEnv,
    CODEX_CHATCUT_SIDECAR_ENTRY: sidecarEntry,
    CODEX_CHATCUT_WORKSPACE_ROOT: workspaceRoot,
    CODEX_CHATCUT_EXPECTED_WORKSPACE_ROOT: await realpath(workspaceRoot),
  };
  const client = new Client({ name: "workspace-env-test", version: "0.1.0" });

  try {
    await client.connect(makeTransport(env));
    const started = await client.callTool({ name: "start_chatcut", arguments: {} });
    assert.notEqual(started.isError, true, JSON.stringify(started.content));
  } finally {
    await client.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("sandbox metadata takes precedence over the explicit fallback", async () => {
  const metaRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-meta-root-"));
  const envRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-env-shadowed-"));
  const sidecarEntry = new URL("./fixtures/fake-openchatcut-sidecar.mjs", import.meta.url).pathname;
  const env = {
    ...inheritedEnv,
    CODEX_CHATCUT_SIDECAR_ENTRY: sidecarEntry,
    CODEX_CHATCUT_WORKSPACE_ROOT: envRoot,
    CODEX_CHATCUT_EXPECTED_WORKSPACE_ROOT: await realpath(metaRoot),
  };
  const client = new Client({ name: "workspace-meta-precedence", version: "0.1.0" });

  try {
    await client.connect(makeTransport(env));
    const started = await client.callTool({
      name: "start_chatcut",
      arguments: {},
      _meta: sandboxMeta(metaRoot),
    });
    assert.notEqual(started.isError, true, JSON.stringify(started.content));
  } finally {
    await client.close();
    await Promise.all([
      rm(metaRoot, { recursive: true, force: true }),
      rm(envRoot, { recursive: true, force: true }),
    ]);
  }
});

test("workspace resolution rejects absent, non-file, malformed, missing, and non-directory cwd", async () => {
  const file = new URL(import.meta.url);
  await assert.rejects(() => resolveCodexWorkspaceRoot(undefined, ""), /trusted Codex workspace/i);
  await assert.rejects(
    () => resolveCodexWorkspaceRoot({ [SANDBOX_META_KEY]: { sandboxCwd: "https://example.com/" } }, ""),
    /file URI/i,
  );
  await assert.rejects(
    () => resolveCodexWorkspaceRoot({ [SANDBOX_META_KEY]: { sandboxCwd: 42 } }, tmpdir()),
    /sandboxCwd/i,
  );
  await assert.rejects(
    () => resolveCodexWorkspaceRoot({ [SANDBOX_META_KEY]: { sandboxCwd: "file:///definitely/missing/codex-chatcut" } }, ""),
  );
  await assert.rejects(
    () => resolveCodexWorkspaceRoot({ [SANDBOX_META_KEY]: { sandboxCwd: file.href } }, ""),
    /directory/i,
  );
});

test("startup fails closed when neither trusted tool metadata nor an explicit root exists", async () => {
  const sidecarEntry = new URL("./fixtures/fake-openchatcut-sidecar.mjs", import.meta.url).pathname;
  const env = { ...inheritedEnv };
  delete env.CODEX_CHATCUT_WORKSPACE_ROOT;
  env.CODEX_CHATCUT_SIDECAR_ENTRY = sidecarEntry;
  const client = new Client({ name: "workspace-root-negative", version: "0.1.0" });

  try {
    await client.connect(makeTransport(env));
    const started = await client.callTool({ name: "start_chatcut", arguments: {} });
    assert.equal(started.isError, true);
    assert.match(JSON.stringify(started.content), /trusted Codex workspace|sandboxCwd/i);
  } finally {
    await client.close();
  }
});
