import assert from "node:assert/strict";
import test from "node:test";

import { ChatCutCoordinator } from "../mcp/lib/coordinator.mjs";

/** @param {string} name @returns {import("@modelcontextprotocol/sdk/types.js").Tool} */
function tool(name) {
  return { name, inputSchema: { type: "object", properties: {} } };
}

test("a restarted sidecar replaces the client bound to the crashed process", async () => {
  const runtimes = [
    { running: true, origin: "http://127.0.0.1:41001", mcpToken: "token-one" },
    { running: true, origin: "http://127.0.0.1:41002", mcpToken: "token-two" },
  ];
  let generation = 0;
  /** @type {string[]} */
  const events = [];
  const runtime = {
    setWorkspaceRoot() {},
    async start() {
      return runtimes[generation];
    },
    publicStatus() {
      return { running: true, origin: runtimes[generation].origin };
    },
    async close() {},
  };
  const coordinator = new ChatCutCoordinator({
    runtime: /** @type {any} */ (runtime),
    clientFactory: (binding) => {
      const label = binding.origin.endsWith("41001") ? "one" : "two";
      return {
        async connect() {
          events.push(`${label}.connect`);
        },
        async listTools() {
          events.push(`${label}.listTools`);
          return [tool(`tool_${label}`)];
        },
        async callTool() {
          throw new Error("not used");
        },
        async close() {
          events.push(`${label}.close`);
        },
      };
    },
  });

  try {
    await coordinator.start("/trusted/workspace");
    generation = 1;
    await coordinator.start("/trusted/workspace");

    const names = (await coordinator.listTools()).map((entry) => entry.name);
    assert.ok(names.includes("tool_two"));
    assert.ok(!names.includes("tool_one"));
    assert.deepEqual(events, [
      "one.connect",
      "one.listTools",
      "one.close",
      "two.connect",
      "two.listTools",
    ]);
  } finally {
    await coordinator.close();
  }
});

test("an older concurrent tool refresh cannot overwrite a newer result", async () => {
  /** @type {Array<(tools: import("@modelcontextprotocol/sdk/types.js").Tool[]) => void>} */
  const pending = [];
  let listCalls = 0;
  const runtime = {
    setWorkspaceRoot() {},
    async start() {
      return { running: true, origin: "http://127.0.0.1:42001", mcpToken: "token" };
    },
    publicStatus() {
      return { running: true, origin: "http://127.0.0.1:42001" };
    },
    async close() {},
  };
  const client = {
    async connect() {},
    async listTools() {
      listCalls += 1;
      if (listCalls === 1) return [tool("initial_tool")];
      return new Promise((resolveList) => pending.push(resolveList));
    },
    async callTool() {
      throw new Error("not used");
    },
    async close() {},
  };
  const coordinator = new ChatCutCoordinator({
    runtime: /** @type {any} */ (runtime),
    clientFactory: () => client,
  });

  try {
    await coordinator.start("/trusted/workspace");
    const older = coordinator.callTool(
      "refresh_chatcut_tools",
      {},
      "/trusted/workspace",
    );
    const newer = coordinator.callTool(
      "refresh_chatcut_tools",
      {},
      "/trusted/workspace",
    );
    assert.equal(pending.length, 2);

    pending[1]([tool("newer_tool")]);
    await newer;
    pending[0]([tool("older_tool")]);
    await older;

    const names = (await coordinator.listTools()).map((entry) => entry.name);
    assert.ok(names.includes("newer_tool"));
    assert.ok(!names.includes("older_tool"));
  } finally {
    for (const resolveList of pending) resolveList([]);
    await coordinator.close();
  }
});
