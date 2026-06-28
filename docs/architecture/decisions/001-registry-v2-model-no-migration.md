---
status: accepted
date: 2026-06-28
---

# 001 — Registry v2 model, read directly, no migration

## Context

The registry maps source to docs. The early flat shape could only say "this file is related to these docs"; it could not rank a primary owner against secondary impact, and at dogfood scale that ambiguity made ownership, drift, and review signal unreliable. Codument is pre-1.0 and effectively single-user (the author's own repos), so backwards-compatibility is not a real constraint.

## Decision

The registry entry carries primary ownership, secondary impact, durable docs, explicit dependencies, and optional risk hints. The analyzers read this shape **directly** — there is no dual-read boundary, no legacy-normalization layer, and no flat-registry path; a stray legacy field is ignored on read. There is **no migration**: adoption on an existing repo re-runs the scan/init derivation, overwriting machine-derived entries while preserving the human-authored fields (docs, dependencies, risk).

## Consequences

**Good:** one model, one read path, no compatibility tax; the cleanest shape wins because nothing depends on the old one.

**Bad / accepted:** a repo on the old shape is re-derived, not migrated, so any unsaved machine-derived intent is lost (acceptable pre-1.0).

**Rejected alternatives:** a permanent dual-read compatibility layer (two sources of truth that drift); keeping the flat ownership model alive as a permanent product constraint (the ambiguity this decision exists to remove).
