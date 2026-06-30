---
title: Adversarial review gate
status: in-progress
type: feature
owner: ""
primary_sources:
  - src/lib/review-bundle.ts
  - src/lib/review-artifact.ts
  - src/lib/review-confirm.ts
  - src/lib/review-gate.ts
related_sources:
  - src/commands/review.ts
  - src/cli.ts
  - src/lib/git.ts
  - src/lib/two-ref.ts
docs: []
depends_on:
  - change-control-gate
  - agent-delivery-workflow
  - cli
  - commands
  - lib
risk: []
last_reviewed: 2026-06-30
---

# Adversarial review gate

## In plain terms

Today the review step is the same agent grading its own homework, and the loop only treats it as advisory. This gate makes review an **independent adversary** that is presumed to be hunting for failure, handed a precise contract to attack: the diff, the invariants it must not break and the tests that pin them, the relevant plan slice, and the ownership/blast facts. Its verdict becomes a required, diff-bound artifact at the commit gate, not a vibe.

On a host with subagents (Claude) the adversary is a **fresh subagent** with its own context window, so it never inherits the author's reasoning — independence is a property of the host, not something we engineer. On a host without subagents (Codex) it degrades to a **same-agent adversarial pass** against the identical bundle: weaker independence, but the deterministic confirm and the diff-bound artifact still bite. The enforcement is identical on both; only the spawn differs.

A finding only **blocks** when it ships a failing test Codument can run. Findings that cannot be reduced to a test (a design concern, an untestable invariant weakening) are recorded and routed to the existing review decision point, never auto-blocked. The artifact is bound to the diff fingerprint, so editing after review auto-reopens the gate.

## Design approach

The gate splits the same way the change-control gate does: a **deterministic enforcer** that is host-neutral and LLM-free, and an **agent adversary** layered on top. Confusing the two is the failure mode.

**The enforcer is host-neutral CLI and never judges prose.** It assembles the bundle (the contract to attack), runs the confirm (executes the findings' named failing tests), records a fingerprint-bound artifact, and decides the gate. None of this needs a model, and it runs byte-identically for Claude and Codex. It reuses the change-control gate's existing spine: the change-state analyzer, the anchor/ownership/blast facts, and the acknowledgment protocol's fingerprint-binding and auto-invalidation.

**The bundle is the oracle, and it is Codument's unfair advantage.** "Assume it is wrong" is a stance, not a method: wrong against what? Generic "review my code" agents flail and nitpick because they have no ground truth. Codument already extracts the documented `## Invariants & boundaries` layer and its test pointers, the plan, and symbol-grained ownership, so it can hand the adversary a contract to check against instead of an open-ended hunt. The bundle introduces no new source of truth; it is derived purely from committed docs and the deterministic change-state.

**Verify, don't trust — this breaks the who-reviews-the-reviewer regress.** The adversary only produces candidate findings. A finding counts as blocking only once a deterministic step confirms it: run the cited failing test, see it red; the fix flips it green. We never trust the adversary's judgment, only the reproduction. This mirrors the change-control gate's rule that it verifies an ack's *form*, never its semantic truth. It also bounds the dominant failure mode — adversary false-positives turning into alarm fatigue — because an unconfirmed finding cannot block.

**Independence by context, degraded gracefully.** A second agent that still receives the author's transcript re-anchors to the same mental model and rubber-stamps; completion bias is why self-review fails. So the adversary gets the diff plus the bundle, never the author's chain of thought. Where the host has subagents, a fresh Task delivers that for free. Where it does not, the same-agent pass is the honest floor (option A): the independence is weaker, but the artifact and the deterministic confirm are unchanged, so it is not theater.

**Proportionality is mandatory, not optional.** Two extra agent passes on every one-line edit is how a good gate gets disabled. Bundle depth is gated on blast radius, which Codument already computes: a trivial single-symbol edit touching no documented invariant skips the heavy pass; a risk-tagged, invariant-touching, or multi-file diff gets the full adversary.

## Invariants & boundaries

These are the contracts the build commits to. Tests land with the step that builds each; until then they are marked planned. The step-4 set was hardened after a second adversarial re-verification (7 confirmed holes, all closed) — each invariant below names the test that now pins it.

- **The review fingerprint binds the reviewed sources AND the tests the findings name, over the FULL real-change set, and auto-invalidates when any of them change.** Content is byte-normalized (BOM/CRLF) like every other hasher, so a benign line-ending flip never false-blocks; any source, config/data, or deletion edit moves the fingerprint. Binding the named tests is load-bearing: a confirmed finding cannot be **green-washed** by editing or deleting its test while leaving the buggy source unchanged — that tamper moves the fingerprint and reopens the gate. *(test: review-artifact.test.ts — gatherReviewFingerprint moves on a named-test edit/deletion and on source/set/base change, is byte-normalized, and ignores a finding with no test)*
- **A finding hard-blocks only when its named test is genuinely red, re-run by the gate at check time; a toolchain failure is never a false block.** Non-testable findings stay advisory. A nonzero exit counts as red only with evidence the runner actually executed tests (TAP); a missing runner or resolution error exits nonzero with no test output and degrades to unrunnable→advisory, so a consumer without the test toolchain is not blocked on every finding. *(test: review-confirm.test.ts — a red test confirms (blocking); a nonzero exit with no test evidence is unrunnable; a claimed status is overridden by the reproduction)*
- **The adversary is never on the gate's certification path beyond producing candidate findings.** Pass/fail is decided by running tests, with no model call in the verdict. *(test: review-confirm.test.ts — the classifier is a pure function of test outcomes)*
- **A clean pass must enumerate the invariants the adversary checked; silence is not a pass.** The artifact schema rejects an empty bill of health. *(test: review-artifact.test.ts — parseReviewArtifact rejects an empty/whitespace invariantsChecked)*
- **Re-confirmation runs only an in-tree test; a reference that escapes the repo is refused, by realpath not just lexically.** A `../../` ref and a symlink under root whose target leaves the tree both fail to resolve, so the gate never spawns the runner on out-of-tree code. *(test: review-confirm.test.ts — resolveTestPath rejects a `../../` ref and a symlink escaping root, still resolves an in-root symlink)*
- **The fingerprint base is a resolved object name, never the literal `HEAD`.** It is the HEAD sha, the `--base` merge-base sha, or the empty-tree sha before the first commit, so a fresh-repo/first-commit boundary cannot flip the base under an unchanged tree, and the step-5 writer records exactly this value. *(test: two-ref.test.ts — EMPTY_TREE_SHA / resolveBase; review.ts derives effectiveBase)*
- **Enforcement is host-neutral.** The bundle, confirm, artifact, and gate run identically for Claude and Codex; only the spawn differs (fresh subagent vs same-agent pass). *(planned — step 5)*
- **Proportionality covers the full real-change set; only a provably-small edit is trivial.** A review is required for more than one real change, any deletion, any config/data (non-source) change, a risk touch, an unresolved ownership ambiguity (an unassigned shared symbol — the fail-loud shape), or a single source the analyzer could not resolve to exactly one moved symbol (coarse/non-TS/unmapped/unevaluable, **or whose only moved anchor is the `<module>` residual**, which is unresolved module-level content such as a side-effect or import, not a confirmed symbol). The one trivial case is a single source resolved as exactly one moved owned symbol, no risk. *(test: review-gate.test.ts — the proportionality matrix incl. deletion, config, coarse/zero-symbol, ownership-lint, and the `<module>`-residual exclusion via countResolvedMovedSymbols)*
- **The gate is opt-in (`--require-review`) and RE-DERIVES finding statuses by re-running each named test — it never trusts the status an artifact claims.** A finding typed `advisory` whose test is red re-promotes to blocking; a `confirmed` whose test is green clears. The default-on flip is soak-deferred, like the change-control gate's blocking flip. **Honest limit:** an empty/omitted-findings review still passes — the gate enforces the review *ritual* (a diff-bound artifact enumerating invariants checked) and verifies *declared* findings, but cannot force a review to be thorough (soak/audit territory, like the ack gate's inability to verify semantic truth). *(test: review-gate.test.ts the verdict; round-trip proven live: typed-advisory+red→block, typed-confirmed+green→pass)*
- **The bundle adds no new source of truth.** It is derived purely from committed docs and the deterministic change-state (diff, ownership, blast). *(test: review-bundle.test.ts — pure projection of change-state + docs)*

## Decisions

- Adversarial review is independent by context and degrades without subagents (option A: same-agent pass on Codex) — honors the [agent-delivery-workflow.md](agent-delivery-workflow.md) non-goal that no profile may *require* subagents. To be recorded as ADR 011 in step 6.
- A finding blocks only when confirmed by a runnable failing test; judgment findings stay advisory — the deterministic-not-judge line of [008](../architecture/decisions/008-benchmark-proof-deterministic-not-judge.md) and the detect-test-verify line of [010](../architecture/decisions/010-freshness-resolution-detect-test-verify-agent-driven.md), applied to implementation review. To be recorded as ADR 011/012 in step 6.

## Key files

To be created as the steps land; listed here at intended role so the plan is legible.

- `src/lib/review-bundle.ts` — assembles the adversary's contract bundle from the change-state plus the owning/blast docs' invariants-and-tests, the plan slice, and ownership facts. (step 1)
- `src/lib/review-artifact.ts` — the fingerprint-bound review record: parse/validate, coverage, auto-invalidation. Its `gatherReviewFingerprint` binds the reviewed sources together with the findings' named tests, so a test tamper invalidates the review. Sibling to `acknowledgment.ts`. (steps 2, 4a)
- `src/lib/review-confirm.ts` — runs each finding's named failing test and marks it confirmed (blocking) or advisory, distinguishing a red test from a toolchain failure (no false block) and refusing an out-of-tree test path. (steps 3, 4a)
- `src/commands/review.ts` — extended: emit the bundle, and wire the artifact requirement into `--strict`, proportionality-gated. (step 4)
- `src/lib/review-gate.ts` — the pure gate decision: the proportionality predicate and the verdict over a covering artifact. (step 4)
- `src/commands/review.ts` + `src/cli.ts` — the `--require-review` wiring: assemble the full real-change set, fingerprint it, find the covering artifact, re-confirm its findings, evaluate the gate, fold into the exit code, and surface advisory findings. (step 4)
- `src/lib/git.ts` + `src/lib/two-ref.ts` — `getWorkingTreeDeletions` / `worktreeDeletionsSince`: the deletion view the change-state path deliberately drops, so the gate counts deletions toward proportionality and moves the fingerprint on a deletion. (step 4)
- `skills/review-work/SKILL.md` + `agents/adversarial-reviewer.md` — the spawn (Claude fresh subagent) and the degrade (Codex same-agent pass), both writing the identical artifact. (step 5)

## Delivery plan

Status: approved (2026-06-30). Implementing manually, one gated step at a time. This section is transient scaffolding and compacts out when the feature ships; surviving decisions move to the Decisions layer and ADRs.

- [x] **Step 1 — Review bundle assembler.** From a diff + base, assemble `{diff hunks, owning+blast docs' Invariants & boundaries + their test pointers, plan slice, ownership/blast facts}`. Pure and deterministic; reuses the change-state analyzer and ownership. Register `src/lib/review-bundle.ts` and bump this feature to `in-progress`. *(`src/lib/review-bundle.ts` + `tests/review-bundle.test.ts`, registered.)*
- [x] **Step 2 — Review artifact + fingerprint binding.** Define `.codument/reviews/<id>.json` (verdict, invariants-checked, findings[citation, failing-test, status], diff fingerprint). Reuse the acknowledgment fingerprint-binding so any edit after review auto-reopens the gate. Reject an empty invariants-checked list. *(`src/lib/review-artifact.ts` + `tests/review-artifact.test.ts`: parse/validate, `diffFingerprint`, `reviewCoversDiff`/`findCoveringReview` auto-invalidation, loose `.codument/reviews/` files.)*
- [x] **Step 3 — Confirm step.** Run the findings' named failing tests, mark confirmed vs advisory. Deterministic, no arbitrary-code execution beyond the project's own test runner. *(`src/lib/review-confirm.ts` + `tests/review-confirm.test.ts`: pure `confirmFindings` classifier — red→confirmed/blocking, green→resolved, unrunnable/no-test→advisory, claim overridden by the reproduction — plus a thin `makeTestRunner` shelling out to the project runner.)*
- [x] **Step 4 — Gate wiring (gate core), hardened after a multi-lens adversarial review.** Add the opt-in `--require-review` gate: fingerprint the diff, find the covering artifact, evaluate proportionality + verdict, fold into the exit code. Shipped as a **distinct opt-in flag rather than folded into `--strict`** (folding it in would break autopilot's step-sync gate and dogfooding on every multi-file change); default-on flip is soak-deferred. A multi-agent adversarial workflow (7 confirmed findings) drove the final shape: the gate **re-derives** finding statuses by re-running each named test (never trusts a claimed status); proportionality and the fingerprint cover the **full real-change set** (sources + config/data + deletions), so deletions, config edits, coarse/non-TS, and new unmapped files no longer read as trivial; the fingerprint is **byte-normalized** (no CRLF/BOM false-blocks). *(`src/lib/review-gate.ts` + `tests/review-gate.test.ts`; `review.ts`/`cli.ts` wiring; deletion helpers in `git.ts`/`two-ref.ts`; round-trip + re-derivation proven live.)* **Re-scoped:** the `watch` surfacing and the impact-ledger `review` event move to step 6 — both are display/telemetry, and the event needs an impact-ledger schema decision (new type vs. reuse) that shouldn't bloat the gate step.
- [x] **Step 4a — Re-verification hardening.** A second adversarial workflow (five skeptics, each break independently re-verified) found **7 confirmed holes** in the step-4 "done" state — proving the thesis recursively. All closed: **(high)** a confirmed finding could be green-washed by editing its named test (fingerprint omitted tests) → the review fingerprint now binds named-test content (`gatherReviewFingerprint`); **(high)** a shared-file edit with an unassigned co-moved symbol read trivial → an ownership lint now forces a review; **(med)** a `<module>`-residual-only edit read trivial → excluded from the trivial count (`countResolvedMovedSymbols`); **(med)** a toolchain failure false-blocked every finding → the runner now requires TAP evidence to call a nonzero exit `failed`, and the test command is overridable; **(low)** base could be the literal `HEAD` → resolved to a real/empty-tree sha; **(low)** a symlinked test escaped the lexical guard → realpath containment; **(low)** doc front-matter omitted two sources. *(11 new regression tests across review-artifact/-gate/-confirm; 660 tests green.)*
- [ ] **Step 5 — Spawn + degrade.** Claude profile spawns a fresh adversarial Task fed only the bundle; Codex profile runs the same-agent adversarial pass against the bundle. Both write the identical artifact. **The writer MUST compute the recorded `diffFingerprint` via `gatherReviewFingerprint` (same base, full real-change set, and the findings' named tests) and record `base` as the gate's resolved `effectiveBase`** — that fingerprint/base contract is pinned in step 4a, so the writer conforms to it rather than redefining it.
- [ ] **Step 6 — Docs + ADR + tests + deferred surfacing.** Write the ADR(s) for the decisions, fill remaining Invariants test pointers, finalize the registry entry, cover both profiles, and land the step-4-deferred `watch` surfacing + impact-ledger `review` event.

### Acceptance criteria

- The bundle is reproducible from committed docs + change-state, with no model call and no new source of truth.
- The gate blocks a behavior-change diff that lacks a current, diff-bound artifact, and passes once the artifact exists with all confirmed findings resolved.
- A confirmed finding (failing test) blocks; a judgment finding is recorded and routed to the user decision point, never auto-blocking.
- Editing the diff after a review auto-invalidates the artifact and re-opens the gate.
- Trivial diffs (no invariant touched, single-symbol, existing owner) pass without an artifact.
- Enforcement behaves identically across Claude and Codex profiles; only the spawn path differs.

### Verification strategy

- Unit tests for the bundle assembler (deterministic output from a fixed change-state), the artifact parse/validate/coverage/auto-invalidation, and the confirm step.
- Gate tests proving block-without-artifact, pass-with-artifact, auto-invalidation on re-edit, and the proportionality skip.
- Profile tests proving host-neutral enforcement and the two spawn paths.
- `npm run typecheck`, `npm run build`, `npm test` on any source-touching step.

### Non-goals

- No autonomous fixing: judgment findings still hit the user decision point.
- No requiring subagents anywhere — Codex degrades to the same-agent pass.
- No running agent-authored code beyond the project's own test runner.
- The **plan adversary** (contesting the plan before work) is a sequenced follow-up, out of scope here.

### Open questions

- The feature's registry entry was added in step 1 alongside its first source file (a registered feature with empty `primary_sources` would read as undocumented).
