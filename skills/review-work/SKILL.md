---
name: review-work
description: Review the current diff against the approved Codument plan, tests, docs, registry, and architecture boundaries.
---

# Review Work

Use this after a planned step has been implemented and before committing.

## Review Order

1. Read `codument work status --json` and its approved plan step. After final compaction, use the tracked contract and final-delivery binding in `docs/.approvals.json`; the pending-plans recovery copy supplies working context only. Inspect the compacted doc in the staged boundary as usual.
2. Inspect `git diff --cached`; that exact staged boundary, not the whole dirty worktree, is the review subject.
3. Run `codument verify` once. It reports only actionable failures and writes `.codument/review-worksheet.json` when a non-trivial boundary needs adversarial review.
4. If verification is blocked on mapping or documentation, fix the cause at intent altitude, restage the affected step files, and rerun `codument verify`. Never add mirror prose merely to make the gate green.
5. Compare the promised outcome and acceptance criteria with the evidence actually obtained at the relevant user or integration boundary. Name untested assumptions and any substitutes used; passing checks establish only the boundary they exercised. Missing required evidence remains a blocker unless the user explicitly changes acceptance. If adversarial review is required, inspect the generated `reviewContext` against the plan, staged diff, mapped invariants, and tests. Attack correctness, security, data loss, performance, type safety, and architecture fit; use an independent reviewer with a fresh context and no inherited author conversation when the host provides one, otherwise make the same adversarial pass yourself.
6. Complete only the worksheet's top-level `invariantsChecked`, `findings`, and `signer` fields. Do not alter generated context. Run the exact printed `codument verify --record .codument/review-worksheet.json` command; it records and verifies the same staged boundary in that invocation.
7. Fix safe, obvious findings, restage, and return to step 3. Pause for any judgment call or finding involving a public interface, security, data loss, deletion, or dependency change. A changed boundary invalidates its earlier review automatically.
8. When `codument verify` passes, run `codument work finish` to preserve verified readiness, then continue to `commit-work` without a routine prompt. If the user prohibited commits, stop with ready work and the pending commit visible. The exact receipt lets the hook confirm unchanged staged bytes. Gated and single-step requests retain their limits.
9. If review pauses or the user redirects work, preserve the plan path, step, next gate, unresolved finding or failure, and resume condition in the plan's Resume checkpoint (in its recovery copy after final-step compaction). Recheck the staged boundary on return; a changed boundary invalidates earlier review. If fixes restore delivery scaffolding, recompact and restage it before recording the final review.

## Preparing a branch for CI

When delivering a branch to CI, the staged-step gate and full branch review are separate boundaries.
After staging the intended final changes (and preparing final approval if the plan was compacted),
resolve the intended target branch and run `codument review --base <ref> --pending --bundle --full`.
Give a fresh independent reviewer that bundle and the full branch diff. Record its findings with the
same `--base <ref> --pending` selection, then export `.codument-review.json` with `--export` and stage
it. Never promote local step receipts into branch coverage. Re-run the normal staged review and
verification before committing; changed bytes reopen whichever boundary they affect. Keep private
findings under `.codument/`. CI uses `--committed --require-review --review-file .codument-review.json`
against the same resolved base and rejects missing or stale evidence. A moved target base may require
a new review. Run no remote action unless separately authorized.

## Output

Lead with findings ordered by severity:

- Critical
- High
- Medium
- Low

Each finding should include the file and line where possible, the concrete risk, and the smallest safe fix.

Auto-apply only safe, obvious fixes and continue to `commit-work`, but pause the whole run for any judgment-call finding or one touching public interfaces, security, data loss or deletions, or dependency changes. In gated mode, list the findings and stop for a user decision instead; do not fix findings automatically.

In gated mode, end with exactly these next options when findings exist:

```text
Review complete. Findings need a decision:
1. Fix all findings
2. Fix selected findings: [list numbers]
3. Defer selected findings with a reason
4. Pause here / make no changes
```

If there are no findings, say so clearly and mention any remaining verification risk, then continue to `commit-work`. In gated mode, end with exactly these next options instead:

```text
Review clean. Next options:
1. Run /commit-work for this reviewed step
2. Run extra verification
3. Pause here
```

## Record resolved findings (impact ledger)

When a review finding is resolved before commit — **fixed** (a verifiable change) or explicitly **deferred** — log it once so `codument watch` / `report` can show what the review step caught:

```bash
codument emit review --tier <correctness|minor> --resolution <fixed|deferred> [--feature <name>] [--step <n>] [--summary "<one line>"]
```

Tier conservatively: `correctness` covers safety, security, data-loss, and logic bugs; anything cosmetic is `minor`. This line is explicitly self-reported, and the `watch` headline counts only **fixed × correctness** — so do not inflate it. A finding that was neither fixed nor deferred (dismissed as a non-issue) is not logged.

## Rules

- Log each resolved finding once with `codument emit review` (fixed or deferred); never log one that was neither.
- Review only the staged boundary and restage every review fix before rerunning the verifier.
- Treat extra unplanned scope as a finding.
- Do not focus on formatting that automated tools should handle.
- Do not manufacture issues.
- Auto-apply only safe, obvious fixes, and pause the run for judgment-call findings (see above). In gated mode do not fix findings automatically at all; wait for the user to approve all fixes, select specific findings, defer specific findings, or pause.
- Do not mark review complete for commit until approved fixes are made or remaining findings are explicitly deferred by the user.
- Do not commit until high and critical findings are fixed or explicitly deferred by the user.
- Do not ask to start the next delivery-plan step after review.
