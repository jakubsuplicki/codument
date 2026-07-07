---
status: shipped
---

# Plan 09: `codument context` — deterministic context packs

Make the registry valuable on **every agent turn**, not just at gate moments: a pull-based context
oracle instead of a push-based cost.

## Why

- The registry's routing power is currently proven only by a benchmark (43.1% context reduction,
  README:415-425) and consumed only at gates (review, adversary bundles). Nothing lets an agent PULL
  the minimal working set for a task: owning docs, primary sources, one-hop `depends_on`, invariants
  with their test pointers.
- The projection machinery already exists twice: `src/lib/plan-grounding.ts` builds exactly this for
  plans; `src/lib/review-bundle.ts` for diffs. This is a third projection over the same registry —
  low effort, high strategic leverage: it flips codument from a tool that costs the agent something
  at gates into one the agent *wants* every prompt. Nothing else in the stack (agent memory/rules,
  CODEOWNERS, CI) can route a task to its relevant slice deterministically.

## Scope

- `src/commands/context.ts` (new)
- `src/lib/context-pack.ts` (new)
- `src/cli.ts`
- `src/index.ts`
- `tests/context-pack.test.ts` (new)
- `docs/features/context-pack.md` (new)
- `docs/.registry.json`
- `.claude/skills/plan-with-docs/SKILL.md`
- `.claude/skills/work-step/SKILL.md`
- `skills/plan-with-docs/SKILL.md`
- `skills/work-step/SKILL.md`
- `src/lib/scaffold.ts` (only if the skills are generated from it — mirror wherever the shipped
  skill text actually lives)

```feature-map
src/commands/context.ts  | context-pack | feature | CLI: selector flags, human + --json rendering, budget
src/lib/context-pack.ts  | context-pack | feature | deterministic projection: entry -> docs, sources, one-hop deps, invariants + test pointers
```

Run `codument map materialize` for each new file.

## Non-goals

- No real tokenizer dependency — estimates only (see decisions).
- No file *contents* beyond the owning docs' invariant lines; the pack lists paths and pointers, the
  agent reads what it chooses (the pack is a map, not a payload dump).
- No model calls, no ranking heuristics — purely registry + committed docs, same purity contract as
  `map check --json`.

## Decisions (settled)

- Shape: `codument context --feature <slug> | --file <path> | --plan <path> [--json]
  [--budget <tokens>]`. `--file` resolves through ownership (primary owner + concept umbrellas);
  `--plan` reuses the plan-grounding projection over the plan's Feature Map rows.
- Pack contents, in priority order (budget trims from the tail, never the head): owning doc path +
  its `In plain terms` and `Invariants & boundaries` sections verbatim; primary_sources list;
  one-hop `depends_on` entries (doc path + one-line In-plain-terms first sentence); related_sources;
  risk tags.
- Token estimate: `ceil(chars / 4)` per item and a pack total — deterministic, no dependency;
  labeled as an estimate.
- Skills wiring: `plan-with-docs` step 1 and `work-step` call
  `codument context --plan/--feature` instead of hand-assembling registry reads, with graceful
  wording when the CLI is unavailable.

## Delivery Plan

- [x] Step 1: `context-pack.ts` projection with unit tests (feature selector, file selector through
      ownership incl. concept umbrellas, plan selector via plan-grounding reuse; deterministic
      ordering). Shipped shape: pure `buildContextPack` (selected entries head-first, one-hop deps as
      lightweight pointers) + impure `gatherContextPack`, reusing `extractDocSection`/
      `extractTestPointers` and mirroring `plan-grounding.ts`; selectors resolve via `ownersOfFile`
      (primary-only, concept umbrellas included) and `selectedFromPlanRows` (Feature-Map routing).
- [x] Step 2: `context` command: human rendering + `--json` (versioned contract), `--budget`
      tail-trimming with an explicit "trimmed: …" line (no silent caps). E2E + byte-identical tests.
      Shipped shape: one-selector validation (mutually exclusive), pure `applyBudget` (tail-first
      risk → related → deps → primary; head inviolable; reports dropped tiers + `overBudget`); the
      selector echoes the caller's raw input, not what it resolved to. Adversarial review (opus
      finders + 2-vote verify) confirmed 3 minor command-layer findings, all fixed at the root: a
      `--plan` silently discarded malformed Feature-Map rows (now surfaced via a new `planErrors`
      channel in both the human and `--json` paths, like `unknownFeatures`); a sub-1 `--budget`
      passed the `> 0` guard then floored to 0 (now rejected `< 1`, consistent with `0`/`-5`); and a
      `--plan` pointing at a directory threw an uncaught EISDIR (now a graceful `fail`).
- [x] Step 3: Register the feature (doc in standard layers, invariants pinned to tests); export from
      `index.ts`. Shipped shape: `context-pack.md` at the standard layers, registry entry current
      (depends_on lib), `index.ts` exports the projection (additive — file-acked).
- [x] Step 4: Wire the two skills (installed copies and their shipped sources) to call it; regenerate
      managed sections if the skill text is scaffold-generated. Shipped shape: `plan-with-docs` step 1
      and `work-step` step 5 now reach for `codument context --feature/--file/--plan` with a
      fall-back-if-unavailable clause; edited the `skills/` source-of-truth and re-synced both
      installed profiles (`.claude`, `.agents`) via `codument update` (skills are copied verbatim,
      not managed-section-generated).

## Outcome

An agent (or human) gets the minimal grounded working set for any feature, file, or plan in one
deterministic command with an honest size estimate — the registry starts paying rent on every turn.
It does NOT summarize, rank, or fetch anything the registry and committed docs don't already state.

## Acceptance criteria

`context --feature change-control-gate` on this repo lists its doc, invariant lines with test
pointers, primary sources, and one-hop deps, byte-identical across runs; `--budget` trims tail-first
and says what it dropped; `--file src/lib/drift.ts` resolves through ownership; skills reference the
command.

## Verification

`npm test`; `npm run typecheck`; live dogfood on this repo for all three selectors; compare a
`--plan` pack against `map check --plan --json` grounding for consistency.
