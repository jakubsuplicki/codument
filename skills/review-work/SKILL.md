---
name: review-work
description: Review the current diff against the approved Codument plan, tests, docs, registry, and architecture boundaries.
---

# Review Work

Use this after a planned step has been implemented and before committing.

## Adversarial pass (the independent reviewer)

AI must never be trusted to grade its own work. For a **non-trivial** diff, run an INDEPENDENT adversarial review before committing — a reviewer that assumes the change is wrong until a reproduction proves otherwise. `codument review --require-review` is the arbiter of "non-trivial": it requires the pass for more than one real change, any deletion, a config/data change, a risk touch, an ownership ambiguity, a module-level change, or anything beyond a single resolved symbol. A genuinely trivial diff skips this pass (the gate says so) and gets only the deterministic self-review below.

1. **Assemble the oracle.** `codument review --bundle > .codument/review-bundle.json` — the touched features' documented invariants, the tests that pin them, the diff, and the ownership/blast facts. It adds no new source of truth; it hands the adversary a contract to attack instead of an open-ended hunt. When a review of this same base is already recorded, the bundle scopes itself to what has moved since (`scope: "delta"`) and carries the rest as `alreadyReviewed` + `priorFindings`; `--full` forces the whole change set for a deliberate fresh attack.
2. **Run the adversary against the bundle — independence by context, degraded gracefully.**
   - **Subagent host (Claude):** spawn a FRESH `adversarial-reviewer` subagent fed ONLY the bundle — never your transcript or your reasoning, so it cannot re-anchor to the author's mental model. It reads `git diff <base>`, attacks the invariants, writes a failing test for each real bug, and emits a findings JSON.
   - **No-subagent host (Codex):** run the same adversarial pass yourself against the bundle, with deliberately fresh eyes — apply the `adversarial-reviewer` mandate as if you had not written the code. Independence is weaker, but the deterministic confirm and the fingerprint-bound artifact are identical, so it is not theater.
3. **Record the verdict.** `codument review --record <findings.json>` writes the fingerprint-bound artifact. Any later edit to a reviewed source — or to a finding's named test — auto-invalidates it, so you cannot review once and keep editing.
4. **Enforce.** `codument review --require-review`. It RE-RUNS each finding's named test and blocks only on one that is genuinely red — never on a claimed status. Fix every confirmed (red-test) finding before committing; advisory findings are surfaced for your decision, never auto-blocking.

   Fixing a finding reopens the gate — but **re-run the adversary on the delta, not on the whole diff again**. Repeat step 1 (the bundle now scopes to the files your fix touched, carrying the earlier findings so the adversary can check the fix actually fixed them), step 2, step 3. Reach for `--full` only when the fix was broad enough that the earlier round's reading no longer holds. Re-attacking the whole diff after every one-line fix is how a three-finding step costs three whole-diff reviews.

The adversarial pass complements the deterministic review below; it does not replace it.

## Review Order

1. Read the approved plan step.
2. Run `codument review --log` (add `--json` to consume it programmatically). `--log` snapshots a `caught` event — the **provable** line of the impact ledger (`codument watch` / `report`) — recording the stale docs, risk touches, and off-plan files this change flagged **while they are still present** (before step 6 clears them). The report gives the deterministic change-state: which feature owners the diff touches, docs that went **stale** (source changed, mapped doc didn't), high-risk areas touched, out-of-plan changes, unmapped new files, and dependent features that may need re-review. Use it as the spine of the review — it tells you where to look; it does not certify the change is safe.
3. Inspect the current diff.
4. Check whether the implementation matches the planned behavior.
5. Check tests or verification output.
6. Resolve every `codument review` finding inline (autopilot-aligned — no separate human gate). For each **stale doc / symbol-drift** finding, make the two-way call and act in this same step:
   - **A documented contract or behavior changed** → update the owning doc at **intent altitude** (the contract and why, never a symbol mirror) and its `docs/.registry.json` entry.
   - **A pure-internal refactor that changed no documented contract** → run the exact `codument ack <path>::<symbol> --reason "..."` line `review` printed, naming the invariant that stayed constant.
   Default to updating the doc; ack only when you can name in one clause what stayed constant — a bare "refactor" reason is not enough, and writing a mirror sentence just to clear the gate is the rubbish this loop exists to prevent. Also register unmapped source files and flag dependents whose interface changed, then re-run `codument review` to confirm the findings clear. The `Drift resolution` line shows your acked-vs-updated split — an all-ack change should make you re-check that none of those moves actually owed a doc update.
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
