---
status: shipped
---

# Plan 40: registration is governance — close the ungated-registered false green

The 2026-08-07 field follow-up, asked "did the gate ever pass green when it shouldn't have,"
reproduced one on a clean tree: rewrite a **registered** source-of-truth file
(`i18n/locales/en/journal.json`, registered to the app's i18n concept doc) to say
"COMPLETELY DIFFERENT CONTRACT", run `codument review --strict` — the change counts as
"0 source, 1 other", a dim grey "Registered but ungated (no adapter judges these — verify their
docs by hand)" advisory prints, and the exit code is 0. The reporter's ranking is right: "the tax
I complained about was configuration I could have fixed in one edit per file, after being told 25
times. The false green is structural." That file class was the app's entire user-visible string
surface, edited constantly through six steps, and the gate never once had an opinion.

Verified mechanism (`src/lib/change-state.ts`): `changedSources` admits only files the
source-extension spec recognizes, so a changed registered `.json`/`.css`/asset lands in
`otherChanged` and `ungatedRegistered` — deliberately info-only ("never a strict verdict input")
— and the stale-doc wake loop, which iterates `changedSources`, never sees it. Deletion has the
same blindness, since **reproduced live** (probe D): `git rm` on a registered English pack —
`primary_sources` of the i18n concept, whose own doc names raw-key rendering as an invariant —
printed "1 deleted" and exited 0, without even the "Registered but ungated" advisory, because
`ungatedRegistered` is built from the changed set and deletions skip it. The only net that
caught it in the field was a test the reporting agent had written inside the change — not the
gate. The blind spot is self-declared, which is honest; but a registration is an explicit human
claim that the file is load-bearing to a named doc, and a grey line (or nothing) under a green
exit is not a gate.

## Why

- This inverts the repo's own fail-loud law at the exact place someone declared stakes. The
  workspace false green (plan 28) was ranked "worst defect" for the same structural reason; this
  is its file-class sibling.
- The fix needs no content judgment. The gate already governs files it cannot parse — coarse TS
  classifies file-grain, ack-clearable. Registered-but-unjudgeable files deserve the same floor:
  wake the owning doc on any content move, clear by doc attention or a file-grain ack. ADR 014's
  lesson (calibrate by seeing precisely, not by ignoring) caps out here — no adapter exists, so
  coarse-and-ackable is the honest floor, not an approximation of a better option.

## Scope

- `src/lib/change-state.ts` — governed-registered set (changed + deleted), file-grain wake,
  `ungatedRegistered` narrowed to the ungoverned residue (excluded-conflict + impact-only)
- `src/commands/review.ts` — strict input, counts line, section rendering
- `src/lib/review-bundle.ts`, `src/lib/report-html.ts` — additive surfaces
- `docs/architecture/decisions/017-registration-is-governance.md` (new)
- `docs/features/change-control-gate.md`, `CHANGELOG.md`, `docs/.registry.json`
- Tests: `tests/change-state.test.ts`, `tests/review.test.ts`

## Non-goals

- **No content judgment.** No JSON key diffing, no per-key anchors. If a per-key JSON adapter is
  ever wanted, it is a language-adapter plan on the plan-18 substrate, not this one.
- **No gating of unregistered non-source files.** Exclusion and registration stay the two
  explicit intents; unregistered `.json` remains outside governance (plan 39 records the
  generated case as declared intent). Unmapped detection is untouched — a non-source file never
  becomes "unmapped".
- **No coverage/doctor change.** Coverage ratios stay defined over source files.
- **No change to per-symbol semantics anywhere.** This plan adds one file-grain wake for one
  explicitly-claimed file class; every existing wake, ack, and verdict rule is untouched, proven
  by existing tests passing unmodified.
- **No rename handling.** The lister discards rename origins today, so `git mv` on a registered
  file bypasses deletion machinery entirely — this plan's deletion parity covers `git rm`;
  rename honesty and registry-pointer integrity are plan 41's, on the same fixtures.

## Decisions (settled)

- **Registration is a governance opt-in.** A changed file that (a) appears in some entry's
  `primary_sources`, (b) has no adapter to judge it, and (c) is not excluded by the effective
  exclusion spec, joins the stale-doc wake at file grain — every primary owner (feature and
  concept) wakes, exactly like the coarse fallback for unparseable TS. Doc attention or a
  file-grain ack (`codument ack <path>`) clears it; the ack binds the content transition and
  auto-invalidates on the next edit, as everywhere.
- **`related_sources` stays impact-only.** Related never wakes (ADR 004); registering a file as
  related claims impact, not ownership. A project that wants its locale packs gated lists them as
  primary of the owning concept — one registry line, explicit.
- **Deletion parity.** A deleted registered non-source primary file wakes its owners with no ack
  fast-path, same as deleted sources (ADR 012's stance on removals).
- **`ungatedRegistered` keeps the ungoverned residue, split by why.** Two classes survive, and
  they need different words. *Excluded-but-registered*: the exclusion spec still overrides the
  registry, and the render stops saying "verify their docs by hand" — it says the registration
  and the exclusion contradict, un-map or narrow the declaration, matching the
  `ExcludedSourceError` wording that already refuses new registrations of excluded paths.
  *Impact-only*: registered solely in `related_sources`, so it never wakes by design and the
  existing "verify by hand" wording stays exactly right. The discriminator is added in step 2
  where the rendering consumes it, so step 1 changes no existing assertion's shape.
- **The change is visible in the counts, additively in the contracts.** The human counts line
  names governed non-source changes instead of burying them in "other"
  (the field paste read "0 source, 0 docs, 1 other" while the contract file changed).
  `--json`/bundle/HTML gain the governed set additively; `changedSources` keeps its meaning;
  existing machine consumers are unaffected.
- **ADR 017 records it**: registration is governance; coarse ack-clearable floor for unjudgeable
  files; related stays impact; exclusion beats registration, loudly. Supersedes the info-only
  stance recorded in the `ungatedRegistered` contract, with the field false green as the
  evidence that flipped it.

## Delivery Plan

- [x] **Step 1 — Governed wake + strict input.** The governed-registered set (changed + deleted)
      in `computeChangeState`; file-grain wake of primary owners; strict failure while the wake
      is unresolved (via the stale-doc verdict it already feeds — no new strict input);
      `ungatedRegistered` loses the governed files, keeping the ungoverned residue at its current
      shape. Tests: the field replay (rewrite a registered `.json` → exit 1; file ack clears; doc
      update clears; next edit re-wakes); related-only stays impact-only; excluded-registered
      stays advisory; deletion parity; every existing wake/ack test unmodified.
- [x] **Step 2 — Surfaces.** The `kind` discriminator (`excluded` / `impact-only`) on the
      residue; counts line, section rendering (governed named as governed, conflict as a lint),
      bundle/`--json`/HTML additive fields with tests. The two `ungatedRegistered` deepEqual
      assertions gain the additive field here — an object shape, never a verdict.
- [x] **Step 3 — ADR 017 + docs.** The ADR and the `change-control-gate.md` invariant landed in
      step 1, where the step-sync gate demanded them; this step carried the CHANGELOG entry (with
      the upgrade note for projects that registered non-source files), the README correction — it
      claimed such files were "never judged", which this plan made false — and the
      `adversarial-review-gate.md` invariant.

## Acceptance criteria

- The field replay verbatim: rewriting a registered locale file on a clean tree exits 1, names
  the file as a governed change against its owning doc, and offers the two real resolutions;
  a file-grain ack or a doc update turns it green; a subsequent edit re-wakes.
- A repo with no registered non-source files sees byte-identical behavior everywhere.
- `npm run typecheck`, `npm run build`, `npm test` green; `codument review --strict` green at
  every commit.

## Verification strategy

- Unit: the governed-set predicate matrix (registered × adapter-judged × excluded × related-only
  × deleted); wake and clearing paths; narrowed residue.
- Regression: no wake, ack, or verdict moves *outside the governed class*. Two test sites change,
  both pinning behavior this plan deliberately supersedes, and both must be rewritten to assert
  the new contract rather than deleted: `tests/review.test.ts`'s "ungated registered changes
  surface in review (info-only)" (a primary-registered `.css` whose green `--strict` IS the false
  green) and, in step 2, two `ungatedRegistered` deepEqual assertions gaining the additive `kind`
  field. Any assertion needing an edit beyond those is an unintended verdict move — stop and
  re-plan. Baseline for this repo on Windows is 33 pre-existing environment failures; the bar is
  no *new* failures, not a green suite.
- End-to-end: the reporter's A/B experiment scripted as a test fixture — unmapped new source
  still fails (A), registered rewrite now fails instead of passing (B).
