# ADR 0001: Reuse OpenChatCut through a windowless sidecar

## Status

Accepted; supersedes the earlier clean-room native-widget decision.

## Context

OpenChatCut already contains the deep editor modules this product needs: ProjectDoc, EditorCommands, reducers, undo history, media persistence and byte-range serving, React timeline UI, Remotion preview/export, and an external MCP bridge. Reimplementing those modules would create incompatible semantics and a permanent synchronization burden.

The MCP Apps protocol has `frameDomains`, but the current production Codex desktop host filters HTTP localhost frame origins. A Widget therefore cannot currently embed the real loopback editor. Codex's built-in Browser can open localhost and keeps the editing surface inside the Codex application.

## Decision

- Pin OpenChatCut as an upstream source dependency and carry only a small Host Patch.
- Adopt AGPL-3.0-or-later for the combined public source unless a separate upstream license is obtained.
- Launch OpenChatCut's existing embedded server without Electron or a standalone window.
- Open `?host=codex` in Codex's built-in Browser.
- In Codex Host Mode, do not mount ChatPanel, its divider, provider UI, or callbacks that seed the removed chat.
- Keep Codex as the sole agent and conversation.
- Forward model tools through a stdio MCP proxy to OpenChatCut's authenticated HTTP MCP, preserving upstream schemas and results.
- Reuse OpenChatCut's own ProjectDoc, EditorCommands, reducer, media service, persistence, proposal actions, undo, preview, and export.
- Bind the sidecar to `127.0.0.1` on a random port. Separate the MCP bearer credential from the browser capability and enforce Host/Origin checks on browser bridge routes.
- Keep an optional native status/launch card only if useful; it must not become a second editor.

## Consequences

The plugin stays thin and gains OpenChatCut feature compatibility by construction. An editor page must remain mounted for the current browser-backed external bridge. Upstream updates become explicit pin-and-patch review events. Public binary distribution remains gated on third-party asset and Remotion license review. If task-inline embedding is later required, a Codex++ `WebContentsView` adapter may be evaluated with `registerWithCodex: false`, sandboxing, an isolated partition, exact-origin navigation, and denied downloads/permissions; it is not part of this official-plugin MVP.
