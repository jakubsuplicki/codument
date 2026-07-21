---
status: approved
---

# Plan 27: configurable exclusions — an `exclude` block in `.codument-meta.json`

The field monorepo's backend compiles to `out/` (tsc `outDir`) and its frontend deploys from
`public-preprod/`. Neither is in `DEFAULT_EXCLUSION_SPEC.dirs`, neither is guessable, both are
legitimate — and there is no way to declare them. Verified against source:

1. `ExclusionSpec` is a fully-plumbed parameter with exactly one value that ever exists.
   `AnalyzeInput.exclusion?` (analyze.ts:284), `ChangeStateInput.exclusion?` (change-state.ts:31),
   and the `spec` defaults on `isExcluded`/`isSourceFile`/`discoverSourceFiles`
   (analyze.ts:120/133/154) all fall through to `DEFAULT_EXCLUSION_SPEC`; no call site in src/ or
   the 1174-test suite constructs another spec, and `readMeta` (codemod.ts:44) has no field for
   one. The threading is all there; it is never fed.
2. The "no workaround" is *enforced*, not merely absent: `adopt` rebuilds `.codument-meta.json`
   from a literal (adopt.ts:63–70), so a hand-added key is deleted on the next `codument adopt`
   (proven live). `update` mutates the read object in place (update.ts:259–262) and is safe.
3. README already instructs users to "adjust the exclusion" (~line 550) — documenting an
   affordance that does not exist.
4. De-listing swept files by hand produces the inverse failure (378 spurious `unmapped-source`
   findings), so 0.9.0 offers only a choice between two wrong states. ADR-002 anticipated this:
   *"'what should be documented' is a deliberate denominator choice… the denominator spec is
   itself a maintained artifact."* This plan gives the artifact its user-maintained half.

## Why

- Bug-report severity aside, this is the only *general* fix: gitignore aggregation (Plan 28) covers
  build output that is gitignored, but "what should be documented" is not always "what git tracks"
  — vendored code, snapshot fixtures, and generated-but-committed files are tracked and still not
  documentation targets.
- A repo-committed config block is reviewable in PRs — the same trust level as `.registry.json`
  itself — and the existing `generated-leakage` lint keeps it honest: an exclusion that hides a
  registry-owned source stays loud in `doctor` (exclusion already overrides registry contents,
  analyze.ts:22–24).

## Scope

- `src/lib/codemod.ts` (`MetaFile.exclude?` + semantic validation)
- `src/lib/state-io.ts` + `src/cli.ts` (the invalid-value error class and its rendering at the
  dispatch boundary — added in step 1 after review: the commands that read project settings include
  the ones a user would reach for to repair the file, so this error cannot end in a stack trace)
- `src/lib/analyze.ts` (`resolveExclusionSpec(root)` loader beside the default; merge)
- Thread sites: `src/commands/doctor.ts` (analyze input), `src/commands/review.ts` (:249, :752 and
  the `computeChangeState` input), `src/lib/history-audit.ts` (its `computeChangeState` input),
  `src/commands/scan.ts` (discovery — via Plan 26's shared path), `src/lib/detect.ts` (:59),
  `src/hooks/check-docs.ts` (:64)
- `src/commands/adopt.ts` (carry ALL existing meta keys forward; only overwrite the ones adopt owns)
- `src/commands/doctor.ts` + `src/commands/scan.ts` (surface active custom exclusions)
- `src/commands/watch.ts` + `src/index.ts` (added in step 2 after review: the monitor shares one
  scope read per tick and names a non-transient failure instead of freezing on a stale frame; the
  package barrel exports the resolver so a programmatic consumer is not left on the defaults)
- `tests/codemod.test.ts`, `tests/analyze.test.ts`, `tests/adopt.test.ts`, `tests/scan.test.ts`,
  `tests/doctor.test.ts`, `tests/review.test.ts`
- `README.md` (~550: document the real shape), `docs/features/registry-health.md`,
  `docs/features/commands.md`, `CHANGELOG.md`

No new source files; no `map materialize` needed. Run after Plan 26 (its scan-discovery unification
and unknown-scope note are where this config gets discovered and consumed).

## Non-goals

- No CLI flag (`--exclude`) — the spec is a repo artifact, not an invocation choice; a flag would
  let two runs disagree about scope (ADR-003's reproducibility rule).
- No configurable `extensions` — the extension list is the language matrix's truth (parity-tested,
  plan 25); letting config extend it would let the README/matrix claim support codument doesn't have.
- No negation patterns (`!re-include`) and no removal of defaults — additive only. If a default dir
  name collides with a real source dir (someone's first-party `dist/`), that is a known limitation
  carried until demanded; subtractive semantics are a different, riskier contract.
- No per-entry (registry-level) exclusion overrides.

## Decisions (settled)

- Shape: `"exclude": { "dirs": ["out", "public-preprod"], "globs": ["**/*.gen.ts"] }` — both keys
  optional, both additive-merged (set-union, deduped, sorted) into `DEFAULT_EXCLUSION_SPEC` by
  `resolveExclusionSpec(root)`.
- Validation is fail-loud, matching `readMeta`'s corrupt-file behavior: a non-array, a non-string
  element, an empty string, a `dirs` entry containing `/`, or an unknown key under `exclude` throws
  a `StateFileError`-class error naming the offending value — never silently ignored (a typo'd
  exclusion that silently no-ops would recreate this whole bug class).
- `resolveExclusionSpec` is async (rides `readMeta`), called once per command invocation at the
  entry point; the pure helpers keep their default parameters (tests and library callers
  unaffected). Every site in Scope receives the resolved spec explicitly.
- `adopt` carries forward every key of the existing meta and overwrites only
  `version`/`agents`/`project`/`lastScan`-adjacent keys it owns — the root fix for the whitelist
  deletion, so the NEXT config key added to `MetaFile` survives adopt too. Pinned by a test that
  round-trips an `exclude` block (and an unknown future key) through `adopt`.
- Visibility: when custom exclusions are active, `doctor` prints one line under coverage
  (`excluding 2 configured dir(s): out, public-preprod — .codument-meta.json`) and `--json` gains
  additive `scope.configuredExclusions`; `scan`'s summary names them. Plan 26's unknown-scope note
  gains its call-to-action here: "build output swept in? declare it in `exclude` in
  .codument-meta.json".
- Gate honesty: a config-excluded file that the registry owns keeps firing `generated-leakage`
  (existing semantics), so exclusions can silence the gate only visibly, never silently.

## Delivery Plan

- [x] Step 1: meta + loader — `MetaFile.exclude?`, semantic validation with fail-loud errors,
      `resolveExclusionSpec(root)` with merge semantics; unit tests (absent block → identical
      default spec by deep-equal; merged; every malformed shape throws with the offending value
      named).
- [x] Step 2: threading — every Scope site receives the resolved spec (doctor/review/history-audit/
      scan/detect/check-docs); e2e: with `exclude.dirs: ["out"]`, `scan` no longer proposes
      `out/**`, `doctor` drops it from the denominator, `review` drops it from other-changed noise,
      the check-docs hook stops firing on it; goldens for a repo with no config are byte-identical.
- [ ] Step 3: adopt preservation — carry-forward rebuild + round-trip test (exclude block and an
      unknown key both survive `codument adopt`); `update` preservation pinned by test (already
      safe, now guaranteed).
- [ ] Step 4: visibility + docs — doctor line + additive `--json` field, scan summary, the Plan 26
      note's call-to-action, README ~550 corrected to the real shape, registry-health.md (the
      denominator is DEFAULT ∪ config — cites ADR-002's "maintained artifact" consequence),
      commands.md, CHANGELOG.

## Outcome

The field user declares `out` and `public-preprod` once, in a file their PR reviewers can see, and
every consumer — scan, doctor, review, the hook, detection — agrees on the same scope. The next
`codument scan` cannot sweep the build output back in, and the two-wrong-states trap (false 100% vs
380 spurious findings) closes with a third option that is simply correct.

## Acceptance criteria

The field scenario as e2e: a fixture with an `out/` tsc outDir → `exclude` declared → scan/doctor/
review/hook all honor it, goldens byte-identical for unconfigured repos, adopt round-trip pinned,
full suite green, `codument review --strict` green at every commit of this plan.
