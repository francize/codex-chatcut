# Codex ChatCut domain context

Codex ChatCut hosts the real OpenChatCut editor inside Codex while Codex remains the sole conversational agent. It is an integration layer, not a second video editor implementation.

## Glossary

- **Codex task**: the only conversation containing instructions, approvals, tool calls, and responses.
- **OpenChatCut upstream**: the pinned `0xsline/OpenChatCut` source revision used for EditorCore, ProjectDoc, timeline UI, persistence, media, preview, export, and editor tools.
- **Host Patch**: a small, reviewable patch applied to the pinned upstream source. It adds Codex host mode, security hooks, and external-agent integration without replacing editor semantics.
- **Codex Host Mode**: an OpenChatCut route in which `ChatPanel`, its divider, provider settings, and AI-seed actions are not mounted. Library, Preview, Inspector, Timeline, and the external-agent bridge remain mounted.
- **Sidecar**: the windowless OpenChatCut loopback server launched and stopped by the plugin's stdio MCP process.
- **Editor Surface**: the upstream OpenChatCut web editor opened in Codex's built-in Browser. It is not an MCP Widget iframe.
- **ProjectDoc**: OpenChatCut's authoritative native project model. This repository must not define a parallel project or timeline model.
- **EditorCommands**: OpenChatCut's native command interface backed by its reducer and undo history.
- **External Agent Bridge**: OpenChatCut's browser-to-server bridge that registers and executes real editor tools against the mounted ProjectDoc.
- **Proposal**: an edit preview built with OpenChatCut's existing `makeDraft`, `buildProposal`, and action types.
- **Commit**: application of an accepted Proposal with OpenChatCut's `replayActions`/`applyDoc`, producing one native undo step.
- **stdio Proxy**: the plugin MCP server that owns sidecar lifecycle and forwards MCP calls to the authenticated OpenChatCut HTTP MCP endpoint.
- **Browser Capability**: a short-lived, sidecar-issued credential used only by the same-origin Editor Surface for bridge registration, polling, and results.

## Non-goals for the MVP

- Reimplementing OpenChatCut types, reducers, timeline, media server, preview, export, or persistence.
- Mounting or merely collapsing OpenChatCut's ChatPanel in Codex Host Mode.
- A standalone Electron window or a second model/provider runtime.
- Loading the loopback editor in an MCP App iframe while the production Codex host rejects localhost frame origins.
- Shipping OpenChatCut assets or Remotion-dependent binaries before their redistribution terms are audited.
