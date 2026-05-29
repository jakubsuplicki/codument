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
last_reviewed: 2026-05-29
---

## Summary

The CLI is the user-facing entry point for codument. It uses Commander to expose the delivery-workflow lifecycle commands (`init`, `scan`, `adopt`, `update`) plus the `benchmark` proof command family.

## How it works

`src/cli.ts` creates a Commander program, registers the subcommands with their options, and calls `program.parse()`. Each command delegates immediately to its handler in `src/commands/`. The CLI reads the package version from `src/lib/version.ts` so it stays in sync with `package.json` automatically.

The command surface is intentionally small:
- **`init`** — one-time project setup (`--agents codex,claude` to select profiles, `--force` to overwrite)
- **`scan`** — discovers source files and creates doc scaffolds
- **`adopt`** — migrates existing Codument projects, including legacy `mappings` registries (`--dry-run` to preview)
- **`update`** — syncs managed files after a codument package upgrade (`--agents` to override stored profiles, `--dry-run` to preview)
- **`benchmark`** — proof benchmark command family with `context`, `init <dir>`, and `score <dir>` subcommands

## Key files

- `src/cli.ts` — Registers all subcommands and parses argv via Commander
