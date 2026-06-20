---
title: Hooks
status: active
type: feature
owner: ""
sources:
  - src/hooks/check-docs.ts
depends_on:
  - lib
last_reviewed: 2026-06-20
---

## Summary

The check-docs hook is a Claude profile PostToolUse hook that fires after Write, Edit, or MultiEdit tool calls. It checks whether the modified file is tracked in the documentation registry and prints a terminal reminder if the developer may need to update docs.

## How it works

The hook runs as a standalone Node script (not imported as a module). It reads the tool payload from **stdin** — the current Claude Code hook contract, `{ tool_input: { file_path } }` — and falls back to the legacy `CLAUDE_TOOL_INPUT` environment variable (`{ file_path }`) when that is set. It then:

1. Extracts `file_path` from the payload (`tool_input.file_path`, or top-level `file_path` for the legacy env shape)
2. Resolves the project root by walking up from the edited file to the directory containing `docs/.registry.json`, so it works regardless of the cwd the harness invokes it from (falls back to `process.cwd()`)
3. Filters to source files only (`.ts/.tsx/.js/.jsx`)
4. Reads the v2 `docs/.registry.json` and checks if the file matches any feature's mapped sources via `allSources` (primary + related). Legacy registries must be migrated first (`codument migrate-registry`); the hook itself is v2-only
5. If matched, prints a warning listing every mapped doc that may need an update

The output goes to the terminal as developer-facing feedback. This is a nudge, not the portable enforcement mechanism; cross-agent behavior comes from `AGENTS.md`, skills, and the registry-backed workflow.

## Key files

- `src/hooks/check-docs.ts` — PostToolUse hook that cross-references modified files against the doc registry and prints reminders

## Gotchas

- The hook uses `process.exit(0)` for all early returns (no/empty payload, parse errors, non-source files). It never fails — a broken registry or missing file just silently exits.
- Input precedence is env-var-then-stdin: `CLAUDE_TOOL_INPUT` wins when set (this is what the test suite injects), otherwise the payload is read from stdin. Stdin reads are skipped when `process.stdin.isTTY` so an interactive invocation with no piped input never blocks.
- Source matching uses `startsWith` on the path, so editing a file in a subdirectory of a tracked source will also trigger the warning.
- A single source file can map to multiple docs; the hook lists all matches so multi-feature files are not hidden behind the first registry entry.
- The hook is registered in `.claude/settings.json` with matcher `"Write|Edit|MultiEdit"`, so it only fires for those tools — not for Bash-based file modifications.
