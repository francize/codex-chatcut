import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ChatCutCoordinator } from "../mcp/lib/coordinator.mjs";
import { OpenChatCutRuntime } from "../mcp/lib/openchatcut-runtime.mjs";

const stubbornSidecar = new URL(
  "./fixtures/stubborn-openchatcut-sidecar.mjs",
  import.meta.url,
).pathname;

/** @param {string} path @param {number} [timeoutMs] */
async function waitForPid(path, timeoutMs = 2_000) {
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

/** @param {Promise<unknown>} promise @param {number} timeoutMs */
async function within(promise, timeoutMs) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("coordinator close cancels a sidecar that is still starting", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-coordinator-close-"));
  const pidPath = resolve(workspaceRoot, ".codex-chatcut/openchatcut/stubborn-sidecar.pid");
  const runtime = new OpenChatCutRuntime({
    workspaceRoot,
    sidecarEntry: stubbornSidecar,
    startupTimeoutMs: 750,
    shutdownGraceMs: 50,
  });
  const coordinator = new ChatCutCoordinator({
    runtime,
    clientFactory: () => {
      throw new Error("client must not be created before runtime readiness");
    },
  });
  let pid = null;
  const startupOutcome = coordinator.start(workspaceRoot).then(
    () => null,
    (error) => error,
  );

  try {
    pid = await waitForPid(pidPath);
    const startedAt = Date.now();
    await within(coordinator.close(), 500);
    const startupError = await startupOutcome;

    assert.ok(startupError instanceof Error);
    assert.match(startupError.message, /cancel|clos|abort/i);
    assert.ok(Date.now() - startedAt < 500, "coordinator waited for readiness timeout");
    assert.equal(processExists(pid), false, "coordinator returned before runtime child exit");
  } finally {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
    await coordinator.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("cancelling start_chatcut aborts and reaps the starting sidecar", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-start-abort-"));
  const pidPath = resolve(workspaceRoot, ".codex-chatcut/openchatcut/stubborn-sidecar.pid");
  const runtime = new OpenChatCutRuntime({
    workspaceRoot,
    sidecarEntry: stubbornSidecar,
    startupTimeoutMs: 10_000,
    shutdownGraceMs: 50,
  });
  const coordinator = new ChatCutCoordinator({
    runtime,
    clientFactory: () => {
      throw new Error("client must not be created after start cancellation");
    },
  });
  const controller = new AbortController();
  let pid = null;
  const startupOutcome = coordinator.start(workspaceRoot, controller.signal).then(
    () => null,
    (error) => error,
  );

  try {
    pid = await waitForPid(pidPath);
    const startedAt = Date.now();
    controller.abort(new Error("start_chatcut request cancelled"));
    const startupError = await within(startupOutcome, 500);

    assert.ok(startupError instanceof Error);
    assert.match(startupError.message, /start_chatcut request cancelled/i);
    assert.ok(Date.now() - startedAt < 500, "request cancellation waited for readiness timeout");
    assert.equal(processExists(pid), false, "cancelled start left its sidecar child running");
    assert.deepEqual(runtime.snapshot(), { running: false, origin: null, mcpToken: null });
  } finally {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
    await coordinator.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("coordinator close shuts runtime first and cleans a client created by in-flight startup", async () => {
  /** @type {string[]} */
  const events = [];
  /** @type {() => void} */
  let markListStarted = () => {};
  const listStarted = new Promise((resolveStarted) => {
    markListStarted = () => resolveStarted(undefined);
  });
  /** @type {(error: Error) => void} */
  let rejectList = () => {};
  let listSettled = false;
  const client = {
    async connect() {},
    async listTools() {
      markListStarted();
      return new Promise((_, reject) => {
        rejectList = (error) => {
          if (listSettled) return;
          listSettled = true;
          reject(error);
        };
      });
    },
    async callTool() {
      throw new Error("not used");
    },
    async close() {
      events.push("client.close");
      rejectList(new Error("client closed during startup"));
    },
  };
  const runtime = {
    setWorkspaceRoot() {},
    async start() {
      return { running: true, origin: "http://127.0.0.1:12345", mcpToken: "test-token" };
    },
    publicStatus() {
      return { running: true, origin: "http://127.0.0.1:12345" };
    },
    async close() {
      events.push("runtime.close");
    },
  };
  const coordinator = new ChatCutCoordinator({
    runtime: /** @type {any} */ (runtime),
    clientFactory: () => client,
  });
  const startupOutcome = coordinator.start("/trusted/workspace").then(
    () => null,
    (error) => error,
  );
  await listStarted;
  const closing = coordinator.close();

  try {
    await within(closing, 250);
    const startupError = await startupOutcome;
    assert.ok(startupError instanceof Error);
    assert.match(startupError.message, /client closed during startup/);
    assert.deepEqual(events, ["runtime.close", "client.close"]);
  } finally {
    rejectList(new Error("test cleanup"));
    await closing.catch(() => undefined);
    await startupOutcome;
  }
});

test("coordinator close owns and cleans a client while connect is still pending", async () => {
  /** @type {string[]} */
  const events = [];
  /** @type {() => void} */
  let markConnectStarted = () => {};
  const connectStarted = new Promise((resolveStarted) => {
    markConnectStarted = () => resolveStarted(undefined);
  });
  /** @type {(error: Error) => void} */
  let rejectConnect = () => {};
  let connectSettled = false;
  const client = {
    async connect() {
      markConnectStarted();
      return new Promise((_, reject) => {
        rejectConnect = (error) => {
          if (connectSettled) return;
          connectSettled = true;
          reject(error);
        };
      });
    },
    async listTools() {
      throw new Error("listTools must not run before connect");
    },
    async callTool() {
      throw new Error("not used");
    },
    async close() {
      events.push("client.close");
      rejectConnect(new Error("client closed while connecting"));
    },
  };
  const runtime = {
    setWorkspaceRoot() {},
    async start() {
      return { running: true, origin: "http://127.0.0.1:12345", mcpToken: "test-token" };
    },
    publicStatus() {
      return { running: true, origin: "http://127.0.0.1:12345" };
    },
    async close() {
      events.push("runtime.close");
    },
  };
  const coordinator = new ChatCutCoordinator({
    runtime: /** @type {any} */ (runtime),
    clientFactory: () => client,
  });
  const startupOutcome = coordinator.start("/trusted/workspace").then(
    () => null,
    (error) => error,
  );
  await connectStarted;
  const closing = coordinator.close();

  try {
    await within(closing, 250);
    const startupError = await startupOutcome;
    assert.ok(startupError instanceof Error);
    assert.match(startupError.message, /client closed while connecting/);
    assert.deepEqual(events, ["runtime.close", "client.close"]);
  } finally {
    rejectConnect(new Error("test cleanup"));
    await closing.catch(() => undefined);
    await startupOutcome;
  }
});

test("coordinator does not create a late client after shutdown has begun", async () => {
  /** @type {(runtime: {running: true, origin: string, mcpToken: string}) => void} */
  let resolveRuntimeStart = () => {};
  /** @type {() => void} */
  let markRuntimeStarted = () => {};
  const runtimeStarted = new Promise((resolveStarted) => {
    markRuntimeStarted = () => resolveStarted(undefined);
  });
  const delayedRuntime = new Promise((resolveStart) => {
    resolveRuntimeStart = resolveStart;
  });
  /** @type {string[]} */
  const events = [];
  const runtime = {
    setWorkspaceRoot() {},
    async start() {
      markRuntimeStarted();
      return delayedRuntime;
    },
    publicStatus() {
      return { running: false };
    },
    async close() {
      events.push("runtime.close");
    },
  };
  let clientFactoryCalls = 0;
  const coordinator = new ChatCutCoordinator({
    runtime: /** @type {any} */ (runtime),
    clientFactory: () => {
      clientFactoryCalls += 1;
      return {
        async connect() {},
        async listTools() {
          return [];
        },
        async callTool() {
          throw new Error("not used");
        },
        async close() {
          events.push("client.close");
        },
      };
    },
  });
  const startupOutcome = coordinator.start("/trusted/workspace").then(
    () => null,
    (error) => error,
  );
  await runtimeStarted;
  const closing = coordinator.close();
  resolveRuntimeStart({
    running: true,
    origin: "http://127.0.0.1:12345",
    mcpToken: "test-token",
  });

  await within(closing, 250);
  const startupError = await startupOutcome;
  assert.ok(startupError instanceof Error);
  assert.match(startupError.message, /clos|shut|abort/i);
  assert.equal(clientFactoryCalls, 0);
  assert.deepEqual(events, ["runtime.close"]);
});

test("a late tool-list result cannot revive startup after shutdown", async () => {
  /** @type {(tools: Array<{name: string, inputSchema: {type: string}}>) => void} */
  let resolveToolList = () => {};
  /** @type {() => void} */
  let markListStarted = () => {};
  const listStarted = new Promise((resolveStarted) => {
    markListStarted = () => resolveStarted(undefined);
  });
  const toolList = new Promise((resolveList) => {
    resolveToolList = resolveList;
  });
  /** @type {string[]} */
  const events = [];
  const client = {
    async connect() {},
    async listTools() {
      markListStarted();
      return toolList;
    },
    async callTool() {
      throw new Error("not used");
    },
    async close() {
      events.push("client.close");
    },
  };
  const runtime = {
    setWorkspaceRoot() {},
    async start() {
      return { running: true, origin: "http://127.0.0.1:12345", mcpToken: "test-token" };
    },
    publicStatus() {
      return { running: true, origin: "http://127.0.0.1:12345" };
    },
    async close() {
      events.push("runtime.close");
    },
  };
  const coordinator = new ChatCutCoordinator({
    runtime: /** @type {any} */ (runtime),
    clientFactory: () => client,
  });
  const startupOutcome = coordinator.start("/trusted/workspace").then(
    () => null,
    (error) => error,
  );
  await listStarted;
  const closing = coordinator.close();
  resolveToolList([
    { name: "late_tool", inputSchema: { type: "object" } },
  ]);

  await within(closing, 250);
  const startupError = await startupOutcome;
  assert.ok(startupError instanceof Error);
  assert.match(startupError.message, /clos|shut|abort/i);
  assert.equal((await coordinator.listTools()).some((tool) => tool.name === "late_tool"), false);
  assert.deepEqual(events, ["runtime.close", "client.close"]);
});
