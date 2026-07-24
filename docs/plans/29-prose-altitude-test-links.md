---
status: shipped
---

# Plan 29: prose-altitude calibration — stop penalizing required test links

The `path-enumeration` note fires on docs that comply with the documentation standard. Verified
against source:

1. The standard *requires* each invariant to link the test that enforces it ("link each invariant
   to the test that enforces it, or mark it 'untested'" — AGENTS.md doc-altitude section, the
   update-docs skill, and the feature template all say so).
2. `SOURCE_PATH` (prose-altitude.ts:60) matches ANY `src/**` path — including
   `src/services/applicant.service.spec.ts` and `src/services/__tests__/*.test.ts` — so the
   required test links in an "Invariants & boundaries" section count toward the enumeration smell.
3. The count is per-mention, not per-file (`sectionPaths += paths.length`, prose-altitude.ts:163):
   three invariants pinned by one spec file count as 3.
4. Net effect, observed in the field: a doc linking all five of its invariant-enforcing tests is
   flagged, while a doc linking none would score clean — the note inverts the exact incentive the
   standard exists to create.
5. **The sharpest evidence, from a second field pass: the finding count went 1 → 3 across a single
   documentation-improvement pass, and every newly-flagged path was a test file.** The count did not
   rise because the docs got worse. It rose because they got better — invariants gained the test
   links the standard demands. A metric that climbs as a project complies with the standard is not
   a weak heuristic, it is a backwards one, and it will train agents and humans alike to strip test
   links to quiet `doctor`.

## Why

- An info-note that penalizes compliance trains agents and users to route around the standard
  (drop the test links to quiet doctor) — the precise failure mode ADR-002's "honest signal"
  framing and the doc-audience-layers concept exist to prevent.
- The definition of "a test file" already exists in the same codebase — the exclusion spec's test
  globs (`**/*.test.*`, `**/*.spec.*`, `__tests__`) — so the fix reuses the one spec instead of
  inventing a second convention (and automatically honors user-configured globs once Plan 27's
  resolved spec lands).

## Scope

- `src/lib/prose-altitude.ts` (unique-path counting; test-path exemption via an injected predicate
  — the module stays pure, no spec import; the path matcher also captures multi-dot filenames whole,
  a latent defect the work surfaced: `x.service.ts` and `x.service.spec.ts` truncated to one string)
- `src/lib/exclusion-spec.ts` (`TEST_CONVENTIONS` extracted as the ONE definition of "a test file",
  with the spec composed from it rather than repeating it)
- `src/lib/analyze.ts` (`computeProseAltitude` threads a test-path predicate derived from the
  exclusion spec's globs + `__tests__`/test dirs)
- `tests/prose-altitude.test.ts`, `tests/analyze.test.ts`
- `docs/features/registry-health.md` (the note's contract line), `CHANGELOG.md`

No new source files; no `map materialize` needed. Independent — can run before or after 26–28
(with Plan 27 shipped it rides the resolved spec automatically; before it, the default globs).

## Non-goals

- No change to `line-anchor`: a `foo.spec.ts:42` anchor still fires — the standard says cite the
  test, not the line, and line numbers rot regardless of what file they point into.
- No change to `symbol-mirror`, to the `DEFAULT_MAX_PATHS = 4` threshold, or to the Key-files
  role-text check.
- No allowlist beyond test conventions (e.g. exempting all paths inside "Invariants & boundaries"
  wholesale would let genuine file enumeration hide in that section).

## Decisions (settled)

- Test-convention paths are exempt from the `path-enumeration` COUNT everywhere in prose (not just
  in the invariants section — a test path is a legitimate citation anywhere, and section-scoped
  exemptions invite heading games). They remain visible to `line-anchor` when written with `:NNN`.
- The predicate derives from the same glob semantics the exclusion spec uses (`isExcluded`'s
  matcher over the spec's test globs plus the `__tests__` dir convention) — one definition of "a
  test file", never a fifth copy; threaded into `analyzeProseAltitude` via `ProseAltitudeOptions`
  so the lib stays pure and separately testable.
- Distinct paths, counted once: a section's count is `|unique non-test source paths|`. Three
  mentions of one spec file were 3 before and are 0 after (test + dedup); three mentions of one
  non-test file are 1 after (dedup) — both calibrations pinned by tests.
- The existing finding message keeps its shape; the count it reports becomes the deduped, test-
  exempt count.

## Delivery Plan

- [x] Step 1: prose-altitude — `ProseAltitudeOptions.isTestPath?` + unique-path counting; unit
      tests: the field doc shape (5 test-path mentions, 3 of one file) yields no finding; 5 unique
      non-test paths still fires; 5 mentions of 2 non-test files does not; mixed sections count
      only the non-test residue.
- [x] Step 2: threading + docs — `computeProseAltitude` builds the predicate from the exclusion
      spec; e2e through `doctor` on a fixture doc with invariant→test links (clean) vs a genuine
      file-list section (fires); registry-health.md contract line + CHANGELOG.

## Outcome

A doc that does exactly what the standard demands — every invariant pinned to its enforcing test —
scores clean, and the note keeps firing on what it was built for: prose that restates the file
list. The incentive points the right way again.

## Acceptance criteria

The field example (5 test-link mentions across 3 files) produces zero `path-enumeration` findings;
genuine enumeration still fires at the same threshold; full suite green; `codument review --strict`
green at every commit of this plan.
