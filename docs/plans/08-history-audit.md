---
status: shipped
---

# Plan 08: `codument audit <base>..<head>` — retroactive drift audit

A zero-commitment adoption wedge: score doc drift over *committed history*, runnable on a repo
before adopting the workflow, the skills, or hand-authored registry entries.

## Why

- The two-committed-refs analysis path is already written and exported with **zero production
  callers**: `changedPathsBetween` (`src/lib/two-ref.ts:170`) and `changedAnchors`
  (`src/lib/fingerprint.ts:107`) are consumed only by re-exports and tests. The machinery for
  "what moved between v0.6.0 and v0.7.0, per symbol" exists; nothing drives it.
- Every alternative a prospect already has (CI, lint, doc generators) is forward-only; nothing can
  score historical doc drift. Today evaluating codument requires the demo fixture or a full
  install — this is the cheapest credible trial motion: `npx codument scan && npx codument audit
  v1.0.0..HEAD` on their own repo, read the damage report, then decide.
- It also gives Plan 04's deletion semantics a second consumer, and the eventual CI story a dry-run
  shape.

## Scope

- `src/commands/audit.ts` (new)
- `src/lib/history-audit.ts` (new)
- `src/cli.ts`
- `src/index.ts`
- `tests/history-audit.test.ts` (new)
- `docs/features/history-audit.md` (new)
- `docs/.registry.json`
- `src/commands/scan.ts` + `tests/scan.test.ts` + `docs/features/commands.md` (amended mid-run:
  the recipe this plan ships was blocked — `scan` refused to run without `init`, contradicting
  both this plan's "cheapest credible trial motion" premise and the README's standing claim that
  scan works standalone; minimal fix, a missing registry is created provisionally)

```feature-map
src/commands/audit.ts    | history-audit | feature | CLI: range parsing, human + --json rendering
src/lib/history-audit.ts | history-audit | feature | per-range engine over changedPathsBetween/changedAnchors/computeChangeState
```

Run `codument map materialize` for each new file. Also touches root-level `README.md` (adoption
recipe) — in-scope once Plan 04 has landed.

## Non-goals

- No gate semantics: audit is informational, exit 0 regardless of findings (`--json` carries counts
  for anyone who wants to threshold it themselves).
- No date-based ranges (`--since 90d` would put wall-clock on a deterministic surface); ranges are
  refs only.
- No registry authoring — audit reads the registry as-is (the recipe pairs it with `scan`'s
  provisional registry for unadopted repos).

## Decisions (settled)

- Shape: `codument audit <baseRef>..<headRef> [--json]`. For each registered entry, report
  per-symbol moves (and deletions, once Plan 04 lands) in its primary sources across the range
  whose owning doc did NOT change in the same range — the historical analog of the live gate.
- Determinism contract identical to review: same refs + same repo state → byte-identical output;
  no wall clock; sorted output; unevaluable files surfaced, never guessed.
- Rendering: per-entry table (symbols moved, doc last touched at ref X) + a one-line headline
  ("N of M documented features drifted in this range"); honest footer (an audit of ownership drift,
  not a quality score).
- Recommended-first-command placement: README's adoption path becomes
  `scan → audit <lastRelease>..HEAD → decide`.

## Delivery Plan

- [x] Step 1: `history-audit.ts` engine — resolve the range via the existing two-ref helpers, gather
      per-symbol anchor changes between the committed refs, join against the registry, and compute
      doc-changed-in-range per entry. Unit tests over a scripted git fixture (moved symbol + touched
      doc, moved symbol + untouched doc, deleted file, unevaluable file). Shipped shape: drives the
      SAME pure analyzer as the live gate (one drift definition, two lenses); a rename's old path
      counts as a deletion; acks deliberately do not apply retroactively; plus cosmetic-edit,
      rename, entry-removal-dodge, scan-provisional-registry, and determinism fixtures.
      Adversarial review (fable lens finders + fable 2-vote verify) confirmed 8 findings, all fixed
      at the root before Step 4 closed: (a) MAJOR fail-loud violation — a transient `git show`
      inside the re-read `changedAnchors` collapsed an added file to an empty, fresh-reading anchor
      set; fixed with a new fail-loud `changedAnchorsFromHeadContent` (reuses the already-read head
      content, `blobExistsAtRef`-guarded base, throws on a broken head read); (b) `registryAtRef`
      dropped its git-swallowing `refReachable` guard; (c) `lastTouched` moved to `rev-list`
      plumbing so `log.showSignature` can't corrupt the sha; (d) the `documented` denominator is now
      current ∪ base-only-drifted so N ≤ M; plus 4 test-coverage fixes (a ref-not-worktree pin,
      shared-file unassigned-attribution, counter assertions, and a real `scan`→`audit` e2e). The
      module comment no longer overclaims "can never disagree" — the rename-strictness departure is
      named.
- [x] Step 2: `audit` command — human rendering + exit-0 contract; register in `cli.ts`; export the
      engine from `index.ts`. E2E test on a temp repo with two tagged states. Shipped shape:
      findings never change the exit code; every could-not-run exits 1; empty head defaults to
      HEAD; `...` accepted (identical merge-base semantics); cli.ts/index.ts wiring file-acked as
      additive (dispatch-manifest / barrel contracts unchanged).
- [x] Step 3: `--json` versioned contract (mirror `doctor --json`'s version-tag discipline);
      byte-identical-across-runs test. Shipped shape: `{version: 1, audit: "ok"|"unavailable"}`
      discriminant, `driftedCount` first-class, every failure mode machine-readable under --json.
- [x] Step 4: Write `docs/features/history-audit.md` (standard layers, invariants pinned to the new
      tests), register the feature, add the README adoption recipe. Shipped shape: doc at the
      standard layers; registry entry current with depends_on; README gains the zero-commitment
      recipe section + an audit command section; overview.md lists audit. Discovered blocker fixed
      mid-run (see Scope): scan now creates a provisional registry standalone, with the
      commands.md invariant + scan test flipped to the new contract.

## Outcome

A stranger can quantify their own doc drift in two commands without adopting anything, and the
project gains a deterministic historical lens over the exact signal the live gate enforces. It does
NOT gate anything, propose fixes, or author registry entries.

## Acceptance criteria

On a fixture repo: a symbol moved in the range with an untouched owning doc is reported; the same
move with the doc touched in-range is not; output is byte-identical across runs; `scan → audit`
works on a repo with no prior codument state.

## Verification

`npm test`; `npm run typecheck`; live dogfood: `node dist/cli.js audit v0.6.0..v0.7.0` on this repo
and sanity-check the report against CHANGELOG 0.7.0.
