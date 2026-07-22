// @ts-check

import { OpenChatCutRuntime } from "./openchatcut-runtime.mjs";
import { UpstreamMcpClient } from "./upstream-mcp.mjs";

/** @typedef {import("@modelcontextprotocol/sdk/types.js").Tool} Tool */
/** @typedef {import("@modelcontextprotocol/sdk/types.js").CallToolResult} CallToolResult */
/**
 * @typedef {{
 *   connect(): Promise<void>,
 *   listTools(signal?: AbortSignal): Promise<Tool[]>,
 *   callTool(name: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<any>,
 *   close(): Promise<void>,
 * }} UpstreamClient
 */

/** @type {Tool[]} */
const HOST_TOOLS = [
  {
    name: "start_chatcut",
    title: "Start ChatCut",
    description:
      "Start the pinned windowless OpenChatCut sidecar for this workspace. Returns a credential-free loopback origin.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "chatcut_status",
    title: "ChatCut Status",
    description: "Report whether the workspace's OpenChatCut sidecar is running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "refresh_chatcut_tools",
    title: "Refresh ChatCut Tools",
    description:
      "Refresh native OpenChatCut tools after the editor page registers its project bridge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

/** @param {string} text @param {Record<string, unknown>} structuredContent @returns {CallToolResult} */
function toolResult(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

export class ChatCutCoordinator {
  /**
   * @param {{
   *   runtime?: OpenChatCutRuntime,
   *   clientFactory?: (runtime: {running: true, origin: string, mcpToken: string}) => UpstreamClient,
   *   onToolsChanged?: () => void | Promise<void>,
   * }} [options]
   */
  constructor(options = {}) {
    // Workspace selection belongs to the current tools/call, not the MCP
    // process cwd. An empty explicit value prevents the runtime from eagerly
    // capturing the environment fallback before Codex metadata is inspected.
    this.runtime = options.runtime ?? new OpenChatCutRuntime({ workspaceRoot: "" });
    this.clientFactory = options.clientFactory ?? ((runtime) => new UpstreamMcpClient({
      origin: runtime.origin,
      token: runtime.mcpToken,
    }));
    this.onToolsChanged = options.onToolsChanged ?? (() => undefined);
    /** @type {string | null} */
    this.boundWorkspaceRoot = null;
    /** @type {UpstreamClient | null} */
    this.client = null;
    /** @type {string | null} */
    this.clientBinding = null;
    /** @type {Tool[]} */
    this.upstreamTools = [];
    this.refreshGeneration = 0;
    /** @type {Promise<{running: true, origin: string}> | null} */
    this.starting = null;
    this.closed = false;
  }

  /** @param {string} workspaceRoot @param {AbortSignal} [signal] */
  async start(workspaceRoot, signal) {
    if (this.closed) throw new Error("Codex ChatCut coordinator is closing or closed.");
    this.assertWorkspaceAccess(workspaceRoot);
    if (!this.boundWorkspaceRoot) {
      this.runtime.setWorkspaceRoot(workspaceRoot);
      this.boundWorkspaceRoot = workspaceRoot;
    }
    if (this.starting) return this.starting;
    const starting = this.startOnce(signal);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  /** @param {AbortSignal} [signal] @returns {Promise<{running: true, origin: string}>} */
  async startOnce(signal) {
    const runtime = await this.runtime.start(signal);
    if (this.closed) throw new Error("Codex ChatCut coordinator closed during startup.");
    if (!runtime.running) throw new Error("OpenChatCut sidecar did not enter running state.");
    const runtimeBinding = `${runtime.origin}\0${runtime.mcpToken}`;
    if (this.client && this.clientBinding !== runtimeBinding) {
      const staleClient = this.client;
      this.client = null;
      this.clientBinding = null;
      this.upstreamTools = [];
      this.refreshGeneration += 1;
      await staleClient.close().catch(() => undefined);
    }
    if (!this.client) {
      const client = this.clientFactory(runtime);
      this.client = client;
      this.clientBinding = runtimeBinding;
      try {
        await client.connect();
      } catch (error) {
        if (this.client === client) {
          this.client = null;
          this.clientBinding = null;
          await client.close().catch(() => undefined);
        }
        throw error;
      }
      if (this.closed || this.client !== client) {
        throw new Error("Codex ChatCut coordinator closed during startup.");
      }
    }
    await this.refreshTools(signal);
    if (this.closed) throw new Error("Codex ChatCut coordinator closed during startup.");
    return { running: true, origin: runtime.origin };
  }

  /** @param {AbortSignal} [signal] */
  async refreshTools(signal) {
    const client = this.client;
    if (!client) throw new Error("ChatCut is not running; call start_chatcut first.");
    const generation = ++this.refreshGeneration;
    const upstream = await client.listTools(signal);
    if (this.closed || this.client !== client) {
      throw new Error("Codex ChatCut coordinator closed during startup.");
    }
    if (generation !== this.refreshGeneration) return this.upstreamTools;
    const hostNames = new Set(HOST_TOOLS.map((tool) => tool.name));
    const collision = upstream.find((tool) => hostNames.has(tool.name));
    if (collision) throw new Error(`OpenChatCut tool collides with host tool: ${collision.name}`);
    this.upstreamTools = upstream;
    await this.onToolsChanged();
    return upstream;
  }

  async listTools() {
    return [...HOST_TOOLS, ...this.upstreamTools];
  }

  /** @param {string} workspaceRoot */
  assertWorkspaceAccess(workspaceRoot) {
    if (!workspaceRoot) {
      throw new Error("Codex ChatCut requires a trusted workspace for every tool call.");
    }
    if (this.boundWorkspaceRoot && this.boundWorkspaceRoot !== workspaceRoot) {
      throw new Error(
        "Codex ChatCut is bound to a different workspace; start a separate MCP process.",
      );
    }
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown> | undefined} argumentsValue
   * @param {string} workspaceRoot
   * @param {AbortSignal} [signal]
   */
  async callTool(name, argumentsValue, workspaceRoot, signal) {
    this.assertWorkspaceAccess(workspaceRoot);
    if (name === "start_chatcut") {
      const status = await this.start(workspaceRoot, signal);
      return toolResult(`OpenChatCut sidecar is ready at ${status.origin}.`, status);
    }
    if (name === "chatcut_status") {
      const status = this.runtime.publicStatus();
      return toolResult(
        status.running ? `OpenChatCut is running at ${status.origin}.` : "OpenChatCut is stopped.",
        status,
      );
    }
    if (name === "refresh_chatcut_tools") {
      const tools = await this.refreshTools(signal);
      return toolResult(`Refreshed ${tools.length} native OpenChatCut tools.`, {
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
      });
    }
    if (!this.client || !this.upstreamTools.some((tool) => tool.name === name)) {
      throw new Error(`Unknown or unavailable ChatCut tool: ${name}`);
    }
    return this.client.callTool(name, argumentsValue, signal);
  }

  async close() {
    this.closed = true;
    const starting = this.starting;
    const runtimeClosing = this.runtime.close();
    const client = this.client;
    this.client = null;
    this.clientBinding = null;
    this.upstreamTools = [];
    this.refreshGeneration += 1;
    const clientClosing = client?.close().catch(() => undefined);
    await Promise.all([runtimeClosing, clientClosing]);
    await starting?.catch(() => undefined);
  }
}
