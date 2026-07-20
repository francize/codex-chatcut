# Repository instructions

Codex ChatCut is a clean-room Codex plugin. Keep Codex as the only conversational agent and keep the widget free of chat history, provider SDKs, and model API keys.

## Agent skills

### Issue tracker

Specifications and implementation tickets live in GitHub Issues for `francize/codex-chatcut`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant ADRs under `docs/adr/` before changing behavior. See `docs/agents/domain.md`.

## Engineering constraints

- Test behavior through public MCP, HTTP Range, and widget-host contracts.
- Work ticket by ticket with red-green TDD where the public seam is automatable.
- Bind every editor session to one canonical project root. Model-facing tools accept opaque IDs, never arbitrary filesystem paths.
- Keep the MCP control plane on stdio. A loopback HTTP server may carry media bytes only and must use an unguessable session token.
- Do not copy OpenChatCut source until its repository-wide licensing is unambiguous. Preserve an adapter boundary for future compatibility.
- Do not add an OpenChatCut-style `ChatPanel`; free-form conversation belongs to the Codex task.
