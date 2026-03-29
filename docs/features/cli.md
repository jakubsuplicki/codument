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
last_reviewed: 2026-03-29
---

## Summary

The CLI is the user-facing entry point for codument. It uses Commander to expose three subcommands (`init`, `scan`, `update`) that handle the full lifecycle of documentation management — from project setup through ongoing maintenance.

## How it works

`src/cli.ts` creates a Commander program, registers the three subcommands with their options, and calls `program.parse()`. Each command delegates immediately to its handler in `src/commands/`. The CLI reads the package version from `src/lib/version.ts` so it stays in sync with `package.json` automatically.

The command surface is intentionally small:
- **`init`** — one-time project setup (`--force` to overwrite)
- **`scan`** — discovers source files and creates doc scaffolds
- **`update`** — syncs managed files after a codument package upgrade (`--dry-run` to preview)

## Key files

- `src/cli.ts` — Registers all subcommands and parses argv via Commander
