// @ts-check

import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WIDGET_URI = "ui://widget/chatcut/editor.html";

export async function probeNativeWidget() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-chatcut-probe", version: "0.1.0" });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.ok(
      tools.tools.some((tool) => tool.name === "render_chatcut_editor_widget"),
      "render_chatcut_editor_widget must be discoverable",
    );

    const result = await client.callTool({
      name: "render_chatcut_editor_widget",
      arguments: { displayMode: "inline" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result._meta?.["openai/outputTemplate"], WIDGET_URI);
    assert.deepEqual(result.structuredContent, {
      version: 1,
      widget: "chatcut-editor-widget",
      displayMode: "inline",
    });

    const resource = await client.readResource({ uri: WIDGET_URI });
    assert.equal(resource.contents.length, 1);
    const content = resource.contents[0];
    assert.equal(content.uri, WIDGET_URI);
    assert.match(content.mimeType ?? "", /html/);
    const html = "text" in content ? content.text : "";

    assert.match(html, /data-chatcut-region="media-library"/);
    assert.match(html, /data-chatcut-region="preview"/);
    assert.match(html, /data-chatcut-region="inspector"/);
    assert.match(html, /data-chatcut-region="timeline"/);
    assert.match(html, /data-chatcut-bridge="mcp-app"/);
    assert.match(html, /save_chatcut_selection/);
    assert.match(html, /ChatCut Editor/);
    const shellMarkup = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
    assert.doesNotMatch(shellMarkup, /ChatPanel|chat history|api[-_ ]?key|Anthropic/i);
    assert.doesNotMatch(html, /messages\.stream/i);
    assert.doesNotMatch(html, /<script\b[^>]+src=|<link\b[^>]+href=/i);

    const csp = /** @type {{connect_domains?: string[], resource_domains?: string[]}} */ (
      content._meta?.["openai/widgetCSP"] ?? {}
    );
    assert.deepEqual(csp.connect_domains ?? [], []);
    assert.deepEqual(csp.resource_domains ?? [], ["data:", "blob:"]);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await probeNativeWidget();
  console.log("OK: native ChatCut Widget is available through stdio MCP.");
}
