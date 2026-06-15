---
name: review-work
description: Review the current diff against the approved Codument plan, tests, docs, registry, and architecture boundaries.
---

# Review Work

Use this after a planned step has been implemented and before committing.

## Review Order

1. Read the approved plan step.
2. Inspect the current diff.
3. Check whether the implementation matches the planned behavior.
4. Check tests or verification output.
5. Check docs and `docs/.registry.json`.
6. Look for correctness, security, data-loss, performance, type-safety, and maintainability issues.

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

## Rules

- Treat extra unplanned scope as a finding.
- Do not focus on formatting that automated tools should handle.
- Do not manufacture issues.
- Outside autopilot, do not fix findings automatically; wait for the user to approve all fixes, select specific findings, defer specific findings, or pause. In autopilot, auto-apply only safe, obvious fixes and pause the run for judgment-call findings (see above).
- Do not mark review complete for commit until approved fixes are made or remaining findings are explicitly deferred by the user.
- Do not commit until high and critical findings are fixed or explicitly deferred by the user.
- Do not ask to start the next delivery-plan step after review.
