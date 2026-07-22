// @ts-check

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The upstream editor broker fails calls after 180 seconds. Keep the proxy
// request alive slightly longer so the broker remains the authoritative
// timeout, while retaining a finite transport bound if it cannot answer.
const UPSTREAM_TOOL_REQUEST_TIMEOUT_MS = 185_000;
const UPSTREAM_LIST_REQUEST_TIMEOUT_MS = 30_000;

export class UpstreamMcpClient {
  /** @param {{origin: string, token: string}} options */
  constructor({ origin, token }) {
    this.origin = origin;
    this.token = token;
    this.client = new Client({ name: "codex-chatcut-stdio-proxy", version: "0.2.0" });
    this.transport = new StreamableHTTPClientTransport(
      new URL("/api/external-mcp/mcp", origin),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  /** @param {AbortSignal} [signal] */
  async listTools(signal) {
    return (await this.client.listTools(undefined, {
      signal,
      timeout: UPSTREAM_LIST_REQUEST_TIMEOUT_MS,
    })).tools;
  }

  /** @param {string} name @param {Record<string, unknown> | undefined} argumentsValue @param {AbortSignal} [signal] */
  async callTool(name, argumentsValue, signal) {
    return this.client.callTool(
      { name, arguments: argumentsValue ?? {} },
      undefined,
      { signal, timeout: UPSTREAM_TOOL_REQUEST_TIMEOUT_MS },
    );
  }

  async close() {
    await this.client.close();
  }
}
