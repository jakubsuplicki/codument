---
status: accepted
date: 2026-06-28
---

# 004 — Symbol-grained, derived-first ownership with concept umbrellas

## Context

A shared file has many owners, so a file-grain gate wakes every owning doc on any edit — the cascade that trains people to ignore the signal. Dissolving it requires ownership at the symbol grain, but per-symbol ownership must not become a large hand-authored map.

## Decision

Ownership is **derived first**. A file in exactly one feature's primary sources gives that feature all of the file's exported symbols, with zero authoring (the common case). A file shared across multiple **features** carries a per-symbol owner map, seeded from the import graph harvested in the same parse, with ambiguous symbols flagged for confirmation; the gate **fails loud** on an unassigned exported symbol rather than silently waking every co-owner.

Per-symbol ownership is a **feature** concern. A concept entry (a directory-level umbrella such as `lib`) is a file-grain co-owner: it is woken whole-file by a coarse change, never fragments a feature's symbol ownership, and never counts toward unassigned/ambiguous. This was the fork that made derivation tractable: of the multi-owner files, the large majority are a single feature plus a concept umbrella (so they collapse to derived single-feature ownership), leaving only genuine multi-feature files to carry a map.

## Consequences

**Good:** the shared-file cascade dissolves — a changed symbol wakes only its owning doc; the common case needs no authoring; ambiguity fails loud instead of silently over-firing.

**Bad / accepted:** a genuine multi-feature file needs a hand-confirmed per-symbol map until import-graph seeding is fully automatic.

**Rejected alternatives:** stripping concept entries out of primary sources (orphans concept-only files); a full per-symbol split of every multi-owner file (a pile of artificial maps for what is really a feature-plus-umbrella overlap).
