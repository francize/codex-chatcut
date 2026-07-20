# ADR 0001: Native Widget with stdio MCP control plane

## Status

Accepted

## Context

Codex ChatCut must run inside Codex without maintaining a separately distributed desktop application or a second conversational agent. Video bytes are too large to serialize through MCP tool results.

## Decision

- Render the Editor Widget as a native MCP App resource returned by a Codex plugin tool.
- Use Codex's existing task as the only conversation and agent runtime.
- Run model-facing control operations through a plugin-owned stdio MCP server.
- Keep authoritative editing state in a project-bound Editor Session outside React.
- Carry large media bytes through a tokenized loopback Media Gateway that supports HTTP Range.
- Treat Codex++ injection as a fallback only if a measured native-widget host limitation blocks the required editor behavior.

## Consequences

The plugin avoids Codex preload injection and network-exposed MCP authentication. The widget remains sandboxed and restartable. The implementation must separately validate native-widget media playback, worker capabilities, keyboard behavior, and lifecycle.
