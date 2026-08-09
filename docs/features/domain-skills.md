---
title: Domain Skills (triaged generalization, task-scoped, shipped)
status: current
---

## Summary

Codument ships seven "senior engineer" domain skills (`senior-backend`, `senior-architect`,
`senior-frontend`, `frontend-design`, `motion-craft`, `code-reviewer`, `review-codebase`) inside
the npm tarball, but they are **never installed** into a consumer repo: only the 8-item
`DELIVERY_SKILLS` loop set is copied by `init`/`update`. They are also generic standalones that
hardcode a single stack, duplicate work the loop owns, and — critically — **none carry a description
exclusion clause**, so the ones that ship can over-trigger and burn tokens on the wrong task.

This feature makes the domain skills a real, shipped layer that travels across repos, using an
**evidence-based, triaged** approach (see Generalization approach) rather than flat-broadening:

1. **Triage each skill, then apply one of three treatments** — broaden inline (judgment-dominant),
   broaden via on-demand reference files (mechanics-dominant), or keep focused (orchestrators).
2. **Rewrite every description to the precision formula** — third-person capability + a pushy
   "Use when" with concrete per-stack keywords + an explicit "Do NOT use for… (use `<sibling>`)"
   exclusion. The exclusion clause is the documented remedy for over-trigger/hijacking and is the
   primary defense against burning tokens on the wrong skill.
3. **Ship all seven to every repo** via a flat `DOMAIN_SKILLS` list plus one domain-keyed consult
   nudge. No stack detection, no install-gating, no per-repo selection.

### Why ship everything instead of gating by stack

Detection is blind exactly when it matters (a brand-new repo has no framework deps, so
`detect.ts` returns `framework: null` precisely when the charter/grill flow is most active), and
gating would withhold transferable value (`frontend-design` has worked well in a React-Native
project). Shipping all is also *cheap*: Anthropic's docs confirm only the `name`+`description`
(~100 tokens/skill) is preloaded; the `SKILL.md` body loads only on trigger and reference files
only on demand. So an unused skill costs ~one description line, and its task-scoped description +
exclusion clause keep it from firing on non-matching work. Installation is not the gate — the
`description` is. (A per-repo selection CLI + opt-in sets was considered and deferred; with
generalized, lazily-loaded skills it buys only curation, not correctness.)

### Token cost and mis-fire (the load-bearing assumption, now verified)

Ship-all is safe only if the agent is directed to the right skill and does not pay for wrong ones.
The official model makes this tractable and the research confirmed the levers:

- **Always-on cost = descriptions only**, ~100 tokens/skill (Anthropic progressive-disclosure docs).
  Seven domain skills add ~700 tokens, flat.
- **Body cost is paid only on a fire**; the one waste event is a **mis-fire**. The documented remedy
  for a skill that "triggers too often" is *make the description more specific* — i.e. add the
  exclusion clause. That is step-2 above, applied to all seven, verified by trigger evals.
- **Reference-file mechanics load only on demand**, so a Bucket-B skill stays cheap until its stack
  is actually in play.

## Generalization approach (from research)

Triage on two axes, then treat. (Sources: Anthropic Agent Skills best-practices — 500-line body
cap, ~100-token metadata, third-person descriptions, reference files one level deep; the
`cloud-deploy` Pattern 2 reference-file shape; the over-trigger "be more specific" remedy.)

- **Axis 1 — responsibility:** if the skill does several distinct jobs, keep them split regardless.
- **Axis 2 — judgment vs mechanics:** what fraction of the body is platform-neutral judgment vs
  stack-specific API?

| Bucket | Treatment | Skills |
| --- | --- | --- |
| **A — judgment-dominant** | Broaden inline; keep body short (<500 lines); fix the description (keywords + exclusion). | `code-reviewer`, `senior-architect`, `frontend-design`, `senior-backend` |
| **B — mechanics-dominant** | Judgment-first `SKILL.md` router; push per-stack mechanics into `references/<stack>.md` (one level deep, TOC if >100 lines, a "read when targeting X" pointer in the body). | `senior-frontend`, `motion-craft` |
| **C — orchestrator** | Keep focused; do not broaden or merge. | `review-codebase` |

No skill is merged or retired (zero near-duplicate candidates among the seven).

### Sibling-boundary matrix (each exclusion written once)

- `senior-backend` ⟷ `senior-architect`: backend = implement server-side logic / endpoints /
  schemas / queries / authn within a chosen design; architect = system boundaries, cross-cutting
  trade-offs, migrations, ADRs.
- `senior-backend` / `senior-architect` ⟷ `code-reviewer` / `review-codebase`: the senior-* skills
  design & build; the reviewers assess existing code.
- `senior-frontend` ⟷ `frontend-design`: senior-frontend = component structure, state, rendering
  perf, a11y (engineering); frontend-design = visual/aesthetic direction.
- `senior-frontend` / `frontend-design` ⟷ `motion-craft`: the formers = static UI; motion-craft =
  animation, gesture, motion.
- `code-reviewer` ⟷ `review-codebase`: code-reviewer = one diff/PR; review-codebase = whole project
  across features, invoked with `/review-codebase`.

### Reference-file convention (Bucket B)

`skills/<skill>/references/<stack>.md`, linked **one level deep** directly from `SKILL.md`; each
reference file >100 lines opens with a table of contents; the `SKILL.md` body lists each with a
one-line "read this when targeting <stack>" pointer. Do **not** list a stack in the `description`
unless a reference file (or inline section) actually backs it — an unbacked stack keyword causes
silent under-trigger.

## Current Decision

**Triage-then-treat (three buckets above), rewrite every description to the precision formula with a
sibling exclusion, validate triggering with evals, and ship all seven to every repo. No stack
detection, no install-gating, no per-repo selection, no merge/retire.**

- **`review-work` stays the sole in-loop reviewer.** `code-reviewer` ships for its real seat (the
  per-feature agent `review-codebase` spawns, and the only review form on the codex profile). The
  senior-* skills lose their "reviewing X code" framing.
- **Flat `DOMAIN_SKILLS`** (all seven) threaded through `installProfile`,
  `getManagedFiles`, and `benchmark-quality.ts` via one helper. **The copy must
  become whole-skill-directory recursive** (`SKILL.md` + `references/*`), not single-file. No
  `detect.ts` change.
- **One domain-keyed consult nudge** in the Intent-routing block: "consult the domain skill matching
  this step's domain." Single, conditional, info-only — no hard per-step invoke.
- **Feature doc, not ADR** (the established codument pattern).

## Non-goals

- No flat-broadening (cramming multi-stack mechanics inline); no merge or retire of any skill.
- `review-codebase` is explicitly out of scope for generalization (orchestrator, single job).
- No stack detection, install-gating, or per-repo selection CLI (deferred future feature).
- No new CLI command, flag, or approval gate; no runtime skill dispatcher.
- No new source *files* — only edits to existing `src/lib` + `src/commands`, plus skill markdown
  (SKILL.md + new `references/*.md` assets).

## Decisions

- **Skills are triaged, not flat-broadened.** A judgment-dominant skill broadens inline
  and reads correctly for any stack; a mechanics-dominant one becomes a judgment-first
  router whose per-stack detail loads on demand. Broadening everything inline was the
  alternative, and it dilutes exactly the load-bearing detail that made the skill worth
  having.
- **Every description carries an exclusion clause.** Firing is the host matcher's
  decision and nothing forces it, so the lever is a description tight enough that the
  matching skill fires and its siblings stay silent. Closing the skipped gap without
  that clause would have traded no invocations for over-triggering.
- **A stack is named only where reference content backs it.** `senior-frontend` claims
  React web and React Native because both have authored references; Vue, Svelte and
  SwiftUI are not named until they do. A description that claims an unbacked stack is a
  promise the skill cannot keep at the moment it fires.
- **`review-work` remains the only in-loop reviewer.** Domain skills inform an
  implementation or a review and never replace a gate — the shadow-review framing they
  once carried put two reviewers in one loop.
- **Skills install as directories, not files.** The copy is recursive across the whole
  skill directory, because a router whose references do not ship is a skill that reads
  as broken at exactly the moment its detail is needed.

## Known limitations

- Firing is not deterministic: descriptions, exclusions and the nudge bias the host's
  selection, and nothing forces a skill to run.
- Skills are not curated per repository — a backend repo carries the UI skills on disk,
  lazily, with only the description ever in context.
