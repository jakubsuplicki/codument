---
title: CLI
status: current
type: feature
last_reviewed: 2026-07-01
---

# CLI

## In plain terms

This is the front door: the `codument` binary a user types into a terminal. It owns no logic of its own. It declares the command surface, parses argv, and hands each invocation straight to the handler that does the work. Open it when you want the authoritative list of what the tool exposes and which flags each command takes, or when you are adding or renaming a command.

## Design approach

The entry point is deliberately thin: a declarative table of commands mapped to handlers, with parsing delegated to a standard argument parser. Every command's behaviour lives in its own handler under [[commands]], not here, so this file stays a wiring manifest rather than a place logic accretes. That keeps each command independently testable through its own handler and keeps the surface readable as a single glance at "what can this tool do."

The surface is intentionally small and stable, because the command names are a public contract: users script against them and the agent is instructed to invoke them by name. New capability is added as a new command or flag, not by overloading an existing one. The version the binary reports is sourced from the package manifest at runtime rather than restated here, so the reported version cannot drift from the published package.

A retired flag stays registered, and its help text says it is retired. Deleting the declaration outright would answer an old pasted command with an unknown-option error, which tells the reader their invocation is malformed when in fact their whole reason for running it is gone; keeping it parseable lets the command that owns it refuse with the reason instead. What must never happen is the third option — a flag that still parses and quietly does nothing, which reads as success.

One command is a signpost, not an action: `run` (aliased `autopilot`) exists only to explain that codument does not run your coding agent. The CLI's whole remit is setup and deterministic checks; the delivery loop lives in the agent's instructions, so the binary's job is to redirect rather than to execute, and that boundary is stated in the command's own output. Since an approved plan runs on its own, the signpost has no trigger left to hand out — what it points at instead is the boundary itself and the way to slow the loop down, which keeps the command honest rather than vestigial.

## Invariants & boundaries

- The version the binary reports is read from the package manifest at runtime, so it cannot diverge from the published package version. *(untested)*
- The entry point only registers commands and dispatches; each command's behaviour is owned and tested through its own handler, never here. The command surface is exercised end-to-end by invoking the built binary in the per-command suites. *(test: `ack.test.ts` "ack loop end-to-end through the real CLI (the headline ergonomics)", which spawns the built `cli.js` and asserts dispatch + exit codes; the same pattern covers the other commands' suites)*
- The dispatch boundary fails closed on an unrecoverable error a command did not render itself: an unreadable registry or state file, a config file carrying an invalid value, or a gate that could not run (`GateError`), surfaces one red diagnostic and exits non-zero here rather than crashing with a raw stack, so no command runs against a silently-empty registry or a gate it could not evaluate. An invalid config value is rendered rather than thrown for a reason worth naming: the commands that read project settings include the ones a user would reach for to repair the file, so the diagnostic names the offending value and the file to edit instead of ending in a stack trace. *(tests: `doctor.test.ts` "fails loud on a corrupt registry"; `git.test.ts` "git change-listing fails closed"; `update.test.ts` "an invalid project setting is rendered, not crashed")*
- The same boundary renders a routine **refusal** — an entry that tried to name an out-of-scope source — rather than letting it escape as a stack. A refusal is an expected authoring outcome, not a failure of the tool, so the diagnostic carries the path and the reason it is out of scope; a stack trace would teach nothing about the rule the author just hit. *(untested at this boundary — the refusal itself is pinned by `registry.test.ts` "updateRegistryEntry refuses an excluded source")*
- `codument run` performs no work: it is a signpost whose only effect is explaining that codument does not run the user's agent and that the loop lives in the agent's instructions. Its command inventory is derived from the registered commands at print time — a hand-maintained list drifts the moment a command lands, which is how four commands once went missing from it. *(test: `cli.test.ts` — the signpost lists every command `--help` registers)*

## Key files

- `src/cli.ts` — the entry point: declares the command surface, parses argv, and dispatches each invocation to its handler.
