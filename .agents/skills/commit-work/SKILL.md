---
name: commit-work
description: Commit an already verified Codument work step with a focused conventional commit.
---

# Commit Work

Use this after `review-work` is clean, or after the user has approved/deferred every review finding and all approved fixes are resolved.

## Workflow

1. Check the active plan step is complete. If it was the final step, confirm the `## Delivery Plan` block has been compacted out (plan-with-docs → Compaction on ship) — a shipped feature doc must not commit with a stale delivery checklist still in it.
2. Check that `review-work` is clean, or that every finding was fixed or explicitly deferred by the user.
3. Check `git status --short` and `git diff --cached`.
4. Confirm the already-staged, verified boundary has not changed since `review-work`; do not stage anything here. If it changed, return to `review-work` and rerun `codument verify`.
5. Commit that boundary with a conventional commit prefix. The managed pre-commit hook runs `codument verify`; when the staged bytes and Codument version are unchanged, it reuses the exact receipt instead of repeating the review:
   - `feat:`
   - `fix:`
   - `docs:`
   - `test:`
   - `refactor:`
   - `chore:`
6. **If that was the plan's last step, run `codument doctor --strict` once and report what it says.** It reports; it does not gate — a plan must not be blocked by an adopting repo's pre-existing debt. This is the only moment the loop looks at repo-wide health: staged `verify` answers whether this change is ready, `doctor` answers whether the knowledge base is still worth reading. Once per plan, not once per step.
7. Continue directly to `work-step` for the next unchecked step, or report completion if none remain. In gated mode, stop after the commit and offer the next-step gate instead:

   ```text
   Step N is reviewed and committed. Next options:
   1. Start the next unchecked plan step with /work-step
   2. Review the plan before continuing
   3. Compact context before continuing
   4. Pause here
   ```
8. If the user chooses compact context, use the active agent's native context-compaction command when one is available. If no native command is available, provide a concise restart note grounded in `AGENTS.md`, the active plan doc, `docs/.registry.json`, and `git status`, then pause.

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
