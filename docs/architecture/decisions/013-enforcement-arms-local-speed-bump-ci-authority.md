---
status: accepted
date: 2026-07-12
---

# 013 — Enforcement arms: local hook is a speed bump, CI is the authority, missing runtime degrades loudly open

## Context

`review --strict` has always exited nonzero on an out-of-sync step, but nothing invoked it at commit time: the AGENTS contract instructs the agent to run it before every commit, and that instruction was the whole enforcement story. Dogfooding the website build measured the leak precisely — a compliant, well-instructed agent landed exactly one commit through a momentarily red gate in 44 (a shell-chained `;` where a `&&` belonged). One-in-44 is not an agent-quality problem; it is what an advisory posture yields at agent speed, and the number will not improve by writing the instruction in bolder text. Meanwhile plan 14 shipped SARIF annotations and named the "CI required-check story" as future work.

## Decision

Enforcement becomes three arms with deliberately different temperaments, and the split is the decision:

1. **The local pre-commit hook is a speed bump, never a wall.** `codument hooks install` writes a managed block (marker-delimited, the only region codument ever touches; foreign shell hooks are appended to, non-shell hooks refused with manual wiring instructions; the hooks directory is asked of git so `core.hooksPath` and worktrees resolve). A red gate blocks the commit and names both escapes — `git commit --no-verify` and `CODUMENT_SKIP_GATE=1` — because a local hook can always be evaded, so the design goal is that skipping is a **stated act, never a slip**. The block runs `--strict` only: static, no network, no test spawning. `--require-review` at commit time is how a hook earns deletion; users who want it edit the block, and the block says so.

2. **CI is where enforcement is authoritative.** `hooks install --ci` scaffolds a PR workflow running the same strict gate against the merge base; making it *required* is a branch-protection setting, the one thing a CLI cannot reach. The workflow file is marker-first: while the managed marker is present codument refreshes it on reinstall; deleting the marker takes ownership and codument then refuses to overwrite — the never-clobber stance of the hook file, expressed for a file users are expected to evolve.

3. **A gate that cannot run degrades loudly OPEN in the hook; a gate that runs red fails CLOSED.** If neither a project-local binary nor PATH resolves codument, the hook prints a named warning and lets the commit pass. Blocking every commit after an `rm -rf node_modules` trains users to uninstall the hook permanently, which is strictly worse than one unguarded commit; and "could not run, said out loud" is the same stance the adversarial gate takes for an unrunnable verdict (ADR 010 lineage). Fail-closed remains the rule the moment the gate actually evaluates.

4. **The hook checks the working tree, not the staged bytes — stated, not hidden.** `review` evaluates worktree-vs-HEAD; with partial staging the hook may check bytes that differ from the commit. The install output says so. A staged-index review mode is the named follow-up if demand shows; pretending the hook proves the committed bytes would be a false promise.

## Consequences

- The 1-in-44 slip class is closed locally by mechanism rather than instruction, and closed remotely by a required check — the enforcement ladder (editor nudge → contract → hook → CI) now has no silent rung.
- Every escape is auditable in principle (a skip is an explicit flag or environment variable in the command the user typed), which is the honest maximum a local hook can offer.
- The loudly-open stance means a machine without the toolchain is not gated — accepted, because the authoritative arm (CI) does not share that weakness.
- Nothing about the verdict changed: same analyzer, same exit codes. Only who is guaranteed to hear it.
