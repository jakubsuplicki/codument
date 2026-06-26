---
name: review-work
description: Review the current diff against the approved Codument plan, tests, docs, registry, and architecture boundaries.
---

# Review Work

Use this after a planned step has been implemented and before committing.

## Review Order

1. Read the approved plan step.
2. Run `codument review --log` (add `--json` to consume it programmatically). `--log` snapshots a `caught` event — the **provable** line of the impact ledger (`codument watch` / `report`) — recording the stale docs, risk touches, and off-plan files this change flagged **while they are still present** (before step 6 clears them). The report gives the deterministic change-state: which feature owners the diff touches, docs that went **stale** (source changed, mapped doc didn't), high-risk areas touched, out-of-plan changes, unmapped new files, and dependent features that may need re-review. Use it as the spine of the review — it tells you where to look; it does not certify the change is safe.
3. Inspect the current diff.
4. Check whether the implementation matches the planned behavior.
5. Check tests or verification output.
6. Resolve every `codument review` finding: update each stale doc and its `docs/.registry.json` entry, register unmapped source files, and flag dependents whose interface changed. Re-run `codument review` to confirm the doc/registry findings clear.
7. Look for correctness, security, data-loss, performance, type-safety, and maintainability issues beyond what the deterministic pass can see.

## Output

Lead with findings ordered by severity:

- Critical
- High
- Medium
- Low

Each finding should include the file and line where possible, the concrete risk, and the smallest safe fix.

Outside autopilot, if there are findings, list them and stop for a user decision; do not fix findings automatically. In an autopilot run, auto-apply only safe, obvious fixes and continue, but pause the whole run for any judgment-call finding or one touching public interfaces, security, data loss or deletions, or dependency changes.

End with exactly these next options when findings exist:

```text
Review complete. Findings need a decision:
1. Fix all findings
2. Fix selected findings: [list numbers]
3. Defer selected findings with a reason
4. Pause here / make no changes
```

If there are no findings, say so clearly and mention any remaining verification risk. End with exactly these next options:

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
- Treat extra unplanned scope as a finding.
- Do not focus on formatting that automated tools should handle.
- Do not manufacture issues.
- Outside autopilot, do not fix findings automatically; wait for the user to approve all fixes, select specific findings, defer specific findings, or pause. In autopilot, auto-apply only safe, obvious fixes and pause the run for judgment-call findings (see above).
- Do not mark review complete for commit until approved fixes are made or remaining findings are explicitly deferred by the user.
- Do not commit until high and critical findings are fixed or explicitly deferred by the user.
- Do not ask to start the next delivery-plan step after review.
