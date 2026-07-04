---
title: CLI
status: current
type: feature
owner: ""
primary_sources:
  - src/cli.ts
related_sources: []
docs: []
depends_on:
  - commands
  - lib
risk: []
last_reviewed: 2026-07-01
---

# CLI

## In plain terms

This is the front door: the `codument` binary a user types into a terminal. It owns no logic of its own. It declares the command surface, parses argv, and hands each invocation straight to the handler that does the work. Open it when you want the authoritative list of what the tool exposes and which flags each command takes, or when you are adding or renaming a command.

## Design approach

The entry point is deliberately thin: a declarative table of commands mapped to handlers, with parsing delegated to a standard argument parser. Every command's behaviour lives in its own handler under [[commands]], not here, so this file stays a wiring manifest rather than a place logic accretes. That keeps each command independently testable through its own handler and keeps the surface readable as a single glance at "what can this tool do."

The surface is intentionally small and stable, because the command names are a public contract: users script against them and the agent is instructed to invoke them by name. New capability is added as a new command or flag, not by overloading an existing one. The version the binary reports is sourced from the package manifest at runtime rather than restated here, so the reported version cannot drift from the published package.

One command is a signpost, not an action: `run` (aliased `autopilot`) exists only to explain that codument does not run your coding agent. The CLI's whole remit is setup and deterministic checks; the autopilot loop lives in the agent's instructions, so the binary's job is to redirect rather than to execute, and that boundary is stated in the command's own output.

## Invariants & boundaries

- The version the binary reports is read from the package manifest at runtime, so it cannot diverge from the published package version. *(untested)*
- The entry point only registers commands and dispatches; each command's behaviour is owned and tested through its own handler, never here. The command surface is exercised end-to-end by invoking the built binary in the per-command suites. *(test: `ack.test.ts` "ack loop end-to-end through the real CLI (the headline ergonomics)", which spawns the built `cli.js` and asserts dispatch + exit codes; the same pattern covers the other commands' suites)*
- The dispatch boundary fails closed on an unreadable registry: any command that reads an unparseable `docs/.registry.json` surfaces one red diagnostic and exits non-zero here, so no command runs against a silently-empty registry. *(test: `doctor.test.ts` "fails loud on a corrupt registry")*
- `codument run` performs no work: it is a signpost whose only effect is explaining that codument does not run the user's agent and that the loop lives in the agent's instructions. *(untested)*

## Key files

- `src/cli.ts` — the entry point: declares the command surface, parses argv, and dispatches each invocation to its handler.
