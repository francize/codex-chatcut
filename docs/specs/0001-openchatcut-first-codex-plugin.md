# Spec: OpenChatCut-first Codex plugin MVP

## Problem Statement

OpenChatCut already provides a capable local video editor and lets external agents call editor tools through MCP, but it runs as a separate application and includes its own ChatPanel, model provider configuration, and conversation history. The desired experience is one Codex task for conversation and one real OpenChatCut editing surface inside the Codex desktop application.

A clean-room editor is the wrong integration boundary. It would replace OpenChatCut's ProjectDoc, reducer, undo semantics, timeline UI, media service, preview/export, and tools with a smaller incompatible system. The MVP must instead reuse those modules and add only the host, lifecycle, authentication, and proposal seams needed by Codex.

## Solution

Publish `francize/codex-chatcut` as an AGPL Codex plugin that pins OpenChatCut at a reviewed commit. A preparation step applies a small Host Patch and builds the upstream web application. The plugin's stdio MCP server starts OpenChatCut's existing embedded server on `127.0.0.1:0`, with no Electron window, and opens the editor-only route in Codex's built-in Browser.

`host=codex` removes the OpenChatCut ChatPanel component, its grid column/divider, model/provider surfaces, and callbacks that feed that chat. It preserves the upstream Library, Preview, Inspector, Timeline, persistence, media service, external-agent bridge, and Remotion paths. Codex remains the sole conversational agent.

The stdio MCP server holds a random bearer token and proxies OpenChatCut's Streamable HTTP MCP. Editor calls therefore continue through upstream `TOOL_SCHEMAS -> executeTool -> EditorCommands -> reducer -> saveProject`. Reviewable edits reuse upstream `makeDraft`, action collection, `buildProposal`, stale checks, `replayActions`, `applyDoc`, and native undo; this repository does not define a second TimelinePatch vocabulary or Revision model.

## User Stories

1. As a user, I can install one Codex plugin and prepare its pinned OpenChatCut dependency without installing another desktop application.
2. As a user, I can ask Codex to open ChatCut and see the real OpenChatCut editor in Codex's built-in Browser.
3. As a user, I see Library, Preview, Inspector, Timeline, and native project controls with their upstream behavior intact.
4. As a user, I never see an OpenChatCut ChatPanel, collapsed chat rail, provider selector, or model API-key prompt in Codex Host Mode.
5. As a user, all free-form instructions and approvals stay in my current Codex task.
6. As a user, I can create/open an upstream OpenChatCut project and operate it through the upstream tool schemas.
7. As a user, a manual UI edit and a Codex edit affect the same native ProjectDoc and undo history.
8. As a user, I can ask Codex to inspect the current upstream project, timeline, playhead, and selected items.
9. As a user, Codex can prepare a Proposal on an upstream draft without mutating the live ProjectDoc.
10. As a user, I can approve, reject, or detect a stale Proposal before it is replayed as one native undo step.
11. As a user, media seeking, preview, persistence, version history, and export continue to use OpenChatCut implementations.
12. As a security-conscious user, the sidecar binds only to an ephemeral loopback port and ends with the plugin MCP process.
13. As a security-conscious user, the MCP bearer credential is never returned to the model, browser URL, or conversation.
14. As a security-conscious user, bridge registration, polling, results, and MCP calls are authenticated and origin/host constrained.
15. As a maintainer, the exact upstream SHA and Host Patch are auditable and upgrades never float silently with `main`.
16. As a maintainer, a failed Host Patch application stops the build rather than producing a partly compatible editor.
17. As a maintainer, tests prove the editor-only component tree, real upstream MCP flow, proposal flow, and negative security cases.
18. As a distributor, I can distinguish AGPL source obligations from separately licensed assets, fonts, skills, and Remotion components.

## Implementation Decisions

- Pin `0xsline/OpenChatCut` as a Git submodule. The initial reviewed pin is `850c238b894c2b0138ffc7944e8c7e2c30156fcd`.
- Apply patches in lexical order to an isolated prepared worktree. Never keep undocumented dirty changes in the submodule.
- Use Node 24 for upstream install/build because that is OpenChatCut's declared runtime.
- Reuse `desktop/embedded-server.ts` as the server composition seam, but do not reuse Electron `main.ts`, BrowserWindow, or preload.
- Use Codex's built-in Browser for the Editor Surface. The current production host rejects HTTP localhost origins in MCP Widget `frame-src`; a native Widget may show status but cannot be the editor container.
- Add an upstream `host=codex` capability check. Do not mount ChatPanel or chat-only affordances when true.
- Preserve `useExternalAgentBridge`, since it connects the mounted editor to the real upstream tool and state path.
- Add a windowless sidecar entry point that reports readiness only to the parent process and keeps logs off MCP stdout.
- Parameterize upstream storage through a startup environment variable fixed to the workspace. Do not accept model-controlled storage paths.
- Generate separate per-process MCP and browser capabilities. Require the MCP bearer before all HTTP MCP work; require same-origin browser capability before register/poll/result.
- Expose sidecar status, project control, editor URL, context, upstream tool discovery/calls, proposal/apply/reject, and undo through the stdio server. Preserve upstream JSON Schemas and structured results whenever a direct proxy is possible.
- Reuse upstream media directory and Range behavior. Do not add a second media gateway.
- Reuse upstream proposal primitives. Host-specific code may orchestrate them but may not translate actions into a local operation model.
- Use a plugin skill to start/open/focus the editor in Codex's Browser and to establish the target upstream project before edits.
- Adopt AGPL-3.0-or-later for the combined source and retain upstream attribution. Keep a third-party notice and an explicit release gate for assets and Remotion licensing.

## Testing Decisions

- A pin/patch test verifies the exact upstream SHA and runs `git apply --check` against a clean worktree.
- An editor-only source/build test proves that Host Mode does not mount ChatPanel or chat-only callbacks while retaining the external-agent bridge and editor regions.
- A sidecar test starts the prepared upstream build, asserts an ephemeral `127.0.0.1` origin, verifies readiness, and confirms shutdown with the stdio parent.
- Security tests reject missing/wrong MCP bearer credentials, cross-origin bridge requests, invalid browser capabilities, and non-loopback/incorrect Host requests.
- The primary black-box test starts stdio MCP, creates or opens a real upstream project, opens Host Mode, waits for the upstream editor bridge, discovers native tools, performs one real draft Proposal, applies it, reads the same ProjectDoc, and undoes it.
- Tests inspect returned upstream state rather than recomputing it with local reducers.
- Upstream `npm test`, `npm run lint`, and `npm run build` run on the prepared worktree at the declared Node version.
- This repository runs typecheck, tests, production build, MCP probe, plugin validation, and `git diff --check` before review and after review fixes.
- A manual Codex desktop acceptance pass verifies the built-in Browser surface, focus/keyboard input, resize, media preview, no second chat, and one-task tool workflow.

## Out of Scope

- Reimplementing any OpenChatCut editor domain or rendering module.
- Shipping a standalone Electron application.
- Depending on Codex++ for the official-plugin MVP.
- Embedding localhost in a native MCP Widget until the production host supports that origin class.
- General-purpose proxying to arbitrary URLs or exposing the MCP bearer to the Browser.
- Headless editing when no upstream editor page is mounted; that requires a later upstream EditorSession extraction.
- Multi-user collaboration or concurrent writers to one project.
- Publishing binary/release bundles containing unaudited templates, fonts, media assets, ChatCut-derived skills, or Remotion runtime components.

## Release Gates

- Resolve the remaining conflict between OpenChatCut's AGPL root/package/English README and the stale no-license statement in its Chinese README, or document a maintainer clarification.
- Audit assets/fonts/templates and exclude anything without a distributable license.
- Document whether the intended distribution and team size require a Remotion company license.
- Do not label the plugin generally installable until a clean checkout can prepare the pinned dependency and pass the real Codex desktop acceptance flow.
