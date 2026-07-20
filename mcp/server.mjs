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

import { EditorSessionManager, SelectionContextSchema } from "./lib/editor-session.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const widgetPath = resolve(root, "dist/widget/editor.html");
const WIDGET_URI = "ui://widget/chatcut/editor.html";
const sessions = new EditorSessionManager({
  allowedWorkspaceRoot: process.env.CODEX_CHATCUT_WORKSPACE_ROOT,
});

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
      sessionId: z.string().trim().min(1).optional(),
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
    const session = input.sessionId ? sessions.inspect(input.sessionId) : null;
    const widgetData = {
      displayMode,
      ...(session
        ? {
            sessionId: session.sessionId,
            projectId: session.document.projectId,
            revision: session.document.revision,
          }
        : {}),
    };
    return {
      content: [{ type: "text", text: "Rendered the native ChatCut Editor Widget." }],
      structuredContent: {
        version: 1,
        widget: "chatcut-editor-widget",
        ...widgetData,
      },
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        widgetData,
      },
    };
  },
);

server.registerTool(
  "open_chatcut_session",
  {
    title: "Open ChatCut Project",
    description:
      "Open one existing project directory as a project-bound Editor Session. Later tools use only the returned opaque session ID.",
    inputSchema: { projectRoot: z.string().trim().min(1) },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: { ui: { visibility: ["model", "app"] } },
  },
  async ({ projectRoot }) => {
    const state = await sessions.open(projectRoot);
    return {
      content: [{ type: "text", text: `Opened ChatCut project ${state.document.projectId}.` }],
      structuredContent: state,
    };
  },
);

server.registerTool(
  "get_chatcut_session",
  {
    title: "Get ChatCut Session",
    description: "Read the current Project Document and Selection Context for an open Editor Session.",
    inputSchema: { sessionId: z.string().trim().min(1) },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { visibility: ["model", "app"] } },
  },
  async ({ sessionId }) => {
    const state = sessions.inspect(sessionId);
    return {
      content: [{ type: "text", text: `ChatCut Revision ${state.document.revision}.` }],
      structuredContent: state,
    };
  },
);

server.registerTool(
  "save_chatcut_selection",
  {
    title: "Save ChatCut Selection",
    description:
      "Persist the Widget's selected timeline items, playhead, range, and observed Revision for the current Editor Session.",
    inputSchema: {
      sessionId: z.string().trim().min(1),
      selection: SelectionContextSchema,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ sessionId, selection }) => {
    const result = await sessions.saveSelection(sessionId, selection);
    return {
      content: [{ type: "text", text: "Saved ChatCut Selection Context." }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "get_chatcut_context",
  {
    title: "Get ChatCut Selection Context",
    description:
      "Read the authoritative Project Document and current Selection Context before proposing an edit.",
    inputSchema: { sessionId: z.string().trim().min(1) },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ sessionId }) => {
    const context = sessions.context(sessionId);
    const selected = context.selection.selectedItemIds.length;
    return {
      content: [
        {
          type: "text",
          text: `ChatCut context at Revision ${context.document.revision}; ${selected} item(s) selected.`,
        },
      ],
      structuredContent: context,
    };
  },
);

await server.connect(new StdioServerTransport());
