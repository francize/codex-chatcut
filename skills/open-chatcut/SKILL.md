---
name: open-chatcut
description: Start, open, or refocus the real OpenChatCut video editor inside Codex and connect the current task to an upstream project. Use when the user asks to open ChatCut, edit video, inspect the timeline or selection, create or target an OpenChatCut project, apply a reviewed edit proposal, or undo a Codex-driven edit.
---

# Open ChatCut

Use the mounted upstream editor as the visual surface and the current Codex task as the only conversation.

## Open the editor

1. Call `start_chatcut`. Reuse a running sidecar; do not start a duplicate process.
2. Call the upstream `list_projects` tool.
3. Choose the project explicitly named by the user. When none is named:
   - reuse the sole existing project;
   - otherwise call `create_project` with a concise name derived from the task.
4. Call `target_project` with that upstream project ID.
5. Call `get_editor_url`. Confirm that it is an exact `http://127.0.0.1:<port>/?host=codex#/editor/<id>` URL with no credential in it.
6. Open or focus that URL in Codex's built-in Browser. Do not use an external browser unless the user asks.
7. Keep the editor page mounted while using editing tools. Wait for `openchatcut_status` to report the target editor, then call `refresh_chatcut_tools` so Codex sees the native project tools.

If the in-app Browser capability is unavailable, return the credential-free URL and explain that it must be opened in Codex's Browser. Do not fall back to an MCP Widget iframe for localhost.

## Edit from the current task

1. Read upstream editor context before resolving phrases such as “this clip”, “the selected items”, or “here”.
2. Prefer the proposal tool for structural edits. Its calls must use native OpenChatCut tool names and arguments.
3. Summarize the affected upstream items and impact in the Codex task.
4. Apply only after the user's approval. Reject or leave pending when approval is absent.
5. If apply reports stale state, read context again and create a new proposal; never force replay over a newer ProjectDoc.
6. Use native OpenChatCut undo for recovery.

For a read-only request, inspect or explain without creating a proposal. For a direct manual change in the editor, refresh context before the next Codex edit.

## Boundaries

- Never mount, reveal, or interact with OpenChatCut's `ChatPanel`; Codex owns conversation.
- Never invent a local timeline schema or translate upstream actions into a second project model.
- Never expose sidecar capabilities, bearer values, cookies, or environment secrets in chat or tool arguments.
- Never change the workspace data root from a model-facing argument.
- Stop and report a missing prepared upstream build, pin mismatch, bridge authentication failure, or unavailable editor instead of synthesizing success.
