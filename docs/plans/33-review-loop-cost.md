---
status: approved
---

# Plan 33: review-loop cost — delta bundles, ranked dependents, a discovered test runner

The Peelmeal field report is the first one measured rather than described: three delivery steps,
six adversarial runs, **~44 minutes of review wall-clock and ~970k subagent tokens against ~20
minutes of implementation** — ceremony outweighing work roughly 2:1. The gate earned its keep (two
real bugs in step 1, a tautological test in step 2, a missing negative case in step 3), so the
finding is not "the gate is wrong". It is that the gate charges full price for every round, hands
the adversary a padded oracle, and nags about a runner the project could have declared once.

Three verified facts drive this plan. Each was checked against source and the first proposed fix
for each was adversarially refuted before landing here.

1. **A recorded review is one composite hash over the whole real-change set and nothing per-file.**
   `diffFingerprint` (`src/lib/review-artifact.ts`) folds every changed file into a single digest;
   `ReviewArtifact` persists no file list. So fixing a confirmed finding voids the artifact, and
   nothing on disk can tell the next round *which* files are newly unreviewed — `--bundle` re-emits
   the entire change set and `agents/adversarial-reviewer.md` tells the subagent to read every
   changed source in full. Step 1 cost three full re-attacks to close three findings.
2. **The dependents list is a raw cross-product with no reason and no rank.** `changedFeatures`
   (`src/lib/change-state.ts`) is built from `fileToFeatures` = `primary_sources` ∪
   `related_sources`, so one `src/lib` edit wakes the `lib` and `change-control-gate` umbrella
   entries, which between them are the target of 24 of this repo's declared `depends_on` edges.
   Editing `src/lib/change-state.ts` emits **24 unranked pair-lines over 19 distinct features**.
   Nothing dedupes, ranks, or caps — in the CLI, in the HTML card, in the HTML detail list, in
   `--json`, or in the `--bundle` oracle handed to the reviewing subagent.
3. **The test command is flag-only, and the honesty condition keys off the wrong thing.** There is
   no `testCommand` in `.codument-meta.json` and nothing reads `package.json`. Worse than the nag:
   `defaultCommandAvailable` probes only the DEFAULT runner, so the named "could not run" condition
   fires on *flag absence*, never on a supplied command that fails. A bun+vitest project already
   gets `unrunnable` → advisory on every finding via the TAP-evidence rule in `makeTestRunner`, and
   `doctor --verify-invariants` says nothing about it at all.

## Why

- Fix 1 removes the dominant cost without touching the gate. The saving comes from **scoping the
  oracle**, not from weakening enforcement: round 2's adversary reads the one file the fix touched
  instead of twelve.
- Fix 2 is the fail-loud house rule inverted. A section that prints 24 reason-less lines on every
  run trains the reader — human and subagent — to skip the place a real warning would appear.
- Fix 3 converts a per-run nag into a project fact, and closes the hole the nag was hiding: today
  the condition can be silenced by a flag while every finding still goes unadjudicated.

## Scope

- `src/lib/review-artifact.ts` (persisted `files[]`, delta computation)
- `src/lib/review-bundle.ts`, `src/commands/review.ts`, `src/cli.ts` (delta bundle, ranked
  dependents, resolved runner, reworded conditions)
- `src/lib/review-confirm.ts` (`resolveTestCommand` inside `makeTestRunner`)
- `src/lib/change-state.ts` (`dependentsSummary`), `src/lib/report-html.ts` (card + detail list)
- `src/lib/codemod.ts` (`testCommand` in `MetaFile`), `src/commands/doctor.ts` (same condition)
- `skills/review-work/SKILL.md` + `.claude/skills/review-work/SKILL.md`,
  `agents/adversarial-reviewer.md`
- `tests/review-artifact.test.ts`, `tests/review.test.ts`, `tests/review-bundle.test.ts`,
  `tests/review-confirm.test.ts`, `tests/change-state.test.ts`, `tests/report.test.ts`
- `docs/features/adversarial-review-gate.md`, `docs/features/change-control-gate.md`,
  `README.md`, `CHANGELOG.md`, `docs/.registry.json`

No new source files. No `map materialize` needed.

## Non-goals

- **No composable coverage.** The tempting version of fix 1 — let round 1's artifact keep covering
  the files round 1 saw, and pass the gate on the union — was refuted and is explicitly rejected
  here. `--record` computes coverage over the whole real-change set with no reference to what the
  bundle handed the reviewer, so a delta-scoped review would mint a *durable* coverage token for
  files nobody attacked, and an unrelated edit made in the same round would ride in covered. Today
  that over-claim is self-limiting because the artifact expires the instant anything moves. The
  gate stays binary; only the oracle gets scoped.
- **No reverse import index / per-dependent "these three import the symbol you changed".** It needs
  a repo-wide source parse, and `review` is deliberately incremental — it parses only changed files.
  `doctor` already pays that cost and is the right home if this is ever built. The ranked summary
  ships first; the index gets its own plan if the summary proves insufficient.
- **No dropping dependents from the data.** `state.dependents` is a machine contract (`--json`,
  `--bundle`); collapsing pairs in the data breaks `tests/review-bundle.test.ts` and every consumer.
  The collapse is a rendered summary alongside the raw array, never a replacement.
- **No auto-derived test command.** `package.json` `scripts.test` has no `{file}` slot, and this
  repo's own is `NO_COLOR=1 tsx --test tests/*.test.ts` — `spawnArgvSync` would exec a binary named
  `NO_COLOR=1`. Devdependency detection would also need TAP-reporter selection, or it trades a loud
  warning for a silent always-advisory gate. Flag > config > built-in default, and stop.
- **No `ConfigValueError` for a malformed `testCommand`.** `readMetaSync` runs on nearly every
  command path via `resolveScopeSync`; a typo in a field used by two opt-in modes must not hard-fail
  `scan`. It degrades loudly instead (see Decisions).
- No change to `review --strict`, exit codes, or the confirm classifier.

## Decisions (settled)

**Fix 1 — delta bundles, binary gate.**

- `ReviewArtifact` gains `files: Array<{path, hash}>` — the byte-normalized per-file hash of every
  real-change path at record time, computed by `--record` exactly like `diffFingerprint` is. It is
  **scoping information only**. `evaluateReviewGate` never reads it; coverage stays the single
  whole-set fingerprint equality it is today. `parseReviewArtifact` treats an absent `files` as
  "no delta information available" and the bundle falls back to the full change set, so existing
  artifacts and older codument readers are unaffected.
- `--bundle` picks the most recent artifact whose `base` equals the current `effectiveBase`,
  diffs its `files[]` against the current change set, and sets `changedSources` to the delta
  (added paths + paths whose hash moved). It carries two new fields: `alreadyReviewed` (the paths
  the prior artifact hashed and that have not moved) and `priorFindings` (that artifact's findings,
  so round 2 can check the fix actually fixed them). When no prior artifact matches the base, the
  delta is the whole set and the bundle is byte-identical to today's.
- The per-feature contract block is **not** scoped. `review-bundle.ts` builds features from
  `changeState.byFeature`; the adversary keeps every documented invariant and test pointer for
  every touched feature. Only the file list it is told to attack narrows.
- `--bundle --full` forces the whole set, for a deliberate fresh attack.
- Named honest limit, added to the feature doc beside the existing "an empty-findings review still
  passes": a fix in file A can weaken file B, and B's bytes did not move, so the delta bundle will
  not re-attack B. `alreadyReviewed` + `priorFindings` give the reviewer the context to notice;
  the gate does not promise to catch it. This is the same class of limit the gate already documents,
  and it is why coverage stays binary — every byte in the change set must still be inside one fresh
  artifact before the gate passes.
- The messages move with the behavior: the `--require-review` human hint and the SARIF notification
  currently say "Run a fresh adversarial review of this diff"; under a delta they must name the
  count of files needing attack. `skills/review-work/SKILL.md` step 4 stops saying "re-review and
  re-record" and says fix, re-run the adversary against the delta bundle, re-record.
  `agents/adversarial-reviewer.md` reads `alreadyReviewed`/`priorFindings` as context and attacks
  `changedSources`.

**Fix 2 — ranked, capped, everywhere.**

- `computeChangeState` gains `dependentsSummary: Array<{feature, dependsOn: string[], viaUmbrella:
  boolean}>` — one entry per dependent feature, its edges collapsed. `dependents` is untouched.
- Rank: a dependent whose edge points at a `type: "feature"` entry sorts above one whose edge
  points only at a `type: "concept"` umbrella. Depending on an umbrella that narrates a whole
  directory is the weakest possible signal, and it is the volume generator — 24 of this repo's
  edges point at two umbrellas.
- Render, in all four places that today print the raw pairs: a count line, the top 5 by rank with
  their edges inline, and `… and N more`. `src/commands/review.ts` `printHuman`;
  `src/lib/report-html.ts` card (which must count `dependentsSummary`, not `dependents.length` —
  the current count is inflated by pairs) and detail list; and `review-bundle.ts`, which passes
  `state.dependents` through verbatim into the oracle. The bundle is the case the complaint
  condemns most: the section exists to give the adversary a bounded contract, and 24 reason-less
  pairs is the opposite.
- `--json` gains `dependentsSummary` additively; `dependents` stays for compatibility.

**Fix 3 — a discovered runner that stays honest.**

- `.codument-meta.json` gains optional `testCommand: string`. Precedence: `--test-command` flag >
  `testCommand` > built-in default.
- Resolution lives in **`makeTestRunner`**, not at the call sites. It already takes `root` and
  already falls back to `DEFAULT_TEST_COMMAND`, so one guard covers every caller — including
  `invariantProbes`, which is exported with an optional command and today silently defaults to tsx
  for any caller that omits it. Patching `review.ts` and `doctor.ts` individually would leave that
  sibling broken.
- A `testCommand` without a `{file}` slot would silently run the whole suite once per finding.
  It is refused at **resolution** time, not at meta-read time: the runner ignores it, falls back to
  the default, and the caller surfaces a named condition. `scan` and `doctor` keep working.
- The honesty condition is rewritten to key off **outcomes, not flags**. Today it fires when the
  default runner is unresolvable and is silenced by supplying a command — so a configured
  `vitest run {file}` produces `unrunnable` → advisory on every finding with nothing on screen. It
  becomes: *N findings could not be adjudicated — the runner produced no test evidence*, emitted
  whenever any finding resolves `unrunnable`, whatever the command's provenance. The
  runner-unavailable case is one input to it, not the trigger.
- `doctor --verify-invariants` gets the same condition. It has none today, so a bun+vitest project
  already sees silently-unrunnable invariants; fixing the review side alone would leave the two
  consumers of one runner reporting toolchain failure differently.
- The TAP fail-open itself is unchanged and stays a documented limit — this plan makes it *visible*
  rather than silent, which is the part that was actually broken.

## Delivery Plan

- [x] **Step 1 — Artifact `files[]`.** Persist per-file byte-normalized hashes in `--record`
      (computed by the CLI, never by the agent), parse them, treat absence as legacy. Prove the
      gate is unchanged: existing coverage tests stay green untouched, plus a test that an artifact
      with `files[]` still voids on any edit.
- [x] **Step 2 — Delta bundle.** `--bundle` resolves the prior artifact by base, emits the delta as
      `changedSources` with `alreadyReviewed` + `priorFindings`, keeps the full per-feature contract
      block, and honors `--full`. Tests: no prior artifact → byte-identical to today; one file fixed
      → delta of one, contract block unchanged; base moved → full set.
- [x] **Step 3 — Messages and orchestration.** Reword the `--require-review` hint and the SARIF
      notification to name the delta; rewrite `skills/review-work/SKILL.md` step 4 and its
      `.claude/` copy; update `agents/adversarial-reviewer.md`. Test the printed output both ways.
- [x] **Step 4 — Ranked dependents.** `dependentsSummary` in `computeChangeState` with the
      umbrella-last rank; render it in `printHuman`, the HTML card *and* detail list, and the
      bundle; `--json` additive. Golden tests on this repo's own registry shape: 24 pairs → one
      count line plus 5 ranked entries; `dependents` unchanged; HTML count no longer inflated.
- [x] **Step 5 — Resolved test command.** `testCommand` in `MetaFile`; `resolveTestCommand` inside
      `makeTestRunner` with flag > config > default and a loud fallback on a missing `{file}`;
      `--test-command` help text and README updated. Tests: config resolves, flag overrides,
      malformed degrades loudly, `invariantProbes` picks it up without its caller passing it.
- [x] **Step 6 — Outcome-keyed honesty condition + docs.** Replace the flag-keyed condition in
      `review.ts` with the unadjudicated-findings condition; add it to `doctor --verify-invariants`;
      update `docs/features/adversarial-review-gate.md` (the delta-bundle limit, the coverage
      invariant restated as unchanged, the reworded condition), `docs/features/change-control-gate.md`
      (dependents summary), CHANGELOG, and `docs/.registry.json`.

## Acceptance criteria

- A three-round step costs one full attack plus two single-file attacks; the gate's verdict is
  identical to today's at every round, and every byte of the change set still sits inside one fresh
  artifact before it passes.
- An unrelated edit made between rounds still blocks, and an artifact still voids on any edit —
  proven by the existing coverage tests passing unmodified.
- Editing `src/lib/change-state.ts` in this repo prints a count plus five ranked dependents, not 24
  pairs, in the CLI, the HTML card, the HTML detail list, and the bundle.
- A bun+vitest project declares `testCommand` once, never sees the tsx nag again, and *does* see a
  named line saying its findings could not be adjudicated.
- `npm run typecheck`, `npm run build`, `npm test` green; `codument review --strict` green at every
  commit of this plan.

## Verification strategy

- Unit: artifact `files[]` round-trip and legacy absence; delta computation across
  no-prior/one-fixed/base-moved; `dependentsSummary` rank and collapse; `resolveTestCommand`
  precedence and the malformed-slot fallback.
- Gate regression: every existing `tests/review.test.ts` and `tests/review-artifact.test.ts`
  coverage assertion passes **unmodified**. If one needs editing, the gate changed and the plan's
  central promise is broken.
- End-to-end: record → fix a finding → `--bundle` emits a one-file delta carrying the prior finding
  → re-record → gate passes; and an unrelated file edited in the same window still fails.
