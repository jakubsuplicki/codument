---
title: Documentation standard
status: current
type: concept
last_reviewed: 2026-06-28
---

# Documentation standard

## In plain terms

A codument doc is the agent's map of one feature: open it and learn what the feature is, why it is built this way, what must never break, and which file to open first, without reading the code. The same doc serves the human at the loop's gates (plan approval, decisions, review). Mechanics (identifiers, signatures, call order, counts) are deliberately absent: the agent greps those live from the code, where they cannot drift. This concept defines the fixed shape every feature and concept doc follows, so the knowledge stays lean, trustworthy, and self-maintaining.

## Design approach

The standard is one rule, and a structure that follows from it.

**The rule:** a doc keeps only what survives a behaviour-preserving refactor that renames every symbol and reorders every line. That durable residue is intent, design rationale, invariants, decisions, and the role each file plays. Everything a refactor would change is *mechanism*, and it lives in the code where the agent reads it. Everything that is a *plan* (checklists, acceptance criteria, verification steps) is transient, and it lives in the increment, compacting out on ship.

The rule comes from how the agent actually works and from the two ways docs rot. The agent greps mechanics live and trusts the doc only for *meaning*; a doc it cannot trust it routes around, re-deriving from code, so trust is the whole game. Docs lose trust two ways: they go **stale** (they restated mechanics the code then changed) or they go **bloated** (delivery scaffolding piled up and buried the signal). The rule forbids both at the source.

**The structure.** Each section answers a question the agent cannot answer by reading code:

- **In plain terms** — what is this, and do I care for my task
- **Design approach** — why this shape, and what was rejected (at role level)
- **Invariants & boundaries** — what must hold or is forbidden, each linked to its enforcing test
- **Decisions** — pointers to the ADRs that hold the durable why
- **Key files** — the narrative role of each file (orchestrator / analyzer / seam)
- **frontmatter** — prose-side identity only: title, status, type, last-reviewed. Ownership, dependencies, and risk live solely in the registry (ADR 001); a frontmatter copy of them is a second, unvalidated source of truth that only drifts

## Invariants & boundaries

- A doc never carries mechanism: no identifier, literal count or duration, ordered call sequence, or line-number anchor. Role-level flow narrative ("the request reaches the analyzer, the orchestrator fans out, results merge") is allowed because it survives a rename. *(enforced by review and agent discipline, plus the deterministic prose-altitude lint in [[registry-health]] — its `line-anchor` and `symbol-mirror` smells are the machine reading of this invariant, info-only in doctor's Notes, never a `--strict` fail)*
- The registry is the single source for which files a feature owns; prose never restates the file list. Key files carries role, not paths. *(tests: ownership.test.ts and change-state.test.ts — ownership resolves from the registry, not from prose; the `path-enumeration` smell of the prose-altitude lint in [[registry-health]] is the info-only reading of "prose never restates the file list")*
- The gate proves a documented symbol **moved**, never that surviving prose is **true**. Structural freshness is automatic; semantic truth is the agent's job at each flagged move, and a test-backed invariant is the only self-verifying claim. *(honest boundary, not a guarantee)*
- The plan is never the durable doc, and a superseded decision is preserved as an ADR, never deleted. *(the immutable decision chain is what makes the why trustworthy)*

## Decisions

- One source, layered by section — never separate per-audience files. Two maintained sets become two sources of truth that drift, the exact failure codument exists to prevent.
- The technical layer is named **Design approach**, not "How it works", so the heading stops inviting a code walkthrough.
- **Invariants & boundaries** is a required section that carries test pointers. It is the highest-value content for agent certainty, and a test pointer is how a semantic claim becomes self-verifying. `doctor --verify-invariants` makes that concrete: it runs the cited test (not just checks the pointer exists), so a rotted, red, or unpinned invariant is a named finding rather than silent decoration.
- Decisions route to ADRs by default; the doc references them and never restates them.
- Mechanism is excluded from prose and read live from the code; codument ships no generated reference layer. Rejected: a stored, generated symbol catalogue — it is a snapshot that goes stale, and an agent can already read the source instantly, so the registry (which files) plus live reads (what they contain) cover it without a drifting artifact.
- **The standard has a deterministic reading, shipped info-only.** The prose-altitude lint (see [[registry-health]]) scores every registered doc for three named smells — `symbol-mirror`, `line-anchor`, `path-enumeration` — with no NLP and no model call. It renders in doctor's Notes channel and never fails `--strict`; promotion of any one id to a warning is a separate decision gated on that id's own false-fire soak, exactly like the change-control gate's info→blocking flip and co-movement's info-only stance ([005](../architecture/decisions/005-co-movement-info-only-telemetry.md)). **Initial soak baseline (this repo, at ship):** `line-anchor` is high-precision — every fire was a real rotting anchor (all fixed in the dogfood pass), and it is scoped to known source/doc extensions so a `host:port` URL never false-fires; `symbol-mirror` over-fires whenever an exported name is a common English word at sentence start — a command name that is also an exported function ("init writes the scaffold"), or a noun-subject like `State`/`Config` ("State transitions must remain atomic") — a class a lexical verb heuristic structurally cannot separate without NLP, so its fires are mostly false and it is the least ready to promote; `path-enumeration` is mixed — it correctly flags a prose section that restates the file list, but also fires on transient delivery-plan / impact sections that legitimately enumerate their scope. Promotion criterion: an id becomes a warn only once its false-fire share over accumulated doctor runs is low enough that the warn is actionable, not noise.

## Key files

This concept is propagated, not implemented in one place: the feature and concept templates are the skeleton agents fill to it, the scaffold's managed contract section is inherited by every install, and the `scan` / `map` generators emit it. The registry holds the authoritative paths.
