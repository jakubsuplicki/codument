---
title: Registry health
status: current
type: feature
owner: ""
primary_sources:
  - src/commands/doctor.ts
  - src/lib/analyze.ts
  - src/lib/badge.ts
related_sources: []
docs: []
depends_on:
  - cli
  - commands
  - lib
risk: []
last_reviewed: 2026-06-28
---

# Registry health

## In plain terms

`codument doctor` is test coverage for your docs: a deterministic gap-finder that tells you which areas are undocumented, stale, or missing dependencies, and which docs have rotted into noise. It does not judge whether the prose is good. It runs entirely locally with no network and no AI model, so the same repo state always produces the same numbers. Open it when you want a single honest signal of how well the registry and docs track the code, or a CI gate that fails when registry health regresses.

## Design approach

The whole frame is the test-coverage analogy. Coverage tooling never claims your tests are good; it reliably tells you what is *un*-tested. `doctor` makes the same trade for documentation: high coverage does not certify quality, but low coverage reliably means undocumented or stale code. That honesty is the product, so the command reports evidence ("here are the repo facts and suspicious gaps"), never a verdict ("this is safe").

Coverage and lint are two **separate** channels that are never merged into one number. Coverage is a scored ratio (registry membership and dependency declarations); lint is ESLint-style findings that flag mess (bloat, duplicate/orphaned mappings, generated leakage). Folding bloat into the coverage percent would make a single number mean two incompatible things — a gradient and a discrete count — so each keeps its own shape.

The denominator is the load-bearing design choice, because "what should be documented" is a judgment, unlike "every executable line." A naive every-file denominator turns the score into noise, so one canonical, version-controlled exclusion spec removes generated, build, and test files plus trivia, and that *same* spec is applied to both the numerator and the denominator (and shared with every other analyzer). Rejected: a per-analyzer file list, which lets coverage, lint, and the change-control gate silently disagree about what counts.

The rolled headline is the equal-weight average of the ratios that have a non-empty denominator. A ratio whose denominator is zero is excluded from the average entirely — never counted as 0% or 100%, which would lie — keeping the headline well-defined and free of NaN. The score is a pure function of repo state (filesystem plus git plus registry): no wall clock feeds it, so any time window is commit-count based, not duration based. Timestamps may stamp a trend record but never enter the number.

`--strict` is the only opt-in gate and it is deliberately narrow: it fails on actionable lint findings only, never on informational notes (silencing an awareness-only signal must never be a way to pass), and never on the coverage gradient (a coverage floor would be a separate concern). Bare `doctor` stays warning-only so the default stance is informative, not blocking.

The badge is a coverage figure, not a quality or correctness score, and absolute cross-repo comparison is not meaningful — so it must be earned by backtesting that the score moves at the right moments against real git history before it is ever exposed publicly. It renders as a hand-rolled static SVG with no network and no required dependency.

## Invariants & boundaries

- `doctor` runs with no network and no AI model, and is a pure function of repo state: identical inputs yield an identical report and score, independent of run, filesystem-traversal order, or wall clock. *(tests: `analyze.test.ts` determinism + rollup-order suites; `doctor.test.ts` "is deterministic across runs")*
- The exclusion spec is applied to both numerator and denominator: a generated or test path filters out of the in-scope set even when some registry entry lists it as a source. *(test: `analyze.test.ts` exclusion-spec and coverage-ratio suites)*
- Coverage and lint are never blended into one number; bloat and other mess stay lint findings and never move the coverage score. *(tests: `analyze.test.ts` lint and bloat suites; `doctor.test.ts` two-axis report)*
- The headline is the equal-weight average of ratios with a non-empty denominator; a zero-denominator ratio is excluded, never scored 0% or 100%, and an all-N/A repo yields a null score, not zero. *(test: `analyze.test.ts` rollup invariance and null-score cases)*
- No wall-clock value enters the score; any freshness window is commit-count based. *(honest boundary — the freshness/drift ratio is re-sourced from the change-control gate and reads N/A here until it lands; the no-`now()` rule is structural in `analyze.ts`)*
- `--strict` exits nonzero iff there is at least one actionable (warn) finding; informational notes never affect the exit code, and bare `doctor`'s output and exit code are unchanged. *(test: `doctor.test.ts` `--strict` CLI gating suite)*
- The badge renders an N/A pill when no ratio applies — never a misleading 0%. *(test: `badge.test.ts` "renders N/A (not 0%)")*
- Coverage is registry membership plus dependencies, not doc quality; the command states this in its own output so the number is never mistaken for a quality score. *(enforced by the human-output disclaimer; no semantic test)*

## Decisions

- The registry v2 model that coverage and lint read directly, with no migration path: [001-registry-v2-model-no-migration](../architecture/decisions/001-registry-v2-model-no-migration.md).
- `doctor` is documentation coverage — the two-axis split and the opt-in `--strict` gate: [002-doctor-is-documentation-coverage](../architecture/decisions/002-doctor-is-documentation-coverage.md).

## Key files

- `src/commands/doctor.ts` — the command orchestrator: assembles the two-axis report, applies the opt-in `--strict` exit policy, and renders human and `--json` output plus the on-disk coverage artifact.
- `src/lib/analyze.ts` — the deterministic analyzer: owns the canonical exclusion spec, computes the coverage ratios and their rollup, and emits the lint findings. This is the shared engine the rest of the health surface reads.
- `src/lib/badge.ts` — the rendering seam: turns a coverage percent (or N/A) into a static, network-free SVG badge.
