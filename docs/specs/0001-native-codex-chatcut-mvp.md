## Problem Statement

People who want to edit video with Codex currently have to switch to a separate application or accept a second embedded chat system with its own provider credentials and conversation history. That fragments the workflow, duplicates the agent, and makes the editor harder to secure and maintain across platforms.

The desired experience is one Codex task containing the conversation and one project-backed visual editor inside Codex. The editor must expose enough structured context for phrases such as “the selected clip” to be unambiguous, let Codex prepare reviewable edits, and handle large local media without sending video bytes through model context or MCP JSON.

The first release must prove this architecture without claiming full OpenChatCut compatibility. OpenChatCut is an architectural reference, but its current repository-wide licensing statements are not sufficiently unambiguous for source reuse in a new public repository.

## Solution

Create Codex ChatCut as a public, installable Codex plugin. A stdio MCP server exposes a native Editor Widget and a small set of project-bound editing tools. Codex remains the sole conversational agent; the Editor Widget contains the media library, preview, inspector, timeline, selection, and proposal presentation, but never mounts chat history or a model client.

An authoritative Editor Session owns one Project Document and a monotonic Revision. Codex reads Selection Context, creates a non-destructive Proposal against an expected Revision, and applies it atomically only after approval. Every successful Commit can be undone. Stale proposals fail without modifying the project.

Large media stays outside the MCP control plane. A Media Gateway binds to loopback on an ephemeral port, uses an unguessable session token, maps opaque Asset IDs to files inside the fixed Project Root, and supports HTTP byte ranges for native video seeking. The MVP uses this path to prove local video preview; production transcoding and export remain future work.

## User Stories

1. As a Codex user, I want to install Codex ChatCut as a plugin, so that I do not need a separately distributed desktop application.
2. As a Codex user, I want to open the Editor Widget from my current task, so that editing remains inside the Codex experience.
3. As a Codex user, I want the Editor Widget to open in fullscreen or inline host display modes, so that I can choose the useful amount of editing space.
4. As a Codex user, I want Codex ChatCut to use my existing Codex task, so that there is only one conversation history.
5. As a Codex user, I do not want a ChatPanel inside the Editor Widget, so that I am never unsure which chat controls the edit.
6. As a Codex user, I do not want to configure an Anthropic or OpenAI API key in the editor, so that model access remains owned by Codex.
7. As an editor, I want a project to be bound to the active workspace once, so that later model tool calls cannot redirect file access.
8. As an editor, I want a project to survive closing and reopening the Widget, so that visual state is not coupled to one browser instance.
9. As an editor, I want to see the current Project Document Revision, so that stale operations are understandable.
10. As an editor, I want to select one or more timeline items, so that references such as “these clips” have precise meaning.
11. As an editor, I want my playhead and selected time range included in Selection Context, so that Codex can target time-based instructions.
12. As an editor, I want selection changes to become available to Codex without copying timeline JSON into chat, so that prompts stay concise.
13. As an editor, I want Codex to read the current Selection Context, so that it can explain what an instruction will affect.
14. As an editor, I want Codex to prepare a Timeline Patch without changing the project, so that I can review risky edits.
15. As an editor, I want a Proposal to show its operation summary and resulting timeline preview, so that approval is informed.
16. As an editor, I want remove, move, timing, and property updates represented as explicit operations, so that changes are auditable.
17. As an editor, I want a Proposal to record its base Revision, so that it cannot silently overwrite newer work.
18. As an editor, I want applying a stale Proposal to fail without side effects, so that concurrent widget and agent edits do not lose data.
19. As an editor, I want an approved Proposal to apply atomically, so that a partial Timeline Patch is never persisted.
20. As an editor, I want a successful Commit to advance Revision exactly once, so that ordering remains deterministic.
21. As an editor, I want to undo the most recent Commit, so that the MVP has a safe recovery path.
22. As an editor, I want undo itself to produce a new Revision, so that history never moves backward ambiguously.
23. As an editor, I want the Widget to reflect committed changes without requiring a second chat or manual reload, so that the visual state follows Codex actions.
24. As an editor, I want to register a local video as an opaque Asset ID, so that tools and UI do not expose arbitrary filesystem paths.
25. As an editor, I want local video playback to support byte ranges, so that seeking does not transfer the whole file.
26. As an editor, I want the Media Gateway to advertise the correct media length and type, so that the browser can render a native preview.
27. As a security-conscious user, I want the Media Gateway to listen only on loopback, so that media is not served to the local network.
28. As a security-conscious user, I want every media request to require an unguessable session token, so that unrelated local pages cannot read assets.
29. As a security-conscious user, I want Asset IDs to resolve only to allowlisted files under the Project Root, so that path traversal and arbitrary reads are rejected.
30. As a security-conscious user, I want MCP to use stdio rather than an unauthenticated HTTP endpoint, so that the Agent control plane is not exposed on localhost.
31. As a security-conscious user, I want the Widget CSP to allow only required `blob:`, `data:`, and exact loopback resources, so that remote origins are denied by default.
32. As a plugin maintainer, I want tool annotations to distinguish read-only, mutating, and destructive operations, so that Codex can present appropriate approvals.
33. As a plugin maintainer, I want structured tool results to contain stable IDs, revisions, and summaries, so that skills do not parse prose.
34. As a plugin maintainer, I want one black-box MCP probe to cover the primary editing workflow, so that internal refactors do not rewrite the behavioral test suite.
35. As a plugin maintainer, I want Media Gateway tests to exercise valid and invalid byte ranges, so that seeking and boundary behavior are reliable.
36. As a plugin maintainer, I want plugin-manifest validation and a reproducible production build, so that public installation failures are caught before release.
37. As a contributor, I want GitHub issues to state their blocking edges and acceptance criteria, so that work can proceed from the dependency frontier.
38. As a contributor, I want domain terms and architectural decisions documented, so that future OpenChatCut adapters preserve the MVP’s security and conversation boundaries.
39. As an OpenChatCut user, I want a future adapter boundary rather than a forked copy in the MVP, so that upstream code can be integrated only after licensing and compatibility are clear.
40. As a maintainer, I want a documented stop condition for native-widget limitations, so that Codex++ fallback is based on measured host constraints rather than assumption.

## Implementation Decisions

- The repository is a clean-room implementation. OpenChatCut and Cowart may inform public contracts and architecture, but no OpenChatCut source or bundled assets are copied into the MVP.
- The distribution unit is a Codex plugin containing skills, a stdio MCP server, and a native MCP App resource.
- The Editor Widget is the only visual editing surface. It contains no chat transcript, model provider SDK, API-key setting, or independent Agent loop.
- The Widget may send a one-shot Intent into the current Codex task, but it does not display or persist the resulting conversation.
- The MCP server is the owner of Editor Sessions. React or other Widget UI code subscribes to authoritative state and is not required to remain mounted for model tools to work.
- Opening a session canonicalizes and fixes the Project Root. Subsequent tool calls identify the session, project, media, timelines, and items through opaque IDs.
- The Project Document has a schema version and monotonic Revision. Project mutations are serialized and persisted atomically.
- The MVP Timeline Patch vocabulary contains add, remove, move, timing, and property-update operations. Unsupported operations are rejected before Proposal creation.
- Proposal creation is non-destructive. It validates the expected Revision, applies operations to an isolated draft, and returns a proposal ID, operation summary, base Revision, and preview summary.
- Proposal application performs a compare-and-swap against the base Revision and advances Revision exactly once. The entire operation either commits or has no effect.
- Undo restores the previous committed Project Document as a new Commit and a new Revision rather than decrementing the version.
- Model-facing tools include widget rendering, session opening/status, context reading, Proposal creation, Proposal application, undo, and media registration/status.
- Tools return structured content for machine use and short text for human activity reporting.
- The Media Gateway is a separate data plane, not an MCP transport. It binds to `127.0.0.1` on an ephemeral port and closes with the MCP process.
- The Media Gateway generates a cryptographically random token per process and requires it on every asset request.
- Media registration canonicalizes a candidate file, verifies it is a regular file inside the fixed Project Root, assigns an opaque Asset ID, and stores only the validated mapping.
- Media responses implement standards-compliant full and single-range requests, including correct `206`, `Content-Range`, `Content-Length`, `Accept-Ranges`, and `416` behavior.
- Widget resource metadata declares the minimum CSP resource and connection domains. Broader localhost, remote-network, camera, microphone, download, and popup access is not granted.
- Static Widget assets are built before distribution. Installing or opening the plugin must not run a network package installation.
- The public repository uses GitHub Issues, canonical triage labels, single-context domain documentation, and native blocking dependencies when GitHub supports them.
- Codex++ remains a fallback architecture. It is introduced only if an executable spike proves that native Widget lifecycle, media decoding, workers, keyboard input, or ranged loopback media cannot satisfy the editor.

## Testing Decisions

- Tests observe public behavior rather than reducer internals, React component structure, private helper calls, or implementation-specific storage layouts.
- The primary seam is a black-box stdio MCP probe. It starts the packaged server as a subprocess, performs MCP initialization, lists tools and resources, renders the Widget, opens an Editor Session, saves Selection Context, creates a Proposal, applies it, verifies Revision advancement, undoes it, and verifies the restored Project Document at a newer Revision.
- The second seam is the Media Gateway HTTP interface. Tests register a deterministic local fixture and verify full responses, prefix ranges, bounded ranges, suffix ranges, unsatisfiable ranges, invalid tokens, unknown Asset IDs, and traversal rejection.
- Widget smoke coverage verifies that the MCP App resource is self-contained, contains the host bridge, exposes timeline and preview landmarks, and contains no chat-history component or external model client.
- Contract fixtures use known literal Project Documents and expected summaries. Tests do not recompute expected results with the same operation implementation.
- Each implementation ticket follows vertical red-green cycles at the two agreed seams. A failing behavioral test is recorded before the minimum implementation that passes it.
- Type checking and the relevant single test file run during each ticket. The full quality command, production build, black-box probe, and plugin validator run before final review and again after review fixes.
- GitHub CI runs the same public quality command on a supported Node version.

## Out of Scope

- Copying or vendoring OpenChatCut source, templates, fonts, shaders, or skills while its repository-wide license remains ambiguous.
- Full OpenChatCut project compatibility, transition effects, captions, transcript editing, motion graphics, asset generation, recording, or plugin packs.
- Production FFmpeg, Remotion, headless Chrome, transcoding, proxy generation, waveform generation, or final media export.
- A standalone Electron, macOS, Windows, Linux, mobile, or web application.
- Codex++ installation, ASAR modification, preload injection, or private Codex DOM/Fiber integration.
- Multi-user collaboration, cloud synchronization, remote media URLs, shared network serving, or concurrent multi-process editing.
- Multiple undo levels, branchable history, selective Proposal operation approval, or long-running job orchestration.
- General filesystem browsing or model-controlled absolute paths after the Project Root is bound.
- Production performance guarantees for multi-gigabyte projects; the MVP proves the transport and state contracts with bounded fixtures.

## Further Notes

- Cowart demonstrates the core host pattern: a Codex plugin can return a native Widget resource, let the Widget call server tools, and send a follow-up message into the existing Codex task without an embedded Agent.
- The native-widget media spike is an explicit architectural gate. If the host blocks required byte-range playback, media codecs, workers, keyboard behavior, or stable Widget lifetime, capture the exact failing capability and request direction before adding a Codex++ fallback.
- The longer-term OpenChatCut integration point is the Editor Session contract, not its current HTTP MCP-to-browser long-poll bridge. A future adapter should map upstream Project Documents and commands into versioned Proposals while retaining project-root and media-gateway security boundaries.
