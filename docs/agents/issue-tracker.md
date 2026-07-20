# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues at `francize/codex-chatcut`. Use the `gh` CLI from this checkout for all operations.

## Conventions

- Create one parent issue for a specification.
- Create one issue per tracer-bullet implementation ticket.
- Apply `ready-for-agent` when an issue contains sufficient acceptance criteria.
- Express blocking edges with GitHub native issue dependencies when available; otherwise include a `Blocked by` section with issue references.
- Pull requests are not a feature-request or triage surface.

## Common operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- Label: `gh issue edit <number> --add-label ready-for-agent`
- Close: `gh issue close <number> --comment "..."`

When a skill says to publish to the issue tracker, create a GitHub issue in this repository.
