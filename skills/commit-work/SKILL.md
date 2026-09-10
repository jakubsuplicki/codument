---
name: commit-work
description: Commit an already verified Codument work step with a focused conventional commit.
---

# Commit Work

Use this after `review-work` is clean, or after the user has approved/deferred every review finding and all approved fixes are resolved.

## Workflow

1. Check the active plan step is complete, using its recovery copy at `.codument/pending-plans/<repo-relative-plan-path>` after final-step compaction. For the final step, confirm the original doc's `## Delivery Plan` block has been compacted out (plan-with-docs → Compaction on ship) — a shipped feature doc must not commit with a stale delivery checklist still in it.
2. Check that `review-work` is clean, or that every finding was fixed or explicitly deferred by the user.
3. Check `git status --short` and `git diff --cached`.
4. Confirm `codument work status --json` shows the reviewed step ready and the already-staged, verified boundary unchanged; do not stage here. If it changed, return to review and verification. Respect an explicit no-commit request: leave the step ready and stop.
5. Commit that boundary with a conventional commit prefix. The managed pre-commit hook runs `codument verify`; when the staged bytes and Codument version are unchanged, it reuses the exact receipt instead of repeating the review:
   - `feat:`
   - `fix:`
   - `docs:`
   - `test:`
   - `refactor:`
   - `chore:`
6. **If that was the plan's last step, remove only this plan's recovery copy after confirming the commit succeeded, then run `codument doctor --strict` once and report what it says.** If interrupted before cleanup, reconcile the copy with the committed boundary before resuming; a leftover copy does not authorize repeating completed work. Doctor reports; it does not gate — a plan must not be blocked by an adopting repo's pre-existing debt. This is the only moment the loop looks at repo-wide health: staged `verify` answers whether this change is ready, `doctor` answers whether the knowledge base is still worth reading. Once per plan, not once per step.
7. After the successful commit, run `codument work finish` to reconcile delivery, then read `codument steps --plan <active-plan> --json` if the Delivery Plan remains. Name the next step and continue to `work-step` unless gated or single-step mode requires stopping. Completed local state must agree with committed delivery; a missing checklist alone is not completion. In gated mode, fill the next-step gate from that readback:

   ```text
   Step N is reviewed and committed. Next options:
   1. Start Step [next ordinal]: [actual next step text] with /work-step
   2. Review the plan before continuing
   3. Compact context before continuing
   4. Pause here
   ```
8. If the user chooses compact context, write the Resume checkpoint inside the active Delivery Plan before using a native context-compaction command. If none exists, provide that concise restart note grounded in the plan, mapped docs, and `git status`, then pause. On a completed plan, give a completion note rather than recreating delivery scaffolding.

## Rules

- Do not commit unresolved high or critical review findings.
- Do not commit without a passing receipt for the exact staged boundary.
- Do not decide to defer review findings yourself; only the user can defer findings.
- Do not stage or commit unrelated dirty files.
- Do not claim verification passed if a command failed or could not run.
- Commit as the user only. Never add a `Co-Authored-By` trailer for the AI agent (for example Claude or Codex), in any profile.
- Follow any repository-specific commit timestamp or signing rules from `AGENTS.md`, `CLAUDE.md`, or the active feature plan.
- In gated mode, do not start the next delivery-plan step in the same response as the commit.
- Do not start the next delivery-plan step as part of compacting context.
