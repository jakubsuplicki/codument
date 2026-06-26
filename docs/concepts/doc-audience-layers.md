---
title: Doc Audience Layers
status: draft
type: concept
owner: ""
sources: []
depends_on:
  - registry-health-and-change-control
last_reviewed: 2026-06-16
---

## In plain terms

Codument docs serve two readers at once: the AI agent (which needs dense, complete, structured context) and a human (who, especially a "vibe coder," wants the big picture in plain language and the option to dig in and learn). This concept says how to serve both **without keeping two copies that drift**: keep one doc, write it in labeled layers from plain to technical to machine, and let each surface (CLI, the approval gate, Studio) show the layer that fits.

## How it works

### Principle: one source, layered by altitude, projected per audience

Do **not** split into separate human-doc and agent-doc files. Two maintained sets become two sources of truth that drift — the exact failure codument exists to prevent — and the unwritten one ends up lying to the reader. Instead, mirror the coverage analyzer's pattern (one source → human / json / badge): **one doc, multiple reading levels**, where audience is a *presentation* concern, not a storage concern.

Separation is **by section, not by file.** A feature or concept doc carries ordered layers:

```
---
frontmatter        # machine: registry, status, sources
---
# Feature Name

## In plain terms   # non-technical overview: what it does, why, what changes. No jargon.
## How it works     # technical dive-in (optional): architecture, data flow, trade-offs — the "learn it" layer
## Decisions        # the durable "why" (ADR-lite)

<!-- machine block: acceptance criteria, DoD, registry mapping -->
```

The agent reads everything (density is fine for it). A human reads "In plain terms" and expands "How it works" to learn. Studio renders the overview as a card, the technical layer behind a toggle, the machine block deeper still.

This is orthogonal to the existing feature / concept / ADR split, which is about *content type*. Audience layering applies *within* each doc.

### Floor and ceiling

- **Floor (canonical, deterministic):** the agent authors the "In plain terms" layer during `plan-with-docs`, as a near-free byproduct of writing the summary and steps. It lives in the one doc, works offline and in the plain CLI, needs no AI at render time, and is the single source.
- **Ceiling (Studio, premium):** Studio re-projects the canonical layer on demand to any reading level (a "new to this" ↔ "senior engineer" slider, diagrams, an "explain this change" button). This is a *presentation* of the canonical source, never a competing copy.

### Why it earns its place (not just more docs)

1. **Accessible approval gate.** Approval is the one human-judgment moment in the loop, yet it currently needs technical literacy. Leading the approval with the plain overview (expandable into full acceptance criteria) lets a non-expert approve meaningfully and learn by expanding.
2. **"What your agent just did, explained."** Narrating the per-step record and per-diff coverage delta in plain terms turns codument from agent memory into agent memory + a teacher — the vibe-coder learning goal, and a differentiated Studio surface.

### Risk and mitigation

A non-technical layer rots if it is a side artifact. Mitigations: make it the **front door** (read at the approval gate and in Studio, so it cannot be ignored), keep it **cheap** (authored in the same planning pass), and **drift-check it** with the same analyzer built for registry health — a durable doc missing or with a stale "In plain terms" layer is a coverage/explainability signal. Per the determinism boundary, the analyzer can check the layer *exists and is fresh*, not that it is *good*.

## Decisions

- One source layered by section; never separate per-audience files.
- Canonical plain-language layer is **agent-authored at plan time** (offline, single-source, available on the free CLI), with Studio re-projection as the premium ceiling. Rejected alternative: Studio-only AI render, which would leave the CLI and the approval gate with no plain layer — the CLI is the distribution wedge and must carry the learning value too.
- Layer headings are a convention (`## In plain terms`, `## How it works`) so renderers can locate layers deterministically.

## Hooks into the registry-health plan

- **Step 6 (templates): DONE.** The layer-heading convention is decided and applied — `## In plain terms`, `## How it works`, `## Decisions`, then a machine block. `scan`'s generated scaffold and the `templates/feature.md`/`templates/concept.md` templates now emit these layers (with v2 frontmatter) from the start. See [[registry-health-and-change-control]].
- **Post-Step 4 (analyzer):** an "explainability" coverage signal (plain layer present and fresh) is a natural future addition to the same health analyzer — not yet implemented; the analyzer can deterministically check the layer *exists and is fresh*, never that it is *good*.

## Open questions

- Final layer names and how many levels (two vs three).
- Whether the public Studio "explain" feature caches re-projections (and how those stay tied to the canonical source).
