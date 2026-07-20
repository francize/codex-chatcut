# Codex ChatCut domain context

Codex ChatCut embeds a project-backed video-editing surface in Codex while Codex remains the sole conversational agent.

## Glossary

- **Codex task**: the host conversation containing user instructions, model reasoning, tool calls, approvals, and responses.
- **Editor Widget**: the native MCP App rendered by Codex. It shows media, preview, inspector, and timeline UI, but no conversation history.
- **Editor Session**: the authoritative project-bound service that owns timeline state, revision checks, proposals, commits, and undo.
- **Project Root**: the canonical workspace directory fixed when an Editor Session opens. It cannot be changed by later model tool arguments.
- **Project Document**: the serializable editing state stored below the Project Root. Media bytes are referenced by opaque Asset IDs.
- **Revision**: the monotonic Project Document version used for compare-and-swap mutation.
- **Selection Context**: the current timeline, selected Item IDs, playhead, range, and Revision exposed to Codex.
- **Timeline Patch**: a validated list of editing operations targeted at one expected Revision.
- **Proposal**: a non-destructive preview of a Timeline Patch, including its base Revision and resulting Project Document summary.
- **Commit**: an atomically applied Proposal that advances Revision and can be undone.
- **Media Gateway**: the tokenized loopback HTTP data plane that serves registered assets by opaque Asset ID with byte-range support.
- **Control Plane**: the stdio MCP tools used by Codex and the Editor Widget. It never exposes an unauthenticated HTTP MCP endpoint.
- **Intent**: a one-shot request sent by the Editor Widget into the existing Codex task; it is not a second chat system.

## Non-goals for the MVP

- Full OpenChatCut feature parity or source-code import.
- Production FFmpeg/Remotion export.
- A standalone desktop application.
- Cross-platform packaging beyond the Codex plugin bundle.
