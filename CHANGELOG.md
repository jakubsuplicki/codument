# Changelog

All notable changes to Codument are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while it
remains pre-1.0.

## [Unreleased]

### Changed
- Documentation refinements: README and CONTRIBUTING reframed around running
  from source, with em dashes removed from user-facing copy.

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
