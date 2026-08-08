---
title: Project Charter Gate
status: current
type: feature
last_reviewed: 2026-08-08
---

# Project Charter Gate

## In plain terms

Before the first real piece of building work on a project that has no charter, the agent settles
what kind of project this is — a throwaway demo or something meant to ship and be maintained — and
what its core technical shape is. The answers land in a durable `docs/charter.md`, with a two-line
summary mirrored into `docs/overview.md`, which every later grill already loads. From then on the
loop drills in proportion: a serious project gets serious grilling for free, a demo stays light.

Without it, the only questions a user ever hears come from the per-change grill, which is reactive
by design — it surfaces one load-bearing assumption at a time and never asks what the project *is*.
So the architecture, datastore and auth decisions get made implicitly and late, and nobody learns
why.

## Design approach

The gate is conducted by the agent in chat, not by the CLI. A CLI cannot grill: it cannot read how
fluent an answer sounds, cannot follow up, and cannot tell real-work intent from a passing question.
So the whole interview lives in a skill and one routing bullet in the generated instruction contract;
the CLI's only jobs are installing the skill and holding an at-a-glance marker in
`.codument-meta.json`. There is deliberately no `codument charter` command.

Two things decide when it fires, and both are judgment calls rather than string matches: no charter
exists, and the user's message is real-work intent. A pure question on an uncharted project is
answered, and the gate waits for the first turn that actually builds something.

The seriousness question sets *depth*, never *which questions get asked*. Both paths walk the same
core ground — architecture, datastore, auth, hosting — because the point is that the user comes out
understanding the decisions. The demo path pre-picks a sensible default per choice so it can be
accepted fast and skips research and ADRs; the serious path drills, researches what is genuinely
uncertain, and records ADRs. Experience is never asked and never branched on: it is inferred live
from how someone answers, and it tunes verbosity only.

The one place the interview does not happen at all is a project that has already answered these
questions in code. There the charter is **derived and confirmed** rather than asked, in a single
message with each line carrying its evidence.

## Invariants & boundaries

- **The gate never asks the user's experience level, and never branches on it.** Everyone gets the
  same questions; only the agent's verbosity adapts, inferred live from how they answer. Branching on
  experience would gate a non-technical user out of exactly the decisions they most need to
  understand, which inverts the point of the feature. *(untested — skill prose; enforced by review)*
- **Seriousness sets depth, never the question set.** Demo and serious both cover architecture,
  datastore, auth and hosting; demo pre-picks a default per choice and skips research and ADRs, while
  serious drills, researches genuine uncertainty, and writes an ADR per real decision. A demo user
  who accepts every default has still been shown every decision and its trade-off.
  *(untested — skill prose)*
- **Every recommendation carries its meaning and its trade-off.** A concrete pick, one plain-language
  line saying what it *is*, and the key trade-off against the main alternative. The response-altitude
  rule in the same generated contract governs how LONG each of those is, never whether it ships:
  compressing the teaching away would defeat the gate, so all three parts survive on every tech
  question. *(untested — skill prose; the format is pinned in the skill, not in code)*
- **A project that has already decided in code is not interviewed through those decisions.** Where
  there is substantial working code, the stack is derived from it — registry, overview, dependency
  manifest, config and infra files — and presented as one confirm-once message with each line's
  evidence in plain words, seriousness included and defaulting to serious for something already
  shipping. Only a dimension the code genuinely cannot answer earns a question. This is not politeness
  about ceremony: an answer that contradicts the code is either silently discarded or an accidental
  migration decision nobody scoped, so asking at all creates a failure mode that not asking does not
  have. *(untested — skill prose; the managed-section clause is pinned by `scaffold.test.ts`)*
- **The charter describes what is true, so a correction is a migration.** When a user contradicts a
  derived line, that is a decision about the future and it goes through the normal grill/plan loop as
  its own work — the charter still records what the code does today. A charter claiming what the code
  does not do is worse than having none, because every later grill loads it and inherits the false
  premise. Derived lines record that provenance so a later grill knows nobody argued for them, and
  they get no ADRs: an ADR restating the status quo is bloat that dilutes the ones carrying a real
  argument. *(untested — skill prose)*
- **The gate fires once and then gets out of the way.** A charter that exists is read, never
  re-interviewed, and the gate is not a replacement for per-change grilling — it runs before that
  loop and biases it, leaving its mechanics untouched. *(test: `scaffold.test.ts` "buildManagedSection"
  — the routing bullet, and its position ahead of the assumption gate)*
- **The routing contract is generated from one place.** The charter bullet is emitted by
  `buildManagedSection()`, the single source of the managed block written into `AGENTS.md` and
  `CLAUDE.md`, so every project inherits it on `codument update` and the Claude wrapper cannot drift
  from the neutral one. *(test: `scaffold.test.ts` — bullet presence, the brownfield clause, and
  ordering)*

## Decisions

- Agent-driven with no new CLI command: the user's flow is install → `codument init` → start
  chatting, and the interview belongs where grilling can actually happen. Rejected: a `codument
  charter` command; firing on the first message of any kind (too pushy on a plain question); an
  opt-in "want to set up a charter?" prompt (softens the gate into a suggestion).
- Seriousness as the only lead axis. Rejected: a two-axis tier plus an experience gate — it read as
  demeaning and capped exactly the users the teaching is for.
- The charter lives in `docs/charter.md` with a two-line mirror in `docs/overview.md`, because
  `grill-with-docs` already loads the overview first — which is what makes every later grill drill
  proportionally at no extra cost. Real architecture decisions additionally get ADRs. Rejected:
  ADRs-only, since seriousness fits that format awkwardly.
- Derive-and-confirm on a project with working code, rather than interview. Recorded from a field
  report where the gate walked a months-old app through datastore, auth and hosting it had settled
  long before; plan 35's `init`-scans-existing-code made this the *common* adoption shape rather than
  an edge case, since a mature uncharted project now arrives with a populated registry.

## Key files

- `skills/establish-charter/SKILL.md` — the interview itself: when it fires, the seriousness
  question, the recommendation format, the two depth paths, and the brownfield derive-and-confirm
  path. The behavior is prose-governed on purpose; a skill is what the agent reads.
- `templates/charter.md` — the durable shape the charter is written into.
- `src/lib/scaffold.ts` — `buildManagedSection()`, where the routing bullet that fires the gate is
  generated (it also carries the quality bar and the documentation-altitude standard, which are
  change-control concerns — see [[change-control-gate]]).
- `src/lib/agent-profiles.ts` — the delivery-skill list that gets the skill installed for every
  profile.
