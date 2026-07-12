---
title: Hooks
status: current
type: feature
last_reviewed: 2026-06-29
---

# Hooks

## In plain terms

Hooks are where codument meets the moments a change actually happens, and the feature now has two arms with opposite temperaments. The check-docs hook is an in-editor nudge: right after the agent writes or edits a source file, it cross-references that path against the documentation registry and prints a one-line terminal reminder naming every doc that maps to the file. It is a reminder, not a gate: it never blocks the edit and never fails. The git pre-commit arm is the opposite: a managed block in the repository's pre-commit hook, installed with `codument hooks install` (or `init --hooks`), inspected with `hooks status`, removed with `hooks uninstall`, that runs `review --strict` at commit time and blocks the commit while the gate is red. The third arm is remote: `hooks install --ci` scaffolds a PR workflow that runs the same strict gate against the merge base, which is where enforcement becomes authoritative — a local hook can always be skipped, a required CI check cannot. It exists because the advisory posture demonstrably leaks — a well-instructed agent still landed one commit through a momentarily red gate — and commit time is the last moment the repository can refuse quietly-drifted state.

## Design approach

The editor hook is the editor-local arm of the documentation workflow, deliberately the weakest one. The durable, cross-agent enforcement lives in the registry, the AGENTS contract, and the review gate; this hook is just an immediate prompt at the moment of the edit, where it is cheapest to act. That framing drives the design choices: it stays advisory and silent-on-doubt rather than authoritative.

The pre-commit arm is written as a managed block, not an owned file: everything it will ever touch sits between two marker comments, so a user's own pre-commit logic survives every install, refresh, and uninstall byte-for-byte. A hook file codument did not write is appended to only when a shell will run it; anything else (a python hook, a binary, a hook manager's artifact) is refused with the manual wiring instructions rather than corrupted. The hooks directory is asked of git itself, so `core.hooksPath` setups and linked worktrees resolve correctly instead of assuming `.git/hooks`. Inside the block, the gate binary resolves project-local first so the repo's pinned version decides the verdict, and nothing on the path can fetch. Failure temperament is split deliberately: a gate that RUNS red blocks the commit and names both escapes (`--no-verify`, `CODUMENT_SKIP_GATE=1`) so skipping is always a stated act; a gate that CANNOT run (binary missing after a wiped node_modules) warns loudly and lets the commit pass, because bricking every commit is how a hook earns deletion, and "could not run, said out loud" is the same stance the adversarial gate takes for an unrunnable verdict.

It runs as a standalone script the editor invokes, not as an imported module, so it must be self-sufficient about two things the harness does not guarantee. First, the edited file's path arrives over a transport the editor controls, and the hook accepts the current contract while tolerating the legacy one, so a contract shift does not silently stop the reminders. Second, the editor may invoke the hook from an arbitrary working directory, so the hook locates the project by walking up from the edited file to the registry rather than trusting the current directory. Both are about surviving the environment the hook has no control over.

The reminder is failure-shy by construction. Every uncertain condition (no payload, an unparseable payload, a non-source file, an absent registry) ends in a clean no-op, because a false silence is a far cheaper failure than a crash or a spurious warning that trains the agent to ignore the channel. The registry is read as the single source of which docs own a file, and a file can legitimately belong to several features, so the reminder lists all of them rather than hiding multi-feature files behind the first match.

## Invariants & boundaries

- A changed source file that the registry maps to one or more docs produces a reminder naming each mapped doc; a file mapped to several features lists them all. *(test: `hooks.test.ts` "prints all docs mapped to a changed source file")*
- The registry is read as v2 only: a legacy, un-migrated registry yields no match rather than a guess, so it must be migrated before the hook can see its mappings. *(test: `hooks.test.ts` "does not match an un-migrated legacy registry (v2-only read)")*
- The edited path is accepted over the current editor transport, with the legacy environment-variable form tolerated as a fallback, so the reminder survives a payload-contract change. *(test: `hooks.test.ts` "reads the payload from stdin when no CLAUDE_TOOL_INPUT env is set")*
- The project root is resolved by walking up from the edited file to the registry, never assumed from the working directory, so the hook works regardless of where the editor invokes it. *(test: `hooks.test.ts` "resolves the registry from the edited file's path regardless of cwd")*
- The hook never fails the editing action: every uncertain or empty condition exits cleanly with no output. *(untested)*
- Only files the gate itself governs are considered, decided by the analyzer's ONE shared source spec rather than a hook-local extension list — so the live nudge and the verdict can never disagree about what a source is: a module-flavored config nudges, a declaration artifact or test file does not. *(test: `hooks.test.ts` "nudges for module-flavored sources and stays silent for declaration artifacts")*
- Path matching is prefix-aware, so an edit inside a directory the registry tracks as a source also triggers its docs. *(untested)*
- The pre-commit installer never modifies a byte outside its marker-delimited block: foreign hook content survives install, refresh, and uninstall verbatim. *(tests: `git-hooks.test.ts` "appends to an existing shell hook without touching its content", "refreshes a tampered managed block in place", "removes only the block when foreign lines exist")*
- A pre-commit hook that is not a shell script is refused, never modified. *(test: `git-hooks.test.ts` "refuses a non-shell hook and leaves it untouched")*
- Installation is idempotent: reinstalling over a current block is a byte-for-byte no-op. *(test: `git-hooks.test.ts` "is byte-idempotent on reinstall")*
- The hooks directory comes from git (`core.hooksPath` and linked worktrees honored), never from a hand-derived `.git/hooks`. *(test: `git-hooks.test.ts` "honors core.hooksPath")*
- Inside the block: a red strict gate blocks a real `git commit` with both escapes named; a green gate commits normally; a missing gate binary warns and lets the commit pass. *(tests: `hooks-command.test.ts` "a red strict gate blocks a real git commit; both escapes pass it", "a green gate lets the commit through with the hook active", "a missing binary warns loudly and lets the commit pass")*
- The installer refuses to run from a repository subdirectory, because the hook it writes would gate a root where the registry does not live. *(test: `hooks-command.test.ts` "install refuses to run from a repo subdirectory")*
- The CI workflow file carries an ownership marker: while it is present codument refreshes the file; once the user deletes the marker, codument refuses to overwrite their edits — same never-clobber stance as the hook file, expressed for a file the user is expected to evolve. *(test: `hooks-command.test.ts` "--ci scaffolds the PR workflow, refreshes managed, refuses unmanaged")*

## Key files

- `src/hooks/check-docs.ts` — the standalone editor hook: resolves the edited path and project root, reads the registry, and prints the doc-update reminder for a changed source file.
- `src/lib/git-hooks.ts` — the pre-commit arm: managed-block planner/writer/remover, foreign-hook classification, the gate block itself, and the CI workflow scaffold.
- `src/commands/hooks.ts` — the `hooks install|status|uninstall` command surface over the pre-commit and CI arms.
- `templates/ci-codument.yml` — the PR gate workflow the `--ci` scaffold writes, marker-first.
