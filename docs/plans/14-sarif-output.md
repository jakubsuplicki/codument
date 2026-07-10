---
status: shipped
---

# Plan 14: `review --format sarif` — findings as PR annotations, no bot

A pure output formatter that lets `review --strict --base origin/main` findings appear inline on PR
files through infrastructure users already run (GitHub code-scanning upload or reviewdog) — zero
hosted components, fully consistent with the local/no-network core.

## Why

- The parked PR-bot (roadmap #3) was a *service*; this is not that. SARIF is a static file the
  existing CI step uploads; codument stays a CLI that reads the repo and reports facts.
- This is where the wedge against plain CI is sharpest: CI can fail a job, but it cannot say "this
  doc went stale because THIS symbol moved" on the diff line. It also makes the versioned JSON
  contract earn distribution instead of sitting unconsumed, and it is the natural delivery vehicle
  for the eventually-planned CI required-check story.

## Scope

- `src/lib/sarif.ts` (new)
- `src/commands/review.ts`
- `src/cli.ts`
- `tests/sarif.test.ts` (new)
- `docs/features/change-control-gate.md`
- `docs/.registry.json`

```feature-map
src/lib/sarif.ts | change-control-gate | feature | pure ReviewReport -> SARIF 2.1.0 mapper; no I/O
```

Run `codument map materialize src/lib/sarif.ts`. Execute AFTER Plan 03 (depends on the non-git JSON
discriminant so the SARIF path has a defined failure shape). Also touches root-level `README.md`
(CI recipe) — in-scope once Plan 04 has landed.

## Non-goals

- Only SARIF 2.1.0 in this plan — no GitHub workflow-command or reviewdog-native formats (SARIF
  upload already yields annotations; add other formats only if demand shows up).
- No GitHub Action shipped from this repo; the README documents the two-step recipe using
  `github/codeql-action/upload-sarif`.
- No new findings — a lossless re-projection of what review already reports.

## Decisions (settled)

- Mapping: each staleDoc → one result anchored at the owning doc file (level: warning) with related
  locations at the moved symbols' files/lines (the ts-adapter spans carry positions; where only
  file-grain is known, anchor at line 1); each unmapped source, out-of-plan file, and ownershipLint
  → results at their files; drift findings carry the anchor id and from→to in the message. Rule ids
  are stable (`codument/stale-doc`, `codument/unmapped`, …) with helpUris into the docs.
- Determinism: byte-identical SARIF for identical repo state (sorted results, no timestamps —
  SARIF's optional invocation times are omitted, consistent with the no-wall-clock contract).
- Exit-code contract unchanged: `--format sarif` only changes stdout; combine with `--strict` for
  the failing check. Non-git/gate-unavailable (Plan 03's discriminant) → a SARIF `toolExecutionNotifications`
  error entry and exit 1 under `--strict`.

## Delivery Plan

- [x] Step 1: `sarif.ts` pure mapper with a golden-fixture test (a ReviewReport with every finding
      kind → checked-in SARIF fixture, byte-compared).
- [x] Step 2: `--format sarif` flag on `review` (mutually exclusive with `--json`); e2e test in a
      scripted repo; determinism test.
- [x] Step 3: Validate the output against the SARIF 2.1.0 schema in a test (vendored schema file, no
      network). Dep-free: a small Draft-07-subset validator over the vendored schema (no ajv), with a
      teeth test proving it rejects an unknown property and a bad enum.
- [x] Step 4: README CI section: the two-line Actions recipe (run review, upload SARIF); doc + CHANGELOG.

## Outcome

A team gets per-line "this doc went stale because this symbol moved" annotations on every PR with
two lines of CI config and no new services. It does NOT add checks, gates, or network calls — same
facts, one more shape.

## Acceptance criteria

Golden fixture covers stale-doc/unmapped/out-of-plan/ownership-lint/drift; output validates against
the schema; byte-identical across runs; uploading the fixture to a scratch GitHub repo renders
annotations (manual, once).

## Verification

`npm test`; `npm run typecheck`; live: generate SARIF on this repo with a staged change and eyeball
the result structure.
