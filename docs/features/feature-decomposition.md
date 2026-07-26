---
title: Feature decomposition in the loop
status: current
type: feature
last_reviewed: 2026-06-28
---

# Feature decomposition in the loop

## In plain terms

A greenfield project built through the loop tends to collapse into one umbrella feature that owns all the source. At one feature every per-feature signal degrades to a single bit — blast radius is always "1 of 1", coverage is one doc — so attribution, blast, and drift cannot resolve. This feature makes the loop decompose *new* work correctly: the plan declares an approvable Feature Map, and a deterministic consumer routes each file to its owning feature as it is written, so files land decomposed instead of lumped into the umbrella.

## Design approach

The decomposition the plan already articulates in prose becomes a first-class, approvable, machine-readable artifact — and, crucially, gets a deterministic consumer the loop is **required** to run. This mirrors why step-mirroring works: a deterministic hook the skill must call, not a prose request the agent can skip. The earlier failure was exactly the prose-only path — a rule asking the agent to name a feature from a file's purpose lumped everything into the umbrella already present.

The hard line is the determinism boundary: the **agent proposes** the semantic cut (human-gated at plan approval), and the **CLI only routes** the approved Map and **flags suspicious shape**, never asserting or performing a cut. Shape signals are advisory (info), never blocking; the one blocking backstop is the existing unmapped-file finding, which catches a landed file that matches no Map row — the deterministic guard against silent lumping.

The path is forward-only: make new work decompose correctly rather than auto-healing already-lumped registries (backward-compat is not a constraint). And because every project sits at a low feature count early, a file-grain blast carrier (files touched of the in-scope total) gives real resolution before any re-mapping, so the signal is useful from the first commit. Rejected: a per-subdirectory scan as the only mechanism (it produces zero features on the flat-source shape the loop emits) and auto-heal of existing lumped registries.

## Invariants & boundaries

- The CLI never decides or performs a split; it routes a human-approved Map and flags shape only. *(test: `map.test.ts` routing; `feature-map.test.ts` parse + precedence)*
- Every decomposition shape signal is info-severity, never warn — it never blocks a clean gate, because the cut is the agent's judgment. *(test: `analyze.test.ts` shape-finding severity + the codument-registry negative fixture that proves no false-fire)*
- An unmapped in-scope landed file surfaces as the existing warn-level finding — the deterministic anti-lumping backstop; the gate is clean only at step boundaries, not mid-step while a step's later files are unrouted. *(test: `analyze.test.ts` unmapped-source; `map.test.ts` unmapped flag)*
- Routing is deterministic: an exact path beats the longest-literal-prefix glob, and an overlapping tie is a surfaced parse error, not a silent pick. *(test: `feature-map.test.ts` precedence + overlap)*
- A doc may carry more than one Map block, because a long-lived feature doc accumulates one per shipped effort. The newest block is the one routed against — an older, shipped Map must never make a file the current plan genuinely declared read as unmapped, since that reads as lumping and hard-stops the loop. *(test: `feature-map.test.ts` `parseFeatureMap across multiple map blocks`)*
- A materialized entry is born non-empty (its plain-terms layer is seeded from the Map's responsibility) and starts at review-needed status, so it does not trip maturity lints before its scaffold is filled. *(test: `map.test.ts` writer seeds the doc and sets the status)*

## Decisions

- An approvable Feature Map routed by a deterministic consumer, forward-only: [007-feature-map-approvable-decomposition](../architecture/decisions/007-feature-map-approvable-decomposition.md).

## Key files

- `src/lib/feature-map.ts` — the Map seam: parses the plan's fenced block into routed ownership with deterministic precedence and tie-detection.
- `src/commands/map.ts` — the deterministic consumer: routes a landed file to its owning feature(s) and idempotently materializes the registry entry plus a responsibility-seeded scaffold. The shape findings live in the analyzer and the file-grain blast in the verdict layer (related sources owned elsewhere).
