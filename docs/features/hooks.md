---
title: Hooks
status: current
type: feature
last_reviewed: 2026-06-29
---

# Hooks

## In plain terms

The check-docs hook is an in-editor nudge: right after the agent writes or edits a source file, it cross-references that path against the documentation registry and prints a one-line terminal reminder naming every doc that maps to the file. It exists to close the gap between changing code and remembering to update the doc that describes it, in the same task rather than later. It is a reminder, not a gate: it never blocks the edit and never fails, so a missing or broken registry simply produces no output.

## Design approach

The hook is the editor-local arm of the documentation workflow, deliberately the weakest one. The durable, cross-agent enforcement lives in the registry, the AGENTS contract, and the review gate; this hook is just an immediate prompt at the moment of the edit, where it is cheapest to act. That framing drives the design choices: it stays advisory and silent-on-doubt rather than authoritative.

It runs as a standalone script the editor invokes, not as an imported module, so it must be self-sufficient about two things the harness does not guarantee. First, the edited file's path arrives over a transport the editor controls, and the hook accepts the current contract while tolerating the legacy one, so a contract shift does not silently stop the reminders. Second, the editor may invoke the hook from an arbitrary working directory, so the hook locates the project by walking up from the edited file to the registry rather than trusting the current directory. Both are about surviving the environment the hook has no control over.

The reminder is failure-shy by construction. Every uncertain condition (no payload, an unparseable payload, a non-source file, an absent registry) ends in a clean no-op, because a false silence is a far cheaper failure than a crash or a spurious warning that trains the agent to ignore the channel. The registry is read as the single source of which docs own a file, and a file can legitimately belong to several features, so the reminder lists all of them rather than hiding multi-feature files behind the first match.

## Invariants & boundaries

- A changed source file that the registry maps to one or more docs produces a reminder naming each mapped doc; a file mapped to several features lists them all. *(test: `hooks.test.ts` "prints all docs mapped to a changed source file")*
- The registry is read as v2 only: a legacy, un-migrated registry yields no match rather than a guess, so it must be migrated before the hook can see its mappings. *(test: `hooks.test.ts` "does not match an un-migrated legacy registry (v2-only read)")*
- The edited path is accepted over the current editor transport, with the legacy environment-variable form tolerated as a fallback, so the reminder survives a payload-contract change. *(test: `hooks.test.ts` "reads the payload from stdin when no CLAUDE_TOOL_INPUT env is set")*
- The project root is resolved by walking up from the edited file to the registry, never assumed from the working directory, so the hook works regardless of where the editor invokes it. *(test: `hooks.test.ts` "resolves the registry from the edited file's path regardless of cwd")*
- The hook never fails the editing action: every uncertain or empty condition exits cleanly with no output. *(untested)*
- Only source files are considered; a non-source edit produces no reminder. *(untested)*
- Path matching is prefix-aware, so an edit inside a directory the registry tracks as a source also triggers its docs. *(untested)*

## Key files

- `src/hooks/check-docs.ts` — the standalone editor hook: resolves the edited path and project root, reads the registry, and prints the doc-update reminder for a changed source file.
