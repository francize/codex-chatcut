# Codex ChatCut domain context

Codex ChatCut hosts the real OpenChatCut editor inside Codex while Codex remains the sole conversational agent. It is an integration layer, not a second video editor implementation.

## Glossary

- **Codex task**: the only conversation containing instructions, approvals, tool calls, and responses.
- **OpenChatCut upstream**: the pinned `0xsline/OpenChatCut` source revision used for EditorCore, ProjectDoc, timeline UI, persistence, media, preview, export, and editor tools.
- **Host Patch**: a small, reviewable patch applied to the pinned upstream source. It adds Codex host mode, security hooks, and external-agent integration without replacing editor semantics.
- **Codex Host Mode**: an OpenChatCut route in which `ChatPanel`, its divider, provider settings, and AI-seed actions are not mounted. Library, Preview, Inspector, Timeline, and the external-agent bridge remain mounted.
- **Sidecar**: the windowless OpenChatCut loopback server launched and stopped by the plugin's stdio MCP process.
- **Editor Surface**: the upstream OpenChatCut web editor opened in Codex's built-in Browser. It is not an MCP Widget iframe.
- **Cowart Host Pattern**: the workspace-scoped local-service and in-app Browser lifecycle that inspired this integration boundary. Codex ChatCut does not reuse Cowart editor code, state, or tools.
- **ProjectDoc**: OpenChatCut's authoritative native project model. This repository must not define a parallel project or timeline model.
- **EditorCommands**: OpenChatCut's native command interface backed by its reducer and undo history.
- **External Agent Bridge**: OpenChatCut's browser-to-server bridge that registers and executes real editor tools against the mounted ProjectDoc.
- **Proposal**: an edit preview built with OpenChatCut's existing `makeDraft`, `buildProposal`, and action types.
- **Commit**: application of an accepted Proposal with OpenChatCut's `replayActions`/`applyDoc`, producing one native undo step.
- **stdio Proxy**: the plugin MCP server that owns sidecar lifecycle and forwards MCP calls to the authenticated OpenChatCut HTTP MCP endpoint. This is the Codex control path; it does not start a second OpenAI API/model conversation. Explicitly invoked upstream provider-backed generation tools may still contact their configured providers.
- **Browser Capability**: a short-lived, port-scoped HttpOnly credential initially issued only after a validated top-level Editor Surface navigation and renewable only through an authenticated bootstrap. It protects the complete browser-loaded same-origin surface, including static resources, project/settings APIs, media and Range, upload, export, generation, and provider proxies—not only bridge registration, polling, and results. HTTP MCP and control-only tool discovery use the independent bearer.

## Non-goals for the MVP

- Reimplementing OpenChatCut types, reducers, timeline, media server, preview, export, or persistence.
- Mounting or merely collapsing OpenChatCut's ChatPanel in Codex Host Mode.
- A standalone Electron window or a second model/provider runtime.
- Loading the loopback editor in an MCP App iframe while the production Codex host rejects localhost frame origins.
- General-purpose remote URL fetching, SVG active-content upload, or moving Codex Host Mode media storage outside the bound workspace.
- Headless editing without a mounted upstream Editor context.
- Shipping OpenChatCut assets or Remotion-dependent binaries before their redistribution terms are audited.
