---
title: Context pack
status: current
type: feature
last_reviewed: 2026-07-07
---

# Context pack

## In plain terms

`codument context` hands an agent (or a person) the minimal grounded working set for a task, in one
deterministic command. Point it at a feature, a source file, or a plan and it projects that slice's
owning doc — its plain-terms orientation and its invariant lines with their test pointers — plus the
primary sources to read and the one-hop dependencies to be aware of. It is the mirror image of the
gate: the gate is a cost the registry imposes when a change lands, and this is the value the same
registry pays back on every turn, so the agent *wants* to pull it before it starts.

## Design approach

This is the third projection over the registry, and it deliberately looks like the other two
(`plan-grounding` for the plan adversary, `review-bundle` for the review adversary): a pure core
that turns a registry plus a passed-in doc map into a structured pack, wrapped by a thin impure
gather that does the disk reads. It adds no source of truth and no ranking — every field is read
verbatim from `docs/.registry.json` and the committed feature docs, so the pack is a map of what to
read, never a summarized or re-scored payload.

The three selectors resolve to the same shape by different routes. A feature names itself; a file
resolves through *primary* ownership only (the same rule the staleness gate uses — related sources
are impact, never ownership), which naturally includes any concept umbrellas that own it; a plan
routes through its Feature Map exactly as `map check` does. A file's ownership runs through the one
source matcher the gate and the health surface use, so a file governed by a registered tree pattern
is owned exactly as a literally-named one is — "who owns this file" cannot come back different
depending on which surface you ask. From the selected features it walks one
dependency hop — a dependency is a signpost ("you may also need this"), so it is rendered as a
lightweight pointer (doc path plus the first sentence of its orientation), not an inlined contract,
and the walk stops at one hop so the pack stays a minimal working set rather than the whole graph.

The pack is the expensive answer to a broad question, and the loop's most frequent question is not
broad: before touching a file an agent needs one fact — which doc owns it. Charging a full pack for
that is why the cheap habit is to skip the lookup and guess, so a file selector also has a lean door
that answers ownership in a single line and nothing else. It is the same resolution the pack runs, so
the two can never disagree; it names *every* candidate for a shared file rather than picking one,
because which feature owns the symbol you are about to move is a decision, not something a lookup may
quietly make for you; and it names the tree a file was owned through when a pattern governs it,
because that is the difference between owing the doc an update and acking the tree.

A budget trims the pack toward a token target tail-first, in the settled priority order, and the
selected feature's orientation and invariants — the thing the caller actually asked for — are the
head and are never trimmed. What was dropped is always reported, so a budget is a visible trade-off,
never a silent truncation. Token counts are the same dependency-free `ceil(chars / 4)` estimate the
cost ledger and the benchmark use, and are labelled an estimate everywhere they surface.

## Invariants & boundaries

- The pack is a pure, deterministic function of the registry and the committed docs: same inputs
  yield a byte-identical pack and `--json` across runs, with entries, sources, deps, and trim labels
  all sorted. No clock, no git, no model. *(tests: `context-pack.test.ts` "is deterministic —
  byte-identical across runs" / "--json is version-tagged and byte-identical across runs")*
- A file selector resolves through primary ownership only — every feature and concept umbrella whose
  `primary_sources` names the file, never a related-only toucher — and a file no entry owns is
  surfaced, never guessed at. Naming runs through the shared source matcher, so a registered tree
  pattern owns the files under it exactly as a literal path owns one. *(tests: `context-pack.test.ts`
  "returns every primary owner incl. concept umbrellas, never a related-only toucher" / "names a file
  governed by a registered pattern" / "surfaces an unmapped --file")*
- The lean ownership answer is one line in every case — one owner, several, or none — and an unowned
  file is a fact reported at exit zero, not a failed invocation, so the lookup is safe to run from a
  hook or a loop. It is an additional door onto the same resolution: the pack it sits beside is
  unchanged when the flag is absent. *(tests: `context-pack.test.ts` "answers a single-owner file in
  one line" / "names every candidate for a shared file" / "says plainly when nothing owns the file,
  and still exits 0" / "leaves the full pack untouched when the flag is absent")*
- Dependencies are followed exactly one hop and rendered as pointers (doc + first sentence), never
  inlined with their own invariants or sources, so the pack cannot balloon into the whole graph.
  *(tests: `context-pack.test.ts` "follows one-hop deps as lightweight pointers" / "does not
  transitively walk dependencies")*
- A budget trims tail-first (risk → related sources → dependency pointers → primary source lists),
  never the selected head; when even the head exceeds the budget it is reported over-budget, not
  dropped; every dropped tier is named. *(tests: `context-pack.test.ts` "trims tail-first … and
  reports every dropped tier" / "stops trimming as soon as the pack fits")*
- Nothing is dropped silently: a selected slug the registry does not know surfaces as an unknown
  flag (never fabricated into an entry), and a malformed Feature-Map row a `--plan` could not parse
  surfaces as a plan-error flag (never silently omitted from routing) — the same honest-absence
  stance the whole tool takes. *(tests: `context-pack.test.ts` "flags a selected slug the registry
  does not know" / "surfaces malformed Feature-Map rows instead of silently dropping them")*
- Exactly one selector is required; zero or two exit nonzero, as does a `--budget` below one whole
  token (a sub-1 value is rejected, not silently floored to zero). *(tests: `context-pack.test.ts`
  "exits nonzero on no selector, two selectors, and a non-positive budget" / "rejects a sub-1
  --budget rather than silently flooring it to 0")*
- Every CLI boundary fails gracefully: a `--plan` path that exists but cannot be read (a directory,
  a permission block) exits with a clean diagnostic, never an uncaught stack trace. *(test:
  `context-pack.test.ts` "fails gracefully when --plan points at a directory")*

## Decisions

- One more projection over the one registry rather than a new store — the same derived-first,
  no-second-source-of-truth stance recorded in
  [001-registry-v2-model-no-migration](../architecture/decisions/001-registry-v2-model-no-migration.md)
  and [004-symbol-grained-derived-first-ownership](../architecture/decisions/004-symbol-grained-derived-first-ownership.md).
- Estimates, not a tokenizer dependency: `ceil(chars / 4)`, the same figure the cost ledger derives
  at render time per
  [009-token-counts-are-truth-cost-derived-at-render](../architecture/decisions/009-token-counts-are-truth-cost-derived-at-render.md).

## Key files

- `src/lib/context-pack.ts` — the pure projection, the selector and ownership resolvers, and the
  budget trimmer.
- `src/commands/context.ts` — the CLI: selector validation, budget parsing, the lean ownership
  answer, human + `--json` rendering.
