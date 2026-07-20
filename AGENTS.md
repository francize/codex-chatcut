# Repository instructions

Codex ChatCut is an OpenChatCut-first Codex plugin. Codex is the only conversational agent; OpenChatCut supplies the real editor.

## Agent skills

### Issue tracker

Specifications and implementation tickets live in GitHub Issues for `francize/codex-chatcut`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

Read `CONTEXT.md` and relevant ADRs under `docs/adr/` before changing behavior. See `docs/agents/domain.md`.

## Engineering constraints

- Reuse pinned OpenChatCut ProjectDoc, EditorCommands, reducers, persistence, media, preview/export, UI, tool schemas, and proposal actions. Do not create equivalent local models.
- Keep the Host Patch small, reviewable, and applicable to the exact upstream SHA recorded in the repository.
- In `host=codex`, do not mount ChatPanel, provider/model settings, or AI-seed controls. Do not substitute CSS hiding for component removal.
- Keep the plugin-facing MCP transport on stdio. The loopback OpenChatCut HTTP MCP must require a per-process bearer credential held by the proxy.
- Bind only to `127.0.0.1:0`; validate Host and Origin; authenticate register, poll, result, and MCP routes; never print credentials into MCP results or chat.
- Scope OpenChatCut data to the active workspace. Model-facing tools use upstream project/item IDs and do not accept a replacement storage root after startup.
- Test public stdio MCP, sidecar HTTP security, Host Patch application, and real upstream behavior. Use red-green TDD for automatable seams.
- Treat upstream pin changes as dependency upgrades: inspect the diff, refresh the patch, run upstream tests/build, then run this repository's full quality gate.
- Keep third-party assets, fonts, skills, and Remotion redistribution out of release artifacts until their terms are documented.
