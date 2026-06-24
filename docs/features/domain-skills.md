---
title: Domain Skills (triaged generalization, task-scoped, shipped)
status: approved
last_updated: 2026-06-24
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
- **Flat `DOMAIN_SKILLS`** (all seven) threaded through `installProfile` (`init.ts:140`),
  `getManagedFiles` (`update.ts:56`), and `benchmark-quality.ts:205` via one helper. **The copy must
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

## Delivery Plan

Status: approved (2026-06-24). Implementing via autopilot.

- [ ] Step 1 (Bucket A descriptions + cleanup): Rewrite the descriptions of `senior-backend`,
      `senior-architect`, `frontend-design`, `code-reviewer` to the formula (third-person capability
      + pushy "Use when" + per-stack keywords + the matrix exclusion clause); remove the
      "reviewing X code" shadow-review framing but **keep** the registry Definition-of-Done line
      (research rubric: a skill that can fire standalone must carry it); keep bodies inline and
      under 500 lines. (`senior-backend` keeps its light stack tokens inline.)
- [ ] Step 2 (Bucket B — `motion-craft` refactor, the template): Split the stack-specific sections
      (web impl, native impl, setup, examples, bridges) into `references/web.md`,
      `references/react-native.md`, `references/examples.md`, `references/bridges.md` (each with a
      TOC + a body pointer); keep the shared core + translation table + review format in `SKILL.md`
      (target ~250 lines). This becomes the canonical Bucket-B shape.
- [ ] Step 3 (Bucket B — `senior-frontend` router): Extract platform-neutral frontend judgment
      (component sizing, state-decision order, "measure before memo", a11y, error/loading pairing,
      the `motion-craft` delegation) into a judgment-first `SKILL.md`; move the existing
      React/Next/Tailwind specifics verbatim into `references/react.md` (React **web**); **author a
      focused `references/react-native.md`** covering the RN divergences (StyleSheet/NativeWind, list
      virtualization, navigation, Hermes/perf, platform + a11y APIs) — RN *motion* still defers to
      `motion-craft`. Description names React web + React Native (both backed) with exclusions
      against `frontend-design` and `motion-craft`.
- [ ] Step 4 (Bucket C — `review-codebase`): Sharpen only the description boundary (single diff →
      `code-reviewer`; whole project → here, `/review-codebase`). No structural change.
- [ ] Step 5 (rubric + structure validation, all seven): Verify each against the rubric — body
      <500 lines, references one level deep, TOC on >100-line references, forward-slash paths, the
      registry Definition-of-Done line preserved, exclusion clauses present and non-circular per the
      matrix, and every description stack-keyword backed by real content.
- [ ] Step 6 (trigger evals, all touched skills): For each, run ≥3 should-trigger prompts (one per
      claimed stack/scenario) and ≥3 should-NOT-trigger look-alike prompts that must route to a
      sibling; keep a broadened description only if it triggers on the first set and stays silent on
      the second.
- [ ] Step 7 (source — install pipeline): Add a flat `DOMAIN_SKILLS` list (all seven) to
      `agent-profiles.ts` and a single `resolveSkills(profile)` helper; **change the install/update
      copy from single `SKILL.md` to recursive whole-skill-directory** (SKILL.md + `references/*`)
      for both `installProfile` (`init.ts`) and `getManagedFiles` (`update.ts`), and
      `benchmark-quality.ts`; fix the `init.ts:150-152` count log. No `detect.ts` change.
- [ ] Step 8 (source — nudge): Add one conditional, domain-keyed consult bullet to the Intent-routing
      block in `scaffold.ts` `buildManagedSection()` (re-emitted to AGENTS.md + CLAUDE.md).
- [ ] Step 9 (docs/registry): Register the domain skills + their `references/*` under a
      `domain-skills` entry; bump `last_updated` on the features owning the modified source files.

## Feature Map

No new **source files** (Steps 7–8 extend existing registered files). New `references/*.md` are skill
markdown assets, registered via the `domain-skills` entry in Step 9. No `feature-map` block required.

## Outcome

What is true once all nine steps land:

- **Distribution fixed.** Today zero domain skills reach a consumer repo; after, all seven (with
  their reference files) install into every repo, both profiles, on `init`/`update`. The recursive
  copy means Bucket-B reference files actually ship.
- **Portable, the right way.** Judgment-dominant skills broaden inline and read correctly for any
  stack; mechanics-dominant skills become judgment-first routers whose per-stack detail loads on
  demand — no skill exceeds the 500-line budget or dilutes its load-bearing detail. `motion-craft`
  drops from 430 to ~250 lines.
- **Fires where relevant, and only there.** Every description gains an exclusion clause, so the
  matching skill fires and siblings stay silent — closing both the "skipped" gap (0 invocations in
  31 past sessions) and the over-trigger/token-burn risk, validated by trigger evals before ship.
- **Loop conflicts gone.** `review-work` stays sole reviewer; `senior-architect` feeds grill/charter
  instead of competing; "reviewing X code" framing removed (registry DoD line kept); the transform/opacity
  rule lives only in `motion-craft`.
- **codument's own repo.** Stops carrying frontend skills scoped to a frontend-less CLI; gets the
  base skills, generalized.

Where it lands: every consumer repo that runs `init`/`update` (both profiles), and codument's own
repo. No user-facing CLI or workflow change.

What it deliberately does NOT do:

- **Not deterministic firing.** The host's matcher still chooses; tight descriptions + exclusions +
  the nudge bias selection, evals confirm it, but nothing forces a fire.
- **Not curated per repo.** A backend repo carries the UI skills on disk (lazy; only the description
  is ever in context). The `codument skills` selection layer is a deferred future feature.
- **No new domain skills**, and **frontend reference content is React web + React Native only** —
  Vue / Svelte / SwiftUI deferred until authored (we will not claim unbacked stacks).

## Registry impact

New `domain-skills` entry → `docs/features/domain-skills.md`; `docs:` = the seven `skills/*/SKILL.md`
plus any new `skills/*/references/*.md`; `related_sources` = `src/lib/agent-profiles.ts`,
`src/lib/scaffold.ts`, `src/commands/init.ts`, `src/commands/update.ts`,
`src/lib/benchmark-quality.ts`; `depends_on` = `agent-delivery-workflow`. Bump `last_updated` on
features owning the touched source files.

## Acceptance criteria

- After `codument init`/`update` in any repo, all seven domain skills **and their reference files**
  are installed for every resolved profile (verifies the recursive copy).
- Each skill follows its bucket: A/C bodies <500 lines inline; B skills are judgment-first routers
  with per-stack mechanics in `references/<stack>.md` one level deep (TOC if >100 lines); no body
  exceeds 500 lines (`motion-craft` ~250).
- Every description is third-person, leads with capability, has a pushy "Use when" with concrete
  keywords, and an exclusion clause consistent with the sibling matrix (non-circular); no stack
  keyword lacks backing content.
- Trigger evals pass: each touched skill fires on its should-trigger prompts and stays silent on the
  should-NOT-trigger look-alikes.
- No "reviewing X code" shadow-review framing, and the registry Definition-of-Done line preserved in
  every skill; `review-work` remains the only
  in-loop reviewer; the transform/opacity rule lives only in `motion-craft`.
- Exactly one info-only domain-consult bullet in the Intent-routing block; no new CLI / approval gate
  / `detect.ts` gating. `codument doctor` clean; `domain-skills` registered with `last_updated` set;
  existing tests pass plus a new install test asserting the directory (SKILL.md + references) lands.

## Verification strategy

- Steps 1–4 (content): re-read each skill against the rubric (bucket fit, description formula +
  exclusion, body structure). `codument doctor` clean.
- Step 5 (structure): mechanical checks — `wc -l SKILL.md` < 500 each; references one level deep;
  TOC on >100-line references; forward-slash paths; DoD line preserved; exclusion matrix consistent.
- Step 6 (evals): the should-trigger / should-NOT-trigger prompt sets above, per claimed stack.
- Step 7: unit test `resolveSkills` (all seven for any profile) and the recursive copy (a fixture
  skill with a `references/` subdir lands fully). Integration: `init` into a temp fixture, assert
  SKILL.md + references exist under each profile's skillsDir; assert the count log.
- Step 8: assert exactly one domain-consult bullet rendered into both instruction files.
- Step 9: registry validation / `codument doctor` passes; the new entry resolves.

## Open questions

None blocking.

**Resolved (2026-06-24):** ship `code-reviewer` as a skill (Yes); nudge = single soft conditional
bullet, no hard invoke; generalize via triage not flat-broadening; **`senior-frontend` scope = React
web (`references/react.md`) + React Native (`references/react-native.md`), both backed and named in
the description; Vue / Svelte / SwiftUI deferred until real reference content exists** (do not claim
unbacked stacks).
