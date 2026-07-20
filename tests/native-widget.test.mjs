import test from "node:test";

import { probeNativeWidget } from "../scripts/probe-mcp.mjs";

test("Codex can render a self-contained editor widget without a second chat", async () => {
  await probeNativeWidget();
});
