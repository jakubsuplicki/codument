---
status: accepted
date: 2026-06-28
---

# 003 — A deterministic, reproducible change-control gate (token-stream anchors + two-ref)

## Context

The shipped staleness signal ("a source file changed but its mapped doc did not", file-grain, with a date field) was untrustworthy at team scale: it cascaded across every owner of a shared file, and it was gameable by bumping the date or touching a blank line. A trustworthy gate has to be a pure function of repo state that a CI run and a local run agree on byte-for-byte.

## Decision

The gate is a **deterministic enforcer** — reproducible, runs in CI, free of any model on the verdict path forever. Its body signal is a token-stream hash invariant to reformatting, line endings, byte-order marks, and comment churn; it is body-inclusive, closed transitively over a symbol's same-file private helpers, with a coarse whole-file backstop for module-level state. The parser is bundled and pinned as the determinism unit; an `algoStamp` (parser version + algorithm version) invalidates all anchors on a parser bump rather than risking cross-version drift. The verdict is a pure function of `(base, head, codument version, algoStamp)`, all four printed by CI so any run is reproducible locally; no wall-clock value enters it, and the document hash strips frontmatter.

Comparison is **two-ref**: resolve a single, printed base (the merge-base; a criss-cross is tie-broken or fails loud; no common ancestor diffs against the empty tree). The gate **fails closed** on a shallow or unreachable base and **degrades to report-only** on fork PRs or read-only tokens, with CI as the authority. Evaluation is scoped to registry-owned paths, and deletions are first-class (a removed owned symbol demands reconciliation).

## Consequences

**Good:** the same inputs always produce the same verdict; refactors, reformatting, and date bumps cannot move it; "the gate could not run" is distinguishable from "the gate ran and passed".

**Bad / accepted:** a parser bump forces a clean re-baseline of all anchors; precise anchors are TypeScript-only today, with other languages on the coarse hash.

**Rejected alternatives:** a committed lockfile; per-commit LLM gating (too expensive, non-reproducible); the type-checker on the gate path (the dependency and non-determinism this design excludes); any wall-clock input.
