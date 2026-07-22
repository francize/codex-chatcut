import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const token = process.env.OPENCHATCUT_MCP_TOKEN;
if (process.env.OPENCHATCUT_HOST_MODE !== "codex") {
  throw new Error("fake sidecar requires OPENCHATCUT_HOST_MODE=codex");
}
if (
  process.env.CODEX_CHATCUT_EXPECTED_WORKSPACE_ROOT &&
  process.env.CODEX_CHATCUT_WORKSPACE_ROOT !== process.env.CODEX_CHATCUT_EXPECTED_WORKSPACE_ROOT
) {
  throw new Error("fake sidecar received the wrong MCP workspace root");
}
const projects = [];
const items = [];
const dataRoot = process.env.OPENCHATCUT_DATA_ROOT;

if (dataRoot) {
  await writeFile(resolve(dataRoot, "sidecar-env-snapshot.json"), JSON.stringify({
    unrelatedSecret: process.env.CODEX_CHATCUT_UNRELATED_SECRET ?? null,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    path: process.env.PATH ?? null,
    tmpdir: process.env.TMPDIR ?? null,
    lang: process.env.LANG ?? null,
    lcTest: process.env.LC_CODEX_CHATCUT_TEST ?? null,
    httpsProxy: process.env.HTTPS_PROXY ?? null,
    noProxy: process.env.NO_PROXY ?? null,
    workspaceRoot: process.env.CODEX_CHATCUT_WORKSPACE_ROOT ?? null,
    openChatCutDataRoot: process.env.OPENCHATCUT_DATA_ROOT ?? null,
    hostMode: process.env.OPENCHATCUT_HOST_MODE ?? null,
    hasMcpToken: Boolean(process.env.OPENCHATCUT_MCP_TOKEN),
    hasBrowserToken: Boolean(process.env.OPENCHATCUT_BROWSER_TOKEN),
  }));
}

const tools = [
  {
    name: "create_project",
    description: "Create a fake upstream project.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "get_editor_url",
    description: "Return the fake editor URL.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "fake_add_item",
    description: "Exercise a proxied upstream editor mutation.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" }, name: { type: "string" } },
      required: ["projectId", "name"],
    },
  },
  {
    name: "fake_slow_mutation",
    description: "Wait before recording a fake editor mutation.",
    inputSchema: {
      type: "object",
      properties: { delayMs: { type: "number" } },
      required: ["delayMs"],
    },
  },
];

/** @param {string} origin */
function makeMcpServer(origin) {
  const server = new Server(
    { name: "fake-openchatcut", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    let result;
    if (request.params.name === "create_project") {
      const project = { id: `project_${projects.length + 1}`, name: args.name };
      projects.push(project);
      result = { ...project, editorUrl: `${origin}/?host=codex#/editor/${project.id}` };
    } else if (request.params.name === "get_editor_url") {
      result = {
        projectId: args.projectId,
        editorUrl: `${origin}/?host=codex#/editor/${args.projectId}`,
      };
    } else if (request.params.name === "fake_add_item") {
      const item = { id: `item_${items.length + 1}`, ...args };
      items.push(item);
      result = { ok: true, item, itemCount: items.length };
    } else if (request.params.name === "fake_slow_mutation") {
      if (!dataRoot) throw new Error("fake slow mutation requires OPENCHATCUT_DATA_ROOT");
      await writeFile(resolve(dataRoot, "slow-mutation-started"), "started");
      await new Promise((resolveDelay, rejectDelay) => {
        const timer = setTimeout(resolveDelay, Number(args.delayMs));
        extra.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          rejectDelay(new Error("fake slow mutation cancelled"));
        }, { once: true });
      });
      await writeFile(resolve(dataRoot, "slow-mutation-committed"), "committed");
      result = { ok: true };
    } else {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown fake tool ${request.params.name}` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  });
  return server;
}

/** @type {Server | null} */
let mcpServer = null;
/** @type {StreamableHTTPServerTransport | null} */
let mcpTransport = null;

/** @param {string} origin */
async function ensureMcpEndpoint(origin) {
  if (mcpServer && mcpTransport) return { server: mcpServer, transport: mcpTransport };
  const server = makeMcpServer(origin);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport);
  mcpServer = server;
  mcpTransport = transport;
  return { server, transport };
}

const httpServer = createServer(async (request, response) => {
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("fake sidecar address missing");
  const origin = `http://127.0.0.1:${address.port}`;
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url?.startsWith("/?host=codex")) {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Fake OpenChatCut</title>");
    return;
  }
  if (request.url !== "/api/external-mcp/mcp") {
    response.writeHead(404).end();
    return;
  }
  if (!token || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const { transport } = await ensureMcpEndpoint(origin);
  await transport.handleRequest(request, response);
});

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("fake sidecar did not bind");
  process.send?.({ type: "openchatcut-ready", origin: `http://127.0.0.1:${address.port}` });
});

async function close() {
  await mcpTransport?.close().catch(() => undefined);
  await mcpServer?.close().catch(() => undefined);
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
process.on("disconnect", () => void close());
