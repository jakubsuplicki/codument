---
status: shipped
---

# Plan 38: fan-out steps — a sizing rule the plan gate can hold

The 2026-08-07 Expo-app field report: Step 6 of an approved plan was "generate twelve locales" —
roughly thirty-five agents and a blown session limit that killed fifteen of them mid-flight.
"The plan-writing moment didn't have the information to size it, and no gate flagged it until I
was inside it."

Verified: the entire sizing guidance in `skills/plan-with-docs/SKILL.md` is one clause ("Keep
implementation steps independently reviewable and commit-sized"), with no definition of
commit-sized and no fan-out rule; and the plan adversary (`agents/adversarial-planner.md`)
grounds its objections in the feature map's committed invariants and says nothing about step
shape. Both artifacts that look at a plan before approval were blind to the one property that
sank the run.

## Why

- A step is the unit the three gates hold (`work-step` → `review-work` → `commit-work`). A step
  hiding an unbounded loop breaks all three at once: implementation outruns a session, review
  over dozens of agents' output is not a review, and the commit is a monolith.
- The fix belongs at plan time, in prose, because that is where the count is visible — the plan
  names "twelve locales" before any agent spawns.

## Scope

- `skills/plan-with-docs/SKILL.md` + installed `.agents/skills/` copy
- `agents/adversarial-planner.md` + installed copy
- `docs/features/plan-adversary.md` — one line recording the new objection class
- `CHANGELOG.md`

Skill and agent prose only; no source files.

## Non-goals

- **No CLI step-size lint.** "Too big" is not decidable from checklist text without guessing —
  counting plural nouns is a false-positive machine — and a deterministic gate that guesses
  erodes trust in the gates that don't. If field evidence later shows prose alone fails, a lint
  gets its own plan with its own evidence.
- No change to step mechanics, the step-sync gate, or autopilot's hard-pause conditions.

## Decisions (settled)

- **`plan-with-docs` gains a sizing rule** with the tell and the two legal shapes. The tell: a
  step that performs the same operation over a list of artifacts (locales, endpoints, adapters,
  migrations, entities) is a loop, not a step — and a step sentence that carries its own count or
  plural ("all twelve locales") is announcing the fan-out the review gate will be asked to pay.
  The two legal shapes: split into explicit batches, each batch one step with its size stated and
  the first batch first (it debugs the template the rest inherit); or restructure as "build one
  exemplar" + "replicate in batches of K". The existing commit-sized clause stays; this rule is
  its missing definition.
- **The plan adversary gains a step-shape objection class**: flag any step whose described work
  repeats over more items than one review-commit cycle can hold, citing the count from the plan
  or feature map. It stays an objection the user adjudicates at the approval gate — the adversary
  never blocks.

## Delivery Plan

- [x] **Step 1 — Sizing rule in `plan-with-docs`.** The tell, the two shapes, the
      first-batch-first rationale; mirror the installed copy.
- [x] **Step 2 — Step-shape objection in the adversary.** Add the objection class to
      `agents/adversarial-planner.md` (mirror installed copy), record it in
      `docs/features/plan-adversary.md`, CHANGELOG.

## Acceptance criteria

- Replayed, a plan carrying "generate twelve locales" as a single step draws a step-shape
  objection at the approval gate naming the fan-out and both restructures — before any agent
  spawns.
- A plan of genuinely commit-sized steps draws no new objection ("no material objections"
  remains the expected result for a well-grilled plan).

## Verification strategy

- Prose-governed, the stance every skill-only plan takes: a fixture plan with a fan-out step run
  through the adversarial pass produces the objection in the transcript; a well-sized fixture
  plan produces none. The skill text change is validated by reading the rendered approval flow.
