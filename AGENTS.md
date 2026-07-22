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
- Keep the plugin-facing MCP transport on stdio. The loopback OpenChatCut HTTP MCP must require a per-process bearer credential held by the proxy. This is an MCP editor-control path, not a second OpenAI API/model conversation; explicitly invoked upstream provider-backed generation tools may still use their configured services.
- Bind only to `127.0.0.1:0` and validate the exact loopback Host before every route. Issue the initial port-scoped HttpOnly browser capability only after a Fetch-Metadata-validated top-level `host=codex` navigation and renew it only through authenticated bootstrap. Require it, with the appropriate same-origin read/mutation checks, across the browser-loaded static/API/media/upload/export/generation/proxy surface; retain the independent bearer for HTTP MCP and control-only tool discovery. Never print either credential into MCP results or chat.
- Keep the full-surface security middleware first, fail unknown dynamic routes closed, inherit only the sidecar environment allowlist, and strip browser credentials plus upstream cookie mutations at provider proxies.
- In Codex Host Mode, keep media storage inside the bound workspace and continue to disable remote URL import and SVG upload. Do not restore an arbitrary `MEDIA_DIR`, general URL fetcher, or active-content upload without a new security decision and tests.
- Scope OpenChatCut data to the active workspace. Model-facing tools use upstream project/item IDs and do not accept a replacement storage root after startup.
- Test public stdio MCP, sidecar HTTP security, Host Patch application, and real upstream behavior. Use red-green TDD for automatable seams.
- Treat upstream pin changes as dependency upgrades: inspect the diff, refresh the patch, run upstream tests/build, then run this repository's full quality gate.
- Keep third-party assets, fonts, skills, and Remotion redistribution out of release artifacts until their terms are documented.
