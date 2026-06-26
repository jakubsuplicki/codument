---
name: commit-work
description: Verify, stage, and commit a reviewed Codument work step with a focused conventional commit.
---

# Commit Work

Use this after `review-work` is clean, or after the user has approved/deferred every review finding and all approved fixes are resolved.

## Workflow

1. Check the active plan step is complete.
2. Check that `review-work` is clean, or that every finding was fixed or explicitly deferred by the user.
3. Check `git status --short`.
4. Review the diff and avoid staging unrelated user changes.
5. Run the relevant verification commands.
6. Run `codument review --strict` — it must pass. It exits nonzero while the step left a new source unmapped or a mapped doc stale; materialize the file(s) (`codument map materialize <file>`) and update the stale doc(s) (set `last_updated`), then re-run until clean. Do not commit while it is red.
7. Stage only files belonging to the completed step.
8. Commit with a conventional commit prefix:
   - `feat:`
   - `fix:`
   - `docs:`
   - `test:`
   - `refactor:`
   - `chore:`
9. Outside autopilot, stop after the commit and offer the next-step gate. In an autopilot run, continue directly to `work-step` for the next unchecked step (or report completion if none remain):

   ```text
   Step N is reviewed and committed. Next options:
   1. Start the next unchecked plan step with /work-step
   2. Review the plan before continuing
   3. Compact context before continuing
   4. Pause here
   ```
10. If the user chooses compact context, use the active agent's native context-compaction command when one is available. If no native command is available, provide a concise restart note grounded in `AGENTS.md`, the active plan doc, `docs/.registry.json`, and `git status`, then pause.

## Rules

- Do not commit unresolved high or critical review findings.
- Do not commit while `codument review --strict` is red — a new source left unmapped or a mapped doc left stale must be synced first.
- Do not decide to defer review findings yourself; only the user can defer findings.
- Do not commit unrelated dirty files.
- Do not claim verification passed if a command failed or could not run.
- Commit as the user only. Never add a `Co-Authored-By` trailer for the AI agent (for example Claude or Codex), in any profile.
- Follow any repository-specific commit timestamp or signing rules from `AGENTS.md`, `CLAUDE.md`, or the active feature plan.
- Outside autopilot, do not start the next delivery-plan step in the same response as the commit.
- Do not start the next delivery-plan step as part of compacting context.
