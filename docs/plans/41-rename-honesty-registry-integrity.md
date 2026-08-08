---
status: shipped
---

# Plan 41: rename honesty — the gate sees both sides of a move, and the registry cannot point at ghosts

Probe C of the 2026-08-07 field follow-up, run live on a real repo: `git mv i18n/format.ts
i18n/dateFormat.ts` presents to `codument review --strict` as **add-only** — the new path fails
as unmapped (correct), the old path is never mentioned, and after registering the new path and
resolving the one stale doc, the gate goes green with `i18n/format.ts` still sitting in
`primary_sources` pointing at a file that does not exist. Nothing ever reaps it. The same probe
surfaced a workflow contradiction: `codument map materialize` refused the new path ("no approved
plan with an unchecked step — pass --plan") because the shipped plan's feature map had just been
compacted out of the doc, exactly as the workflow mandates — two mandated behaviours that
disable each other, forcing a hand-edit of the registry.

Verified mechanisms, each checked against source:

1. **The lister discards rename origins by design.** `parseStatusZ` (`src/lib/git.ts`) reads a
   rename entry's origin path from the porcelain stream and consumes it — "we consume but never
   treat as a change of its own". `getWorkingTreeChanges` counts only the post-rename path;
   `getWorkingTreeDeletions` explicitly excludes renames. So the deletion wake that fires for
   `git rm` (probe D) never fires for `git mv`, and the registered origin path vanishes from the
   verdict entirely.
2. **The dangle is detected — where nobody looks, at a severity nothing enforces.** `doctor`
   carries a `missing-source` warn ("mapped source no longer exists", `src/lib/analyze.ts`).
   The delivery loop runs `review --strict` at every step and never runs `doctor`; the field
   session ran review 25+ times and the warn was never seen. Creation passes the gate silently;
   detection lives in another command.
3. **Deletion resolution never mentions the registry.** The deletion wake's guidance says update
   the owning doc or remove the doc with its feature — it never says "remove the path from the
   entry", so even a properly resolved `git rm` leaves the entry naming a ghost (probe D's file
   is now in that state on the field repo).
4. **Post-ship materialize is unreachable.** `map materialize` routes exclusively through an
   approved plan's feature-map rows (`src/commands/map.ts` — no `--feature` option exists), and
   plan compaction removes the map. Every post-ship file addition or rename lands on a refusal
   that points at a plan which no longer exists.

## Why

- A registry that silently accumulates ghost pointers corrupts the control plane the whole
  product rests on: ownership resolution, context packs, and the adversary's grounding all read
  `primary_sources` as truth. A gate that goes green while its own ground truth degrades is the
  fail-loud law inverted — one notch below plan 40's false green only because the lie lands
  later instead of immediately.
- The fix follows the existing seam: review owns what *this change* did (a rename this change
  made, a dangle this change created), doctor keeps owning repo-wide hygiene (pre-existing
  dangles stay a warn there — an adopting repo's old debt must not block unrelated changes).

## Scope

- `src/lib/git.ts` — rename pairs `{from, to}` from the working-tree and base-range listers
  (workspace aggregation included)
- `src/lib/change-state.ts` — registry-pointer findings (rename + change-created dangle)
- `src/commands/review.ts` — strict input, rendering, paste-ready fixes
- `src/commands/map.ts`, `src/cli.ts` — `map materialize <file> --feature <slug>` explicit
  route; refusal message offers it
- `skills/work-step/SKILL.md`, `skills/commit-work/SKILL.md` + installed copies — renames/deletes
  update the registry entry in the same step; Key-files judgment line
- `docs/features/change-control-gate.md`, `docs/features/registry-health.md`, `CHANGELOG.md`,
  `docs/.registry.json`
- Tests: `tests/git` (nearest existing), `tests/change-state.test.ts`, `tests/review.test.ts`,
  `tests/map` (nearest existing)

## Non-goals

- **No forced doc wake for a pure rename.** A rename moves no contract; what is factually wrong
  is the registry pointer, so the gate demands the registry fix. Whether the owning doc's Key
  files layer names the moved path is the agent's judgment, prompted by a skill line — never a
  mandatory doc edit (that would mint exactly the junk-prose pressure plan 36 exists to kill).
- **No repo-wide dangle blocking in review.** Pre-existing dangles stay doctor's `missing-source`
  warn; review blocks only on dangles the change under review created. The seam stays: review
  judges the change, doctor judges the repo.
- **No rename detection beyond git's own.** Whatever git's rename detection reports is what the
  gate sees; no similarity heuristics of our own.
- **No change to deletion-wake semantics for real removals** (ADR 012 stands; plan 40 extends
  the same wake to registered non-source files).

## Decisions (settled)

- **The lister reports renames as first-class pairs.** `parseStatusZ` keeps the origin it
  already reads; the listers expose `{from, to}` alongside changes and deletions, single-repo
  and workspace, working-tree and base-range. A rename is neither a bare add nor a bare delete
  in the change state — it is both paths, linked.
- **A rename of a registered path is a blocking registry finding, not a doc wake.** When a
  rename's origin appears in any entry's `primary_sources`/`related_sources`, review emits a
  registry-rename finding naming the entry and the paste-ready fix (replace the path in the
  entry — or `map materialize <to> --feature <slug>` plus removal of `<from>`). `--strict` fails
  while any entry still names the vanished origin. The new path's own gating (unmapped until
  registered, then normal drift) is unchanged.
- **A change-created dangle blocks the same way.** An entry naming a path that exists at base
  and is deleted at head (rename or `git rm` alike) keeps `--strict` red until the entry stops
  naming it — the deletion wake's doc-attention demand (ADR 012 / plan 40) is separate and
  unchanged; this finding adds the registry half the guidance never mentioned. Pre-existing
  dangles (missing at base too) stay doctor's warn.
- **`map materialize <file> --feature <slug>` is the post-ship route.** The agent names the
  owning feature explicitly — the same decision a feature-map row records, made inline; secondary
  routing stays map-row-only. The no-plan refusal message offers this form. `map check` and
  plan-driven materialize are untouched.
- **Skills carry the practice**: a step that renames or deletes a mapped file updates the
  registry entry in the same step, and checks whether the owning doc's Key files layer names the
  path (update it if so — judgment, not mandate).

## Delivery Plan

- [x] **Step 1 — Rename pairs in the listers.** Working-tree + base-range + workspace
      aggregation; deletions and changes unchanged for non-rename entries. Tests: `git mv`
      yields a pair and neither a bare delete nor a dropped origin; `git rm` unchanged;
      NUL-path edge cases (spaces, non-ASCII) hold.
- [x] **Step 2 — Registry findings + strict.** The rename finding and the change-created-dangle
      finding in `computeChangeState`; strict fails while an entry names a vanished path;
      rendering with paste-ready fixes. Tests: probe C replayed end-to-end — the field
      sequence (mv → register new → resolve doc) stays red until the entry drops the ghost;
      pre-existing dangle does not block; `git rm` with entry cleanup goes green.
- [x] **Step 3 — Post-ship materialize.** `--feature` explicit route; refusal message offers
      it; secondary stays map-only. Tests: routes to the named feature, refuses unknown slugs,
      plan-driven path unchanged.
- [x] **Step 4 — Skills + docs.** The rename/delete registry practice into `work-step` and
      `commit-work` (mirror installed copies); `change-control-gate.md` +
      `registry-health.md` invariants with test links; CHANGELOG; registry entries for touched
      sources.

## Post-ship remediation (adversarial review of `e6cd910..4c931e3`)

Steps 1–4 landed and were then reviewed by three lenses with every finding put to an
independent refuter. Ten findings survived refutation, five were refuted. They reduce to three
roots, all introduced by this plan, and they mean the plan's own acceptance criteria do not yet
hold — hence the reopen rather than a follow-up plan.

**Root 1 — the rename map reached exactly one caller.** `buildReview` passes `renamedFrom` into
`gatherAnchorChanges`; nothing else does. So `review` and `ack` now disagree about the same moved
file, and `review` prints an ack command that `ack` refuses ("was added, not changed"), whose own
suggested fallbacks also refuse. The only surviving resolution is the doc edit the ack route
exists to prevent — which breaks the gate's own standing invariant that *every resolution command
the surface prints works when pasted*. The same single-caller threading is why a rename-aware
base read only ever reached the `precise` branch: a coarse-classified or governed-registered file
still wakes its owning doc on a **pure** rename, making this plan's headline invariant false at
every grain but one, backed by a precise-only test.

**Root 2 — a pair git labels a rename is trusted without checking the head side.** The plan's own
Decisions say "exists at base AND is deleted at head"; neither loop checks the head half. Two
reachable states break it. A **copy** (`status.renames copies`, a supported git setting) reports
`C` — which `isRenameEntry` accepts, while the two-ref twin filters to `R`, so the two listers
disagree — and a copy's origin certainly still exists: the pointer fires on a present file, and
the copy's anchors are read from the original, laundering an entire new contract as unchanged. A
**file split** (`git mv a b`, then re-create `a` as a re-export shim — a routine refactor) leaves
git reporting both the rename and an untracked `a`: the gate reports a path it can see on disk as
removed, and no registry state clears it. Dropping the entry makes the surviving file unmapped;
re-adding it re-fires the pointer; there is no ack path. That is an unsatisfiable `--strict`, the
one failure mode worse than a false green.

**Root 3 — a new blocking finding that only one surface knows about.** `registryPointers` became a
third `--strict` input but was never added to the SARIF projection, `classifyVerdict`, or the HTML
report. All three lenses caught the SARIF half independently. So a CI job uploads a SARIF that
reads as a clean pass while the check exits 1, and `watch`/`report` print `✓ CLEAN` over a tree the
gate blocks — breaking the standing invariant that `review` and `watch` cannot disagree.

Refuted and deliberately not fixed: renames into an excluded path and unstaged filesystem moves
(both pre-existing, and this plan tightened rather than loosened them); `materializeFileTo` not
existence-checking its path (the plan-driven route never did either, and the path is hand-typed in
both); the `--strict` epilogue's generic second sentence (the paste-ready fix is already printed
four lines above, and the mis-route hard-fails rather than looping) — reworded anyway in R3, since
it costs one line to stop naming a command that cannot clear the finding it sits under. Two real
gaps are recorded as future work rather than fixed here. `namingEntries` resolves only
`primary_sources`/`related_sources`, so a renamed or deleted feature **doc** is not a pointer
finding — it self-announces at the next touch of that feature's source, and `doctor` still warns.
And `tsconfig.json` includes only `src`, so a test that hand-builds a `ChangeState` silently rots
as the type grows: three fixtures had already drifted two fields behind before this pass found
them by runtime crash. Typechecking the tests would catch that class at the point of change.

- [x] **Step R1 — a pair git calls a rename is a MOVE only when the origin is gone.** `isRenameEntry`
      accepts `R` only (a copy is not a move, and the two listers stop disagreeing); a shared
      `movesOnly` filter drops any pair whose origin is still present in the change set; the
      deleted-pointer branch takes the same guard. Tests: copy detection on yields no pair and no
      pointer; the `git mv` + shim file split stays satisfiable and its correct end state goes
      green; probe C is unchanged.
- [x] **Step R2 — rename-awareness is a property of the change, not of one caller.**
      `fileContentTransition` takes the base-side path; `resolveFileGrainAcked`, the review ack
      card, and both `ack` surfaces resolve it through the same map; a pure move is skipped by the
      file-grain and governed wakes. Tests: the printed ack works when pasted for a renamed
      precise file; a pure rename of a coarse file and of a governed registered file fires nothing;
      a rename that also edits still wakes and is still ackable.
- [x] **Step R3 — the pointer finding reaches every surface.** A SARIF rule and results; the
      verdict model and its gloss; an HTML report card; the `--strict` epilogue names the pointer
      fix instead of offering an ack that cannot clear it. Tests: `--strict` red implies SARIF
      results present and the invocation unsuccessful; `watch` does not say CLEAN; the report card
      renders.
- [x] **Step R4 — invariants, tests, CHANGELOG.** The rename invariant restated so it is true at
      every grain with tests to match; the pointer invariant scoped to source paths with the doc
      gap named honestly; CHANGELOG; registry sync. *(The invariants landed per-step rather than
      here — the step-sync gate holds a step's docs open with it, which is the rule working: a
      step whose contract changed cannot be committed with the doc deferred to a later step. What
      remained for R4 was the CHANGELOG and the close-out.)*

Every fix was mutation-tested individually: each of the seven — the move filter, the
present-at-head guards, the base-path transition, the pure-move skip, `ack`'s map, the SARIF
projection, the verdict gloss, the report card, and the epilogue routing — was reverted in turn
and the naming test observed to fail. Three fixture files were also repaired: they build
`ChangeState` by hand and had drifted behind the type, which `npm run typecheck` cannot catch
because `tsconfig.json` includes only `src`. That gap is real and stays open, recorded below.

## Acceptance criteria

- Probe C replayed verbatim: `git mv` on a registered source is red until the registry stops
  naming the origin, with the fix printed; the end state of the field sequence (ghost pointer,
  green gate) is unreachable.
- Probe D's aftermath: `git rm` plus doc attention still leaves red until the entry drops the
  deleted path.
- `codument map materialize <new-file> --feature i18n` succeeds on a repo whose plans are all
  shipped and compacted.
- A repo with a pre-existing dangle sees review behave exactly as today (doctor still warns).
- `npm run typecheck`, `npm run build`, `npm test` green; `codument review --strict` green at
  every commit.

## Verification strategy

- Unit: lister pair extraction (porcelain and diff paths, workspace, quoting edges); finding
  predicates (base-exists × head-gone × registered × which-entry); materialize routing matrix.
- Regression: existing deletion-wake, unmapped, and drift tests pass unmodified.
- End-to-end: probes C and D scripted as fixtures, asserting the exact field transcript shape
  fails where it passed.
