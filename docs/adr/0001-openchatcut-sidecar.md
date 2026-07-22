# ADR 0001: Reuse OpenChatCut through a windowless sidecar

## Status

Accepted; supersedes the earlier clean-room native-widget decision.

## Context

OpenChatCut already contains the deep editor modules this product needs: ProjectDoc, EditorCommands, reducers, undo history, media persistence and byte-range serving, React timeline UI, Remotion preview/export, and an external MCP bridge. Reimplementing those modules would create incompatible semantics and a permanent synchronization burden.

Cowart supplies the useful host pattern, not the editing implementation: its plugin skill starts a workspace-scoped local service and opens the real tldraw surface in Codex's in-app Browser. Codex ChatCut adopts that lifecycle-and-surface pattern while continuing to use OpenChatCut's own editor, project model, and tools. No Cowart editor source, state model, or tools are copied.

The MCP Apps protocol has `frameDomains`, but the current production Codex desktop host filters HTTP localhost frame origins. A Widget therefore cannot currently embed the real loopback editor. Codex's built-in Browser can open localhost and keeps the editing surface inside the Codex application.

## Decision

- Pin OpenChatCut as an upstream source dependency and carry only a small Host Patch.
- Rebuild prepared runtimes from the canonical submodule, bind their patched source digest in the marker, and use plugin version `0.2.0` to avoid the superseded widget cache key.
- Adopt AGPL-3.0-or-later for the combined public source unless a separate upstream license is obtained.
- Launch OpenChatCut's existing embedded server without Electron or a standalone window.
- Open `?host=codex` in Codex's built-in Browser.
- In Codex Host Mode, do not mount ChatPanel, its divider, provider UI, or callbacks that seed the removed chat.
- Advertise Codex's `codex/sandbox-state-meta` MCP capability and bind the sidecar to the canonical `sandboxCwd` injected on each tool call. Do not infer the task workspace from plugin `cwd` and do not expose a workspace argument to the model.
- Keep Codex as the sole agent and conversation.
- Forward model tools through a stdio MCP proxy to OpenChatCut's authenticated HTTP MCP, preserving upstream schemas and results. This control path is MCP rather than a second OpenAI API/model-conversation call; explicitly invoked upstream provider-backed generation tools may still contact their configured providers.
- Reuse OpenChatCut's own ProjectDoc, EditorCommands, reducer, media service, persistence, proposal actions, undo, preview, and export.
- Bind the sidecar to `127.0.0.1` on a random port and require exact loopback Host validation before every HTTP route. Keep the MCP bearer separate from the browser capability.
- Issue the initial port-scoped HttpOnly browser capability only to a Fetch-Metadata-validated top-level editor navigation, and renew it only through an already authenticated bootstrap. Protect the browser-loaded embedded surface—static resources, project/settings APIs, media and Range, upload, export, generation, and provider proxies—with that capability and same-origin read/mutation rules; retain the independent bearer for HTTP MCP and control-only tool discovery. Fail unknown dynamic routes closed before SPA fallback.
- Fix Codex Host Mode media storage inside the workspace, disable remote URL import and SVG upload, inherit only an allowlisted runtime environment, and prevent provider proxies from forwarding browser credentials or returning upstream cookie mutations.
- Do not ship a localhost MCP Widget or a replacement status/editor card in this source MVP; the real OpenChatCut page is the only editing surface.

## Consequences

The plugin stays thin and gains OpenChatCut feature compatibility by construction. An editor page must remain mounted for the current browser-backed external bridge. Remote URL import, SVG upload, and arbitrary external `MEDIA_DIR` settings are deliberate Host Mode compatibility costs of the security boundary. Upstream updates become explicit pin-and-patch review events. Public binary distribution remains gated on third-party asset and Remotion license review. If task-inline embedding is later required, a Codex++ `WebContentsView` adapter may be evaluated with `registerWithCodex: false`, sandboxing, an isolated partition, exact-origin navigation, and denied downloads/permissions; it is not part of this official-plugin MVP.

## Validation

The accepted seven-patch runtime has patch digest `8e4d35724c8dbc6ade2b1e37008f0a4b7afdf700b652f88315a9177ed77cda29`. A real Codex Desktop Browser pass discovered 95 upstream tools, found zero chat selectors, exercised stale rejection after a manual `1:1` edit plus native undo to `16:9`, exercised normal `9:16` apply/undo, rendered without horizontal overflow or chat at `1024x720` and `1440x900`, reused one selected tab and one origin across repeated starts, produced zero Browser warnings/errors, and confirmed the origin became unreachable after stdio closed. A real-sidecar automated test also exercises the upstream authenticated Range path with `206` and `416`; the Browser pass did not use real media, so local import, playback, preview, and export remain a later manual release gate.
