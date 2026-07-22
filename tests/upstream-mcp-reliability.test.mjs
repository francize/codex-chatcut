import assert from "node:assert/strict";
import test from "node:test";

import { UpstreamMcpClient } from "../mcp/lib/upstream-mcp.mjs";

test("forwarded tool calls outlive the broker window without becoming unbounded", async () => {
  const upstream = new UpstreamMcpClient({
    origin: "http://127.0.0.1:49152",
    token: "test-token",
  });
  /** @type {any[] | null} */
  let captured = null;
  upstream.client.callTool = async (...args) => {
    captured = args;
    return { content: [] };
  };
  const controller = new AbortController();

  await upstream.callTool("slow_editor_tool", { example: true }, controller.signal);

  assert.ok(captured);
  const callArgs = /** @type {any[]} */ (captured);
  assert.deepEqual(callArgs[0], {
    name: "slow_editor_tool",
    arguments: { example: true },
  });
  assert.equal(callArgs[2].signal, controller.signal);
  assert.ok(
    callArgs[2].timeout > 180_000 && callArgs[2].timeout <= 190_000,
    `unexpected bounded proxy timeout: ${callArgs[2].timeout}`,
  );
});
