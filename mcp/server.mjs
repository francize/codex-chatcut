// @ts-check

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const widgetPath = resolve(root, "dist/widget/editor.html");
const WIDGET_URI = "ui://widget/chatcut/editor.html";

const server = new McpServer(
  { name: "codex-chatcut", version: "0.1.0" },
  {
    instructions:
      "Render the native ChatCut Editor Widget. Codex is the only conversational agent; the Widget never owns chat history or model credentials.",
  },
);

const widgetMeta = {
  ui: {
    prefersBorder: false,
    csp: { connectDomains: [], resourceDomains: ["data:", "blob:"] },
  },
  "openai/widgetDescription":
    "A native project-backed video editor surface with media, preview, inspector, and timeline regions.",
  "openai/widgetPrefersBorder": false,
  "openai/widgetCSP": {
    connect_domains: [],
    resource_domains: ["data:", "blob:"],
  },
};

registerAppResource(
  server,
  "chatcut-editor-widget",
  WIDGET_URI,
  {
    title: "ChatCut Editor",
    description: "Native Codex ChatCut editor widget.",
    _meta: widgetMeta,
  },
  async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(widgetPath, "utf8"),
        _meta: widgetMeta,
      },
    ],
  }),
);

registerAppTool(
  server,
  "render_chatcut_editor_widget",
  {
    title: "Open ChatCut Editor",
    description:
      "Render the native ChatCut editor in the current Codex task. This is read-only and does not create a second chat.",
    inputSchema: {
      displayMode: z.enum(["inline", "fullscreen"]).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
      "ui/resourceUri": WIDGET_URI,
      "openai/outputTemplate": WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Opening ChatCut editor…",
      "openai/toolInvocation/invoked": "ChatCut editor ready",
    },
  },
  async (input) => {
    const displayMode = input.displayMode ?? "fullscreen";
    return {
      content: [{ type: "text", text: "Rendered the native ChatCut Editor Widget." }],
      structuredContent: {
        version: 1,
        widget: "chatcut-editor-widget",
        displayMode,
      },
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        widgetData: { displayMode },
      },
    };
  },
);

await server.connect(new StdioServerTransport());
