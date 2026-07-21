---
status: approved
---

# Plan 26: honest scope resolution — typed unknown, complete warm, one discovery path

A field run on a real monorepo (no root repo; two nested git repos) surfaced three defects that
share one disease: **the scope codument reasons over is not the scope it verified, and every
divergence is silent**. All verified against source and reproduced live against the built 0.9.0 CLI:

1. `codument doctor` hard-crashes (`TreeSitterError: python grammar not loaded`) on any registry
   that maps a `.py` the root repo cannot see. `doctor` DOES warm (doctor.ts:183) — but
   `warmAdaptersForRepo` (fingerprint.ts:210) derives the warm set from **git's view**
   (`listTrackedFiles` + `getWorkingTreeChanges`) while `analyze` consumes **the registry's view**
   (`computeProseAltitude` → `exportedSymbolsOf` → `adapterFor(src).anchors`, analyze.ts:888–940).
   Any registry-named file invisible to root git (non-repo root, nested repo, gitignored-but-mapped)
   reaches a synchronous adapter cold. Reproduced in a *normal* flat repo with a gitignored `.py`.
2. `codument scan` never consults gitignore **in any repo**: `collectSourceFiles` (scan.ts:138–158)
   is a hand-copy of `discoverSourceFiles` (analyze.ts:154) that dropped the `isIgnored` predicate.
   Its own comment claims "shared with the analyzer so source discovery never disagrees" — false for
   gitignore, and the same false claim ships in commands.md and registry-health.md. Reproduced: a
   textbook single repo with a working `.gitignore`, scan sweeps every ignored artifact into
   `primary_sources`.
3. "Could not determine ignore rules" and "there are no ignore rules" produce the identical `[]`:
   `listIgnoredPaths` (git.ts:199) and `listTrackedFiles` (git.ts:230) both guard
   `if (!isGitRepo(root)) return []`, and `makeIgnoredPredicate([])` (analyze.ts:192) collapses to
   "nothing is ignored". On the field monorepo this inflated the coverage denominator with 378
   build artifacts and reported **100% coverage** — most confident exactly where most wrong.
   ADR-003 already states the governing rule this violates: *"'the gate could not run' is
   distinguishable from 'the gate ran and passed'."*
4. The safety net that should have caught 2 is structurally blind: `computeLint`
   (analyze.ts:472–481) never receives the `isIgnored` predicate that `analyze` computed four lines
   above (analyze.ts:361), so `generated-leakage` (analyze.ts:504) tests only the static spec.
   Nine check-ignore-confirmed artifacts in the registry: "Lint: no findings".

## Why

- The crash is a wiring bug by the codebase's own definition (the fail-loud comment at
  analyze.ts:~940 says a cold adapter is "a command-layer wiring bug — loud, never silent"). The
  root fix is to make the command layer's promise true — warm-set ⊇ consumption-set — not to
  soften the fail-loud contract that correctly exposed it.
- Unknown-read-as-empty is the exact conflation `readBlobAtRef`'s own commentary warns about
  (two-ref.ts:117). Typing the distinction at the git seam fixes doctor's lie, scan's blindness,
  and every future caller at once — a per-command patch is the "sibling caller left broken" the
  contract forbids.
- The false doc claims (commands.md, registry-health.md) become true by making the code match
  them, not by weakening the docs.

## Scope

- `src/lib/git.ts` (`listIgnoredPaths`, `listTrackedFiles` → discriminated results)
- `src/lib/fingerprint.ts` (`warmAdaptersForRepo` unions registry sources into the warm set)
- `src/lib/analyze.ts` (scope-confidence surfaced; `computeLint` gains `isIgnored`;
  `generated-leakage` covers gitignored registry sources)
- `src/commands/scan.ts` (`collectSourceFiles` deleted; discovery routes through
  `discoverSourceFiles` with the ignore predicate; unknown-scope warning)
- `src/commands/doctor.ts` (scope note, human + additive `--json` field)
- `tests/git.test.ts`, `tests/fingerprint.test.ts`, `tests/analyze.test.ts`,
  `tests/scan.test.ts`, `tests/doctor.test.ts`
- `docs/features/registry-health.md`, `docs/features/commands.md`,
  `docs/features/change-control-gate.md` (warm contract), `CHANGELOG.md`

No new source files; no `map materialize` needed.

## Non-goals

- No nested-repo discovery or aggregation — that is Plan 28; this plan makes the gap *loud*, not
  closed. On the field monorepo after this plan: doctor stops crashing, stops claiming 100%, and
  says why; scan warns instead of silently sweeping.
- No configurable exclusions — Plan 27.
- No change to `exportedSymbolsOf`'s fail-loud-on-cold contract, and no catch-and-degrade in the
  prose-altitude lint. The warm becomes complete instead.
- No `--json` version bump: the scope field is additive (the contract allows additive fields —
  plan 17 precedent).

## Decisions (settled)

- Typed unknown: `listIgnoredPaths` and `listTrackedFiles` return
  `{ ok: true; paths: string[] } | { ok: false; reason: string }` (house style: the discriminated
  shape, like `MergeResult`; never a nullable array). Each has exactly one consumer today
  (analyze.ts:361, fingerprint.ts:213), so the churn is two call sites. `ok: false` reasons:
  `"not a git repository"`, `"git failed: <detail>"`.
- Warm contract: the warm set derives from **git view ∪ registry sources** (primary + related,
  every entry). `warmAdaptersForRepo` reads the registry itself (it already takes `root`); a
  missing/unreadable registry contributes nothing (advisory listing, per its existing docblock).
  The gate path stays fail-loud on a genuinely cold adapter.
- Scope confidence surfaces as a first-class note, never a warning that fails anything:
  - `doctor` human output gains one line under the coverage block when rules were undeterminable:
    `note: not a git repository — .gitignore rules were not applied; coverage may include build
    output`. `--json` gains additive `scope: { gitIgnore: "applied" | "unavailable", reason? }`.
  - `scan` prints the equivalent warning before proposing, and its summary names it.
- `generated-leakage` keeps its lint id (SARIF/rule-id stability, plan 17 precedent). It now fires
  when a registry source is (a) statically excluded — today's behavior — or (b) git-ignored, when
  ignore rules were determinable. Evidence names which rule matched (`gitignored` vs the glob).
- `scan` discovery = `discoverSourceFiles` + `makeIgnoredPredicate(listIgnoredPaths(root))` —
  the analyzer's actual one path, making the "never disagrees" comment true. Behavior change on
  normal repos: scan stops proposing gitignored files. Stated in the CHANGELOG as a fix.
- The two doc claims are corrected in the same step that makes them true (commands.md scan
  invariant, registry-health.md shared-spec invariant, each linked to the new tests).

## Delivery Plan

- [x] Step 1: git seam — discriminated results for `listIgnoredPaths`/`listTrackedFiles`, both
      call sites updated, unit tests for repo/non-repo/git-failure returning the typed reason
      (no behavior change yet beyond types).
- [x] Step 2: warm completeness — `warmAdaptersForRepo` unions registry sources; regression test:
      a registry-mapped `.py` invisible to git (untracked + gitignored, and non-repo root) makes
      `doctor` complete without crash; a genuinely cold adapter still throws in the gate path.
      Accepted cost: `watch` re-reads the registry once per data tick (it already reads it in
      `gatherFrameData`), which stays far below the two git subprocesses the same tick spawns.
- [ ] Step 3: honest denominator — analyze threads scope confidence; doctor human note + additive
      `--json` scope field; golden tests for repo (unchanged), non-repo (note + field), git-failure.
- [ ] Step 4: one discovery path — scan routes through `discoverSourceFiles` with the ignore
      predicate + unknown-scope warning; e2e: gitignored artifacts in a real repo are not proposed;
      non-repo root proposes but warns; doc-claim corrections in commands.md/registry-health.md.
- [ ] Step 5: lint net — `computeLint` receives `isIgnored`; `generated-leakage` fires on a
      gitignored registry source with rule-named evidence; e2e on the reproduced fixture (9
      artifacts in registry → 9 findings); CHANGELOG.

## Outcome

Every consumer answers from the same verified scope or says it could not: doctor cannot crash on a
language the registry names, cannot publish a denominator it could not verify without saying so,
scan cannot propose what git ignores without warning, and a gitignored file sitting in the registry
is a named finding instead of silence. The field monorepo goes from "crash / false 100%" to
"honest report with a named limitation" — Plans 27/28 then remove the limitation.

## Acceptance criteria

The three live reproductions (gitignored-`.py` doctor crash; real-repo scan sweep; non-repo false
100%) each become a pinned regression test and pass; existing goldens change only where the plan
says (new note/field, scan's ignored-file behavior); full suite green; `codument review --strict`
green at every commit of this plan.
