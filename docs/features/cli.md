---
title: CLI Entry Point
status: active
type: feature
owner: ""
sources:
  - src/cli.ts
depends_on:
  - commands
  - lib
last_reviewed: 2026-06-24
---

## Summary

The CLI is the user-facing entry point for codument. It uses Commander to expose the delivery-workflow lifecycle commands (`init`, `scan`, `doctor`, `review`, `report`, `watch`, `demo`, `adopt`, `update`) plus the `benchmark` proof command family and the `run` signpost.

## How it works

`src/cli.ts` creates a Commander program, registers the subcommands with their options, and calls `program.parse()`. Each command delegates immediately to its handler in `src/commands/`. The CLI reads the package version from `src/lib/version.ts` so it stays in sync with `package.json` automatically.

The command surface is intentionally small:
- **`init`** — one-time project setup (`--agents codex,claude` to select profiles, `--force` to overwrite)
- **`scan`** — discovers source files and creates doc scaffolds
- **`doctor`** — reports documentation coverage (ownership, freshness, dependency, risk) and registry lint warnings (including doc bloat); `--json` emits the stable report contract. Bloat thresholds are tunable (`--max-doc-lines`, `--max-section-lines`, `--max-completed-log`) as is `--high-fanout`. `--write` persists `.codument/coverage.json` and the SVG badge. `--strict` makes findings exit 1 for CI gating (opt-in). Warning-only by default: without `--strict`, findings never change the exit code, and notes never do.
- **`review`** — reviews the uncommitted git diff against the registry: changed files grouped by owner, stale docs, high-risk touches, out-of-plan changes (when an approved plan is detected), unmapped changes, high-fanout files, and dependent features. `--json` emits the review contract; `--log` appends a review event to `.codument/events.jsonl`; `--strict` exits 1 while the change left a new source unmapped or a mapped doc stale. Reports facts and gaps; it does not certify safety.
- **`watch`** — live terminal view over the same `computeChangeState` analyzer (so it can never disagree with `review`): a foreground loop (no daemon) that refreshes coverage + change-state and tails `.codument/events.jsonl`. `--once` renders a single frame (CI/inspection); `--interval <ms>` sets the refresh cadence; `--dir <path>` watches another repo without `cd`. Zero-dependency ANSI renderer (not Ink), to preserve the minimal-dependency stance.
- **`report`** — writes a self-contained HTML review report (`.codument/report.html` by default, `--out <path>` to change) and opens it in the browser (`--no-open` to skip). Leads with a verdict + coverage delta (read from the last `doctor --write`'s `.codument/coverage.json`) and finding cards; each card has a clickable "what this checks" note and the per-file detail is collapsible. No network, deterministic.
- **`demo`** — one-command, click-through showcase. Materializes the packaged change-control fixture as a throwaway git repo and steps (Enter to advance, or `--auto`) through three beats: where the project stands → an AI makes a sweeping change → what codument caught, framed as **without codument** (the diff merges with nothing surfaced) **vs with codument** (the findings), shown as a terminal summary **and** the HTML report (opened in the browser when interactive). The coverage swing is presented as a health gauge, not the verdict. The demo's report embeds a "How this demo works" callout (the sample repo, the planted scenario, and why each change is flagged) so it can be showcased without narration. `--live` runs an alternate single-terminal showcase: the `watch` panel starts on a clean tree, then the AI change lands file-by-file and the counts visibly climb in place (no second terminal, no stash dance), ending by opening the same HTML report. Runs the real commands in-process. `--dir <path>` controls where the sample repo lands.
- **`adopt`** — brings an existing Codument project into the current registry/profile model: normalizes `docs/.registry.json` (backing up the previous file) and installs/refreshes agent profiles (`--dry-run` to preview)
- **`update`** — syncs managed files after a codument package upgrade (`--agents` to override stored profiles, `--dry-run` to preview)
- **`benchmark`** — proof benchmark command family with `context`, `init <dir>`, and `score <dir>` subcommands

## Key files

- `src/cli.ts` — Registers all subcommands and parses argv via Commander
