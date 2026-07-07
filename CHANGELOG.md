# Changelog

All notable changes to Codument are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while it
remains pre-1.0.

## [Unreleased]

### Added
- `doctor --verify-invariants`: an opt-in mode that RUNS the test each registered
  doc's `## Invariants & boundaries` marker cites (not just checks the pointer
  exists), through the project's own hardened runner, and classifies each invariant
  as green, broken (a cited test went red), unpinned (a cited test is missing or the
  marker names no test file), unrunnable, untested, or an honest non-testable
  boundary. Broken and unpinned are warnings that `--strict` fails on, with an
  honesty ratio over the enforced share. It is off by default and environment-
  touching, so bare `doctor` (and its `--json`) stays byte-identical and
  deterministic — the invariants block appears only when the mode runs. Pair with
  `--test-command` for a non-`node:test` runner.
- `codument audit <range>`: score documentation drift retroactively across any
  commit range, before adopting the workflow. It drives the same deterministic
  change-state analyzer the live gate uses, so audit and gate cannot disagree on
  what counts as drift. Informational by contract — findings never change the exit
  code; only a could-not-run (bad range, unreachable ref, broken git) exits
  nonzero, so "could not look" never reads as "no drift". `--json` is
  version-tagged and byte-identical for the same repo state. Runs on a repo that
  adopted nothing (`codument scan && codument audit <range>`).
- `codument context`: a pull-based context pack — given a `--feature`, `--file`,
  or `--plan`, project the minimal grounded working set from the registry and
  committed docs (the owning doc's orientation and invariant lines with their test
  pointers, the primary sources to read, and one-hop dependency pointers). It adds
  no source of truth and no ranking — every field is read verbatim. `--budget`
  trims tail-first (risk → related → deps → primary), never the selected head, and
  reports every dropped tier; `--json` is version-tagged.

### Changed
- The change-control gate now splits each precise symbol anchor into a
  **signature** hash (the contract: modifiers, name, type parameters, parameter
  list, return type, overload signatures) and a **body** hash (the
  implementation). A signature move is a contract change and is ineligible for any
  acknowledgment — per-symbol or file-grain — so a changed public contract can no
  longer be laundered past the gate by an ack; the owning doc must be updated. An
  implementation-only body move keeps the cheap `codument ack` path. `review` marks
  a signature move `[signature changed]` and never prints an ack command for it,
  and the `watch` soak line splits its fire volume into `N contract · M body` so
  the calibration signal separates unavoidable contract work from the churn the ack
  path absorbs.
- Precise symbol anchors are now **canonicalized** before hashing: a name bound
  within a declaration (a parameter, a block `let`/`const`, a destructured or catch
  binding, a generic type parameter) is rewritten to a positional index, so a
  meaning-preserving local rename no longer moves the fingerprint and no longer
  needs an ack. The pass is sound — a free/imported/global reference, a type change,
  or a contract-relevant name (a property key, an object shorthand, a constructor
  parameter property) still fires — and block scoping is respected so an inner
  binding never leaks to an outer use.

### Migration
- The fingerprint algorithm version was bumped (v1 → v3) across this unreleased
  window (v2 = the signature/body split, v3 = local-identifier canonicalization),
  so upgrading crosses one fingerprint-universe shift, not two. Existing
  **per-symbol** acknowledgments recorded against a pre-v3 fingerprint
  auto-invalidate and must be re-recorded; file-grain (`ack <path>`) and
  module-residual acknowledgments are unaffected. No action is needed beyond
  re-acking any genuinely contract-neutral moves the next `review` re-flags.

## [0.7.0] - 2026-07-01

### Added
- Symbol-grained change control: the stale-doc gate now tracks the individual
  exported symbol a doc describes, not the whole file, so a one-symbol edit wakes
  only its owning doc and a shared file no longer cascades onto every doc that
  references it. The verdict is deterministic and reproducible — per-symbol
  token-stream fingerprints compared across two git refs with one pinned parser,
  derived-first ownership, a `<module>` residual backstop, and parse-error files
  gated file-grain rather than read as fresh.
- `codument ack`: record a fingerprint-bound, auto-invalidating acknowledgment
  that a change owes no doc update — `<path>::<symbol>` for a contract-neutral
  symbol move, or a bare `<path>` (file-grain) for the additive / concept / coarse
  residue a symbol ack cannot reach. A file-grain ack never masks a moved symbol,
  and over-acking stays visible in the resolution summary and the soak telemetry.
- Two adversarial gates, both human-adjudicated. The **plan adversary**: after
  grilling, an independent pass contests the written plan against its committed
  grounding (invariants, ADRs, dependency edges, risk tags, surfaced by
  `map check --plan --json`) and returns grounded objections for you to decide —
  it never blocks, and "No material objections" is the expected clean result. The
  opt-in **review gate** (`review --require-review`, with `--bundle`/`--record`):
  an independent review whose findings block a commit only when a named test,
  re-run on the spot, actually goes red — it verifies, it does not trust the
  reviewer's prose.
- `review --strict`: a step-sync gate that exits nonzero while a step left a new
  source unmapped or a mapped doc stale, so a CI step (or autopilot) can hold the
  registry and docs in sync per change.
- Catch-rate seeded-bug benchmark: `benchmark init --seeded` ships a diff with
  planted bugs over a committed baseline, and `benchmark score --mode loop|no-loop`
  scores how many the review loop catches before commit (ADR 008).
- `doctor`: an opt-in `--strict` flag, plus thin-doc and link-rot integrity checks.
- A domain-skill layer (senior backend / frontend / architect, frontend-design,
  motion-craft, code-reviewer) consulted advisorily from the intent router.
- Implementation-discipline guidance (write the least code that solves the
  problem; fix bugs at the root, not the symptom) in the agent contract.
- `plan-with-docs` prints the plan's Outcome at the approval gate.
- A Biome linter with a tuned, style-matched config, and a GitHub Actions matrix
  (lint, typecheck, build, test on Node 18 / 20 / 22).

### Changed
- The documentation standard: every doc follows fixed audience layers (In plain
  terms → Design approach → Invariants & boundaries → Decisions → Key files), a
  plan's delivery scaffolding is transient and compacts out when the work ships,
  and the features/concepts were rewritten to it (the 525-line flagship split into
  altitude docs plus ADRs).
- Freshness resolution is verdict-derived, never symbol-name or co-movement
  matching; co-movement is kept as info-only soak telemetry, never a gate input
  (ADR 010).
- `doctor` exempts depended-upon foundations from dependency coverage and the
  empty-depends-on lint, so a genuine leaf or a shared base no longer false-fires.
- README and CONTRIBUTING reframed around running from source, with em dashes
  removed from user-facing copy.

### Fixed
- `review`: closed a `<module>`-residual false-negative and hardened the gate.
- `analyze`: exclude fixture trees from source analysis.
- Test and CI determinism: force `NO_COLOR`, use `os.tmpdir()` over a hardcoded
  path, strip ANSI in render assertions, and make the benchmark NODE_OPTIONS-strip
  test robust across the Node matrix.

## [0.6.0] - 2026-06-22

### Added
- Feature decomposition: a machine-readable Feature Map block in the plan plus
  a deterministic `codument map` consumer (`route`, `check`, `materialize`), so
  a greenfield build no longer collapses into a single feature.
- `plan-with-docs` requires a Feature Map and approves the cut at the gate;
  `work-step` requires `codument map materialize` for each landed file.
- Multi-session cost capture: the feed ingests every matching transcript (with
  `feed --backfill`), a verdict-led `watch` frame, and a `codument cost`
  per-feature, per-model, per-step ledger.
- `review` records resolved findings to an impact ledger.
- A project charter gate that runs before the first grill.
- Cross-platform motion-craft skill and designer handoffs.
- `init` defaults to the Claude profile.

### Changed
- Under and over-decomposition signals are info-only with a registry
  `cohesive` mute, so the size nudge never false-fires on a clean repo.
- Autopilot shows the plan checklist inline at every step, not only at the
  approval gate.
- `watch` reports file-grain blast radius and per-file drift when a single
  feature is touched.

### Fixed
- `hooks`: read the check-docs payload from stdin and resolve the repo root
  from the file path.
- `watch`: the header shows HH:MM, repaints are skipped when the rendered
  frame is unchanged, and the working-tree scan is shared across review and the
  activity tape.

## [0.5.0] - 2026-06-18

### Added
- Change-control pivot: a v2 registry ownership model (primary, related, docs,
  depends_on, risk) with one-shot migration from the legacy registry.
- A shared deterministic analyzer for coverage and change state.
- `doctor` (documentation coverage and lint), `review` (diff safety), and
  `watch` (live view) with an events flow log.
- A shareable HTML review report.
- Click-through and live demo on a packaged fixture.
- Token-cost tracking, session feed, plan-step mirroring, and a redesigned
  live `watch`.
- Opt-in approved-plan autopilot and an assumption gate for source edits.
- Commit guidance that forbids AI co-author attribution.

### Fixed
- Documentation-coverage scope excludes gitignored files.
- The coverage percentage stays visible in the report gauge.

## [0.4.0] - 2026-05-29

### Added
- Agent-neutral delivery workflow and proof benchmarks.

## [0.3.0] - 2026-03-31

The 0.1.0 (2026-03-29) through 0.3.0 releases were the project's early
documentation-coverage CLI, before the 0.5.0 change-control pivot. Detailed
release notes were not kept at the time.
