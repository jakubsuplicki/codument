---
status: accepted
date: 2026-06-28
---

# 002 — doctor is documentation coverage, not a quality judge

## Context

A health command could try to grade whether docs are *good*. That is a semantic judgment Codument cannot make deterministically, and a score that pretends to make it would be untrustworthy. Test-coverage tooling solved the analogous problem by measuring a deterministic proxy (which lines ran), not test quality.

## Decision

`doctor` reports **documentation coverage**: a deterministic gap-finder, run with no network and no model, identical for the same repo state. It reports along two **separate** axes that are never merged into one number:

- a scored **coverage** axis (ownership, freshness/drift, dependency, risk) computed over an explicitly-defined denominator that excludes generated/build/test files, with one shared exclusion spec applied to both numerator and denominator;
- a **lint** axis (bloat, duplicate mappings, generated leakage) reported as counts with evidence.

The rolled score is the equal-weight average of the ratios that have a non-empty denominator (a zero-denominator ratio is excluded, never counted as 0% or 100%), and is a pure function of repo state — timestamps never feed it and the freshness window is commit-count-based, never wall-clock. `--strict` is opt-in and fails only on lint findings; informational notes never fail. The public badge is earned via a backtest against real history before exposure, and is labelled a coverage figure, not a quality or correctness score.

## Consequences

**Good:** the number is honest and reproducible; high coverage never overclaims quality, and low coverage reliably points at undocumented or stale areas.

**Bad / accepted:** "what should be documented" is a deliberate denominator choice, not a given, so the denominator spec is itself a maintained artifact.

**Rejected alternatives:** folding bloat (a lint count) into the coverage percentage; a wall-clock freshness window (gameable, non-reproducible); bundling a coverage floor into `--strict` (a gradient and a discrete finding should not share one exit code).
