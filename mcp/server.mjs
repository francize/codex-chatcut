// @ts-check

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ChatCutCoordinator } from "./lib/coordinator.mjs";
import {
  CODEX_SANDBOX_STATE_META_KEY,
  resolveCodexWorkspaceRoot,
} from "./lib/workspace-root.mjs";

const server = new Server(
  { name: "codex-chatcut", version: "0.2.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      experimental: { [CODEX_SANDBOX_STATE_META_KEY]: {} },
    },
    instructions:
      "Start and control the pinned OpenChatCut editor. Codex is the only conversational agent; OpenChatCut Host Mode contains no ChatPanel.",
  },
);

const coordinator = new ChatCutCoordinator({
  onToolsChanged: async () => {
    if (server.getClientCapabilities()) await server.sendToolListChanged();
  },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: await coordinator.listTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const workspaceRoot = await resolveCodexWorkspaceRoot(
      request.params._meta,
      process.env.CODEX_CHATCUT_WORKSPACE_ROOT,
    );
    return await coordinator.callTool(
      request.params.name,
      request.params.arguments ?? {},
      workspaceRoot,
      extra.signal,
    );
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await coordinator.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
process.stdin.once("end", () => void shutdown());
process.once("disconnect", () => void shutdown());

await server.connect(new StdioServerTransport());
