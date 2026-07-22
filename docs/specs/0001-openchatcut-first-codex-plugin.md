# Spec: OpenChatCut-first Codex plugin MVP

## Problem Statement

OpenChatCut already provides a capable local video editor and lets external agents call editor tools through MCP, but it runs as a separate application and includes its own ChatPanel, model provider configuration, and conversation history. The desired experience is one Codex task for conversation and one real OpenChatCut editing surface inside the Codex desktop application.

A clean-room editor is the wrong integration boundary. It would replace OpenChatCut's ProjectDoc, reducer, undo semantics, timeline UI, media service, preview/export, and tools with a smaller incompatible system. The MVP must instead reuse those modules and add only the host, lifecycle, authentication, and proposal seams needed by Codex.

## Solution

Publish `francize/codex-chatcut` as an AGPL Codex plugin that pins OpenChatCut at a reviewed commit. A preparation step applies a small Host Patch and builds the upstream web application. The plugin's stdio MCP server starts OpenChatCut's existing embedded server on `127.0.0.1:0`, with no Electron window, and opens the editor-only route in Codex's built-in Browser.

`host=codex` removes the OpenChatCut ChatPanel component, its grid column/divider, model/provider surfaces, and callbacks that feed that chat. It preserves the upstream Library, Preview, Inspector, Timeline, persistence, media service, external-agent bridge, and Remotion paths. Codex remains the sole conversational agent.

The stdio MCP server holds a random bearer token and proxies OpenChatCut's Streamable HTTP MCP. Editor calls therefore continue through upstream `TOOL_SCHEMAS -> executeTool -> EditorCommands -> reducer -> saveProject`. Reviewable edits reuse upstream `makeDraft`, action collection, `buildProposal`, stale checks, `replayActions`, `applyDoc`, and native undo; this repository does not define a second TimelinePatch vocabulary or Revision model.

The Codex-to-editor control path is MCP, not a second OpenAI API or model-conversation call. Separately configured upstream provider-backed generation tools may still contact their providers when the user explicitly invokes them; that optional upstream behavior is not the agent integration path. Cowart informs only the workspace-scoped local-service and in-app Browser lifecycle. No Cowart editor code, state model, or tools are reused.

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
14. As a security-conscious user, the entire browser-reachable embedded surface is capability protected, while MCP calls require an independent bearer and every route is exact-host constrained.
15. As a maintainer, the exact upstream SHA and Host Patch are auditable and upgrades never float silently with `main`.
16. As a maintainer, a failed Host Patch application stops the build rather than producing a partly compatible editor.
17. As a maintainer, tests prove the editor-only component tree, real upstream MCP flow, proposal flow, and negative security cases.
18. As a distributor, I can distinguish AGPL source obligations from separately licensed assets, fonts, skills, and Remotion components.

## Implementation Decisions

- Pin `0xsline/OpenChatCut` as a Git submodule. The initial reviewed pin is `850c238b894c2b0138ffc7944e8c7e2c30156fcd`.
- Apply patches in lexical order to an isolated prepared worktree. Every explicit rebuild starts from the canonical submodule, and the marker binds the patched source digest; never keep or re-certify undocumented dirty source.
- Use Node 24 for upstream install/build because that is OpenChatCut's declared runtime.
- Publish the sidecar architecture as plugin `0.2.0`, distinct from the obsolete `0.1.0` widget cache key.
- Reuse `desktop/embedded-server.ts` as the server composition seam, but do not reuse Electron `main.ts`, BrowserWindow, or preload.
- Use Codex's built-in Browser for the Editor Surface. The current production host rejects HTTP localhost origins in MCP Widget `frame-src`; a native Widget may show status but cannot be the editor container.
- Add an upstream `host=codex` capability check. Do not mount ChatPanel or chat-only affordances when true.
- Preserve `useExternalAgentBridge`, since it connects the mounted editor to the real upstream tool and state path.
- Add a windowless sidecar entry point that reports readiness only to the parent process and keeps logs off MCP stdout.
- Bind upstream storage to Codex's trusted per-call `codex/sandbox-state-meta.sandboxCwd`, canonicalized and fixed on first startup. Keep `CODEX_CHATCUT_WORKSPACE_ROOT` only as an explicit controlled-client fallback; never accept model-controlled storage paths.
- Reject symlinks in the workspace state path, and cancel/reap a starting or running sidecar with a bounded TERM-to-KILL lifecycle.
- Generate separate per-process MCP and browser capabilities. Require the MCP bearer before all HTTP MCP work. Issue the initial port-scoped `HttpOnly; SameSite=Strict; Path=/` browser capability only after an exact-loopback-Host and Fetch-Metadata-validated top-level document navigation; permit renewal only through an already authenticated bootstrap, and redirect bare `/` to `?host=codex`.
- Run the browser security middleware before every embedded-server route. Require the browser capability for static resources, project/settings APIs, media and Range serving, upload, export, generation, and provider proxies; retain the independent bearer for HTTP MCP and control-only tool discovery, and require an existing browser capability for bootstrap. Permit browser reads only from same-origin/none fetch sites with absent-or-exact Origin, and require exact Origin plus same-origin for mutations. Unknown dynamic paths fail closed instead of reaching the SPA fallback.
- In Codex Host Mode, fix the media directory inside the workspace, reject attempts to redirect `MEDIA_DIR`, and disable remote URL import and SVG upload. Do not add a general-purpose URL-fetching seam.
- Start the third-party sidecar with a minimal runtime-environment allowlist rather than the MCP owner's arbitrary credentials or Node injection flags. Strip browser authorization, cookies, Origin, Referer, and fetch metadata before provider proxying, and strip upstream cookie mutation headers from responses.
- Expose sidecar status, project control, editor URL, context, upstream tool discovery/calls, proposal/apply/reject, and undo through the stdio server. Preserve upstream JSON Schemas and structured results whenever a direct proxy is possible.
- Reuse upstream workspace-local media persistence and Range behavior. Do not add a second media gateway.
- Reuse upstream proposal primitives. Host-specific code may orchestrate them but may not translate actions into a local operation model.
- Use a plugin skill to start/open/focus the editor in Codex's Browser and to establish the target upstream project before edits.
- Adopt AGPL-3.0-or-later for the combined source and retain upstream attribution. Keep a third-party notice and an explicit release gate for assets and Remotion licensing.

## Testing Decisions

- A pin/patch test verifies the exact upstream SHA and runs `git apply --check` against a clean worktree.
- Prepared-runtime tests prove that a repeated build replaces locally modified source, records the patched source digest, and that runtime selection/staging reject later source drift.
- An editor-only source/build test proves that Host Mode does not mount ChatPanel or chat-only callbacks while retaining the external-agent bridge and editor regions.
- A sidecar test starts the prepared upstream build, asserts an ephemeral `127.0.0.1` origin, verifies readiness, and confirms shutdown with the stdio parent.
- Security tests reject missing/wrong MCP bearer credentials, forged navigation, cross-origin requests, invalid/expired browser capabilities, non-loopback/incorrect Host requests, unauthenticated static/API/media access, arbitrary media-directory settings, remote URL import, SVG upload, unknown dynamic-route SPA fallback, credential forwarding, and upstream cookie mutation.
- The primary black-box test starts stdio MCP, creates or opens a real upstream project, opens Host Mode, waits for the upstream editor bridge, discovers native tools, performs one real draft Proposal, applies it, reads the same ProjectDoc, and undoes it.
- Tests inspect returned upstream state rather than recomputing it with local reducers.
- Upstream `npm test`, `npm run lint`, and `npm run build` run on the prepared worktree at the declared Node version.
- This repository runs typecheck, tests, production build, MCP probe, plugin validation, and `git diff --check` before review and after review fixes.
- The completed Codex Desktop acceptance pass for the seven-patch runtime (`8e4d35724c8dbc6ade2b1e37008f0a4b7afdf700b652f88315a9177ed77cda29`) discovered 95 upstream tools; counted zero `.cc-chat-brand`, `.cc-chat-collapsed-brand`, and `[data-cc-chat-composer]` nodes; proved stale/apply-failure/reject-no-mutation after a manual `1:1` edit and native undo to `16:9`; proved normal `9:16` apply/undo; showed no horizontal overflow or chat at `1024x720` and `1440x900`; reused one selected Browser tab and the same origin on repeated start; emitted zero Browser warnings/errors; and made the origin unreachable after stdio close.
- The real-sidecar integration test serves a synthetic workspace-local media file through upstream `/media/uploads`: no capability is rejected, an authenticated byte range returns `206` with exact bytes and headers, and an unsatisfiable range returns `416`. No downstream media gateway is introduced.
- A later binary-release acceptance pass must additionally verify local import, preview and Range playback with real media, long-running task cancellation, and export. Automated tests retain route-security coverage for upstream Range serving, but the completed Browser pass did not use real media.

## Out of Scope

- Reimplementing any OpenChatCut editor domain or rendering module.
- Shipping a standalone Electron application.
- Depending on Codex++ for the official-plugin MVP.
- Embedding localhost in a native MCP Widget until the production host supports that origin class.
- General-purpose proxying to arbitrary URLs or exposing the MCP bearer to the Browser.
- Headless editing without a mounted upstream Editor context.
- Multi-user collaboration or concurrent writers to one project.
- Publishing binary/release bundles containing unaudited templates, fonts, media assets, ChatCut-derived skills, or Remotion runtime components.

## Release Gates

- Resolve the remaining conflict between OpenChatCut's AGPL root/package/English README and the stale no-license statement in its Chinese README, or document a maintainer clarification.
- Audit assets/fonts/templates and exclude anything without a distributable license.
- Document whether the intended distribution and team size require a Remotion company license.
- Do not label the plugin generally installable until a clean checkout can prepare the pinned dependency and pass the real Codex desktop acceptance flow.
