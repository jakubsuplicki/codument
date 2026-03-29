---
title: Hooks
status: active
type: feature
owner: ""
sources:
  - src/hooks/check-docs.ts
depends_on:
  - lib
last_reviewed: 2026-03-29
---

## Summary

The check-docs hook is a Claude Code PostToolUse hook that fires after every Write or Edit tool call. It checks whether the modified file is tracked in the documentation registry and prints a terminal reminder if the developer may need to update docs.

## How it works

The hook runs as a standalone Node script (not imported as a module). It reads `CLAUDE_TOOL_INPUT` from the environment to get the file path that was just written or edited, then:

1. Extracts `file_path` from the JSON tool input
2. Filters to source files only (`.ts/.tsx/.js/.jsx`)
3. Reads `docs/.registry.json` and checks if the file matches any feature's `sources` array
4. If matched, prints a warning like `⚠️ codument: src/lib/registry.ts is documented in "lib" (docs/concepts/lib.md) — verify docs are still accurate`

The output goes to the terminal as developer-facing feedback — Claude does not see or act on it. This is a nudge, not an enforcement mechanism.

## Key files

- `src/hooks/check-docs.ts` — PostToolUse hook that cross-references modified files against the doc registry and prints reminders

## Gotchas

- The hook uses `process.exit(0)` for all early returns (missing env var, parse errors, non-source files). It never fails — a broken registry or missing file just silently exits.
- Source matching uses `startsWith` on the path, so editing a file in a subdirectory of a tracked source will also trigger the warning.
- The hook is registered in `.claude/settings.json` with matcher `"Write|Edit"`, so it only fires for those two tools — not for Bash-based file modifications.
