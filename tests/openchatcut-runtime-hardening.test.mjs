import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { OpenChatCutRuntime } from "../mcp/lib/openchatcut-runtime.mjs";

const stubbornSidecar = new URL(
  "./fixtures/stubborn-openchatcut-sidecar.mjs",
  import.meta.url,
).pathname;
const stubbornInvalidOriginSidecar = new URL(
  "./fixtures/stubborn-invalid-origin-sidecar.mjs",
  import.meta.url,
).pathname;
const readySidecar = new URL(
  "./fixtures/fake-openchatcut-sidecar.mjs",
  import.meta.url,
).pathname;
const stubbornErrorSidecar = new URL(
  "./fixtures/stubborn-error-openchatcut-sidecar.mjs",
  import.meta.url,
).pathname;

/** @param {string} path @param {number} [timeoutMs] */
async function waitForPid(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(path, "utf8"));
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`fixture did not publish its pid: ${path}`);
}

/** @param {number} pid */
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

/** @param {number | null} pid */
function forceCleanup(pid) {
  if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
}

test("missing workspace guidance names trusted Codex metadata and the explicit fallback", async () => {
  const runtime = new OpenChatCutRuntime({ workspaceRoot: "", sidecarEntry: readySidecar });
  await assert.rejects(
    runtime.start(),
    /trusted Codex workspace metadata.*CODEX_CHATCUT_WORKSPACE_ROOT/i,
  );
});

test("close cancels readiness and reaps a startup child that ignores SIGTERM", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-close-startup-"));
  const pidPath = resolve(workspaceRoot, ".codex-chatcut/openchatcut/stubborn-sidecar.pid");
  const runtime = new OpenChatCutRuntime({
    workspaceRoot,
    sidecarEntry: stubbornSidecar,
    startupTimeoutMs: 10_000,
    shutdownGraceMs: 50,
  });
  let pid = null;
  const startupOutcome = runtime.start().then(
    () => null,
    (error) => error,
  );

  try {
    pid = await waitForPid(pidPath);
    const startedAt = Date.now();
    await runtime.close();
    const elapsedMs = Date.now() - startedAt;
    const startupError = await startupOutcome;

    assert.ok(startupError instanceof Error);
    assert.match(startupError.message, /cancel|clos|abort/i);
    assert.ok(elapsedMs < 500, `close waited ${elapsedMs}ms for readiness timeout`);
    assert.equal(processExists(pid), false, "close returned before the child exited");
    assert.deepEqual(runtime.snapshot(), { running: false, origin: null, mcpToken: null });
  } finally {
    forceCleanup(pid);
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("invalid readiness reaps a startup child that ignores SIGTERM", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-timeout-reap-"));
  const pidPath = resolve(workspaceRoot, ".codex-chatcut/openchatcut/stubborn-sidecar.pid");
  const runtime = new OpenChatCutRuntime({
    workspaceRoot,
    sidecarEntry: stubbornInvalidOriginSidecar,
    startupTimeoutMs: 10_000,
    shutdownGraceMs: 50,
  });
  let pid = null;

  try {
    await assert.rejects(runtime.start(), /unsafe sidecar origin/);
    pid = await waitForPid(pidPath);
    assert.equal(processExists(pid), false, "failed startup leaked its child process");
    assert.deepEqual(runtime.snapshot(), { running: false, origin: null, mcpToken: null });
  } finally {
    forceCleanup(pid);
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("sidecar error IPC fails readiness immediately with a redacted diagnostic", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-ipc-error-"));
  const secretsPath = resolve(
    workspaceRoot,
    ".codex-chatcut/openchatcut/error-sidecar-secrets.json",
  );
  const runtime = new OpenChatCutRuntime({
    workspaceRoot,
    sidecarEntry: stubbornErrorSidecar,
    startupTimeoutMs: 5_000,
    shutdownGraceMs: 50,
  });
  let pid = null;

  try {
    const startedAt = Date.now();
    const error = await runtime.start().then(
      () => null,
      (startupError) => startupError,
    );
    const elapsedMs = Date.now() - startedAt;
    const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
    pid = secrets.pid;

    assert.ok(error instanceof Error);
    assert.match(error.message, /BOOT_FAILURE/);
    assert.doesNotMatch(error.message, new RegExp(secrets.mcpToken));
    assert.doesNotMatch(error.message, new RegExp(secrets.browserToken));
    assert.ok(elapsedMs < 1_000, `sidecar diagnostic took ${elapsedMs}ms`);
    assert.equal(processExists(pid), false, "runtime returned before erroring child exited");
  } finally {
    forceCleanup(pid);
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("a .codex-chatcut symlink cannot create state outside the workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-symlink-workspace-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-symlink-outside-"));
  await symlink(outsideRoot, resolve(workspaceRoot, ".codex-chatcut"), "dir");
  const runtime = new OpenChatCutRuntime({
    workspaceRoot,
    sidecarEntry: readySidecar,
    startupTimeoutMs: 1_000,
  });

  try {
    await assert.rejects(runtime.start(), /symlink|escaped|state directory/i);
    await assert.rejects(stat(resolve(outsideRoot, "openchatcut")), /ENOENT/);
  } finally {
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("an openchatcut path-segment symlink cannot select state outside the workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-segment-workspace-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-segment-outside-"));
  const stateRoot = resolve(workspaceRoot, ".codex-chatcut");
  await mkdir(stateRoot, { mode: 0o700 });
  await symlink(outsideRoot, resolve(stateRoot, "openchatcut"), "dir");
  const runtime = new OpenChatCutRuntime({
    workspaceRoot,
    sidecarEntry: readySidecar,
    startupTimeoutMs: 1_000,
  });

  try {
    await assert.rejects(runtime.start(), /symlink|escaped|state directory/i);
  } finally {
    await runtime.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("the sidecar receives only required runtime environment and generated capabilities", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-sidecar-env-"));
  const previous = new Map([
    ["CODEX_CHATCUT_UNRELATED_SECRET", process.env.CODEX_CHATCUT_UNRELATED_SECRET],
    ["NODE_OPTIONS", process.env.NODE_OPTIONS],
    ["TMPDIR", process.env.TMPDIR],
    ["LANG", process.env.LANG],
    ["LC_CODEX_CHATCUT_TEST", process.env.LC_CODEX_CHATCUT_TEST],
    ["HTTPS_PROXY", process.env.HTTPS_PROXY],
    ["NO_PROXY", process.env.NO_PROXY],
  ]);
  process.env.CODEX_CHATCUT_UNRELATED_SECRET = "must-not-reach-upstream";
  process.env.NODE_OPTIONS = "--trace-warnings";
  process.env.TMPDIR = "/tmp/codex-chatcut-allowed-temp";
  process.env.LANG = "C.UTF-8";
  process.env.LC_CODEX_CHATCUT_TEST = "allowed-locale";
  process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
  process.env.NO_PROXY = "127.0.0.1,localhost";
  const runtime = new OpenChatCutRuntime({
    workspaceRoot,
    sidecarEntry: readySidecar,
    startupTimeoutMs: 2_000,
  });

  try {
    await runtime.start();
    const snapshot = JSON.parse(await readFile(resolve(
      workspaceRoot,
      ".codex-chatcut/openchatcut/sidecar-env-snapshot.json",
    ), "utf8"));
    assert.equal(snapshot.unrelatedSecret, null);
    assert.equal(snapshot.nodeOptions, null);
    assert.equal(snapshot.path, process.env.PATH ?? null);
    assert.equal(snapshot.tmpdir, "/tmp/codex-chatcut-allowed-temp");
    assert.equal(snapshot.lang, "C.UTF-8");
    assert.equal(snapshot.lcTest, "allowed-locale");
    assert.equal(snapshot.httpsProxy, "http://proxy.invalid:3128");
    assert.equal(snapshot.noProxy, "127.0.0.1,localhost");
    assert.equal(snapshot.workspaceRoot, await realpath(workspaceRoot));
    assert.equal(
      snapshot.openChatCutDataRoot,
      resolve(await realpath(workspaceRoot), ".codex-chatcut/openchatcut"),
    );
    assert.equal(snapshot.hostMode, "codex");
    assert.equal(snapshot.hasMcpToken, true);
    assert.equal(snapshot.hasBrowserToken, true);
  } finally {
    await runtime.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
