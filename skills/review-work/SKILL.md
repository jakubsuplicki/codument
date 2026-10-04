---
name: review-work
description: Review the current diff against the approved Codument plan, tests, docs, registry, and architecture boundaries.
---

# Review Work

Use this after a planned step has been implemented and before committing.

If this is the session's first workflow action, run the compatibility check from `work-step`
before lifecycle commands. The actual executable must expose `work` and `verify`; repair a
mismatch instead of substituting older commands or manual checkpoints.

For compact dead-code cleanup, use the same generated worksheet and independent reviewer. Check the
unused-code evidence against exports, dynamic loading, framework entry points and side effects;
deletion is never automatically trivial. Do not demand a second plan or a separate review bundle
when the worksheet already supplies the reviewed boundary. Historical paths inside the plan remain
valid scope; durable Key files and registry pointers must describe what remains.

## Review Order

1. Read `codument work status --json` and its approved plan step. After final compaction, use the tracked contract and final-delivery binding in `docs/.approvals.json`; the pending-plans recovery copy supplies working context only. Inspect the compacted doc in the staged boundary as usual.
2. Inspect `git diff --cached`; that exact staged boundary, not the whole dirty worktree, is the review subject.
3. Run `codument verify` once. Read the generated `reviewPolicy.minimum` and `reasons`; it writes `.codument/review-worksheet.json` when required focused or adversarial review lacks current coverage.
4. Diagnose routine test, mapping or documentation failures and correct the cause within the approved contract. Batch missing source registration through `codument map materialize <files...>`, inspect any partial failure and retry after correcting it, then restage and rerun the affected checks and `codument verify`. The staged boundary checks ownership and doc sync together; do not repeat per-file ownership queries or add mirror prose merely to make it green. Ask the human only when repair needs an unapproved decision, external input or a genuinely irreversible action.
5. Compare the promised outcome and acceptance criteria with the evidence actually obtained at the relevant user or integration boundary. Name untested assumptions and substitutes; missing required evidence remains a blocker unless the user explicitly changes acceptance. Review the exact staged diff, mapped invariants, tests and generated `reviewContext` when present with the effort below.
6. When a worksheet is required, complete only its top-level `invariantsChecked`, `findings`, and `signer` fields. Do not alter generated context. Run the exact printed `codument verify --record .codument/review-worksheet.json` command; it records and verifies the same staged boundary in that invocation.
7. Fix safe, obvious findings that follow the approved contract, restage, and return to step 3. Findings involving public interfaces, privacy, security, migrations, data loss, deletions or dependencies receive stronger review; an obvious contracted fix does not require renewed human approval merely for touching that boundary. Pause for unapproved judgment calls, changed promises or constraints, external input or a genuinely irreversible action. A changed boundary invalidates its earlier review automatically; gated mode still waits for the user's findings decision.
8. When `codument verify` passes, run `codument work finish` to preserve verified readiness, then continue to `commit-work` without a routine prompt. If the user prohibited commits, stop with ready work and the pending commit visible. The exact receipt lets the hook confirm unchanged staged bytes. Gated and single-step requests retain their limits.
9. If review pauses or the user redirects work, preserve the plan path, step, next gate, unresolved finding or failure, and resume condition in the plan's Resume checkpoint (in its recovery copy after final-step compaction). Recheck the staged boundary on return; a changed boundary invalidates earlier review. If fixes restore delivery scaffolding, recompact and restage it before recording the final review.

## Review effort

For `none`, make a one-pass diff self-review without creating a required worksheet.

The generated minimum is a floor, not proof of semantic safety. When it permits `focused`, use
focused self-review only for an understood, small, local and reversible change. Check the affected
behavior, callers, documented invariants and acceptance evidence; escalate to adversarial review
if the behavior is substantial or understanding is uncertain.

For `adversarial`, use a fresh independent reviewer without the author's conversation when the
host provides one. Attack correctness, privacy, security, data loss, performance, type safety and
architecture fit. Without an independent reviewer, make the same pass and disclose reduced
independence. Disclose focused self-review as such. Public-interface or documented-contract
changes, privacy, security, risk declarations, migrations, deletions, dependencies and uncertain
analysis retain the stronger floor; neither a small file count nor a "low risk" label can waive it.

Both efforts use the ordinary generated worksheet, named finding confirmation and exact receipt
path. Fill only its existing reviewer fields; do not rewrite the generated policy or invent an
effort artifact. Every covering reproduced-red finding blocks delivery regardless of effort;
changed review evidence must not reuse an outdated pass.

## Preparing a branch for CI

When delivering a branch to CI, the staged-step gate and full branch review are separate boundaries.
Branch and portable review retain independent adversarial effort; local focused review cannot
substitute for it.
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

Auto-apply only safe, obvious fixes within the approved contract and continue to `commit-work`
after renewed verification and review. Pause for an unapproved judgment call, external input or
genuinely irreversible action. In gated mode, list findings and stop for the user's decision;
do not fix findings automatically.

In gated mode, end with exactly these next options when findings exist:

```text
Review complete. Findings need a decision:
1. Fix all findings
2. Fix selected findings: [list numbers]
3. Defer selected findings with a reason
4. Pause here / make no changes
```

If there are no findings, say so clearly and mention any remaining verification risk, then continue
to `commit-work`. An explicit no-commit request takes precedence: report verified readiness and
the pending commit, then stop without offering a commit action. Otherwise, in gated mode end with
exactly these next options:

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
- Treat work outside the approved outcome and constraints as a finding. Additional implementation files in an outcome plan need routing and ownership repair, not a scope-amendment finding; legacy file-bound plans retain strict scope review.
- Do not focus on formatting that automated tools should handle.
- Do not manufacture issues.
- Auto-apply only safe, obvious fixes, and pause the run for judgment-call findings (see above). In gated mode do not fix findings automatically at all; wait for the user to approve all fixes, select specific findings, defer specific findings, or pause.
- Do not mark review complete for commit until contracted safe fixes or user-approved fixes are made and remaining findings are explicitly deferred by the user.
- Do not commit until high and critical findings are fixed or explicitly deferred by the user.
- Do not ask to start the next delivery-plan step after review.
