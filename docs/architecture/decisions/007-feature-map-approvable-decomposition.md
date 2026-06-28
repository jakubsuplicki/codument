---
status: accepted
date: 2026-06-28
---

# 007 — Decomposition is an approvable Feature Map routed by a deterministic consumer

## Context

A greenfield project built through the loop collapses into one umbrella feature owning all the source, because the prose rule asked the agent to name a feature from a file's purpose (so it lumped everything into the umbrella already present) and the only decomposition mechanism grouped by source subdirectory (so a flat-source app — the shape the loop emits — produced zero features). At one feature, every per-feature signal degrades to a single bit, so blast, drift, and coverage cannot resolve.

## Decision

The decomposition the plan already articulates in prose becomes a first-class, **approvable, machine-readable Feature Map** in the plan doc, with a **deterministic consumer the loop is required to run** — the same reason step-mirroring works (a deterministic hook the skill must call, not a prose request it can skip). The agent **proposes** the semantic cut, human-gated at plan approval; the CLI only **routes** the approved Map and **flags suspicious shape as info**, never asserting or performing a cut. An unmapped in-scope landed file is the existing warn-level finding — the deterministic anti-lumping backstop. The path is **forward-only**: new work decomposes correctly; existing lumped registries are not auto-healed (backward-compat is not a constraint). A file-grain blast carrier gives real resolution even at the low feature counts every project hits early.

## Consequences

**Good:** files land decomposed as they are written rather than lumped; the cut is explicit and approvable; signals resolve below the feature grain from day one.

**Bad / accepted:** a too-coarse Map at plan time is a human-gate dependency — the CLI can flag suspicious shape (info) but cannot assert that a cut is wrong; over-decomposition is only partially detectable and otherwise left to the concept channel and human judgment.

**Rejected alternatives:** a per-subdirectory scan as the only mechanism (zero features on a flat-source app); auto-heal / re-cut of already-lumped or imported registries; the CLI deciding or performing a split; import-graph parsing to infer dependencies (kept hand-authored, declared once in the Map).
