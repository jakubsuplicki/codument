---
status: shipped
---

# Plan 15: Prose-altitude lint — mechanically enforce the doc standard

The standard the product ships ("intent altitude: no identifiers, counts, or call order in prose;
Key files carries role, not paths") is currently enforced by skill prose alone — and the repo's own
docs violate it. Convert it into the same verify-don't-trust machinery as everything else.

## Why

- `docs/concepts/doc-audience-layers.md` names a prose-altitude lint as a planned check (untested),
  and the review confirmed the drift it would catch exists in this very repo (Key files sections
  enumerating literal `src/` paths against the invariant that prose never restates the file list).
- The demote-to-telemetry pattern already exists for exactly this kind of heuristic (ADR 005:
  co-movement is info-only): ship the lint info-level, promote to warn only after its own
  false-fire soak. That keeps the deterministic core honest while the heuristics prove themselves.

## Scope

- `src/lib/prose-altitude.ts` (new)
- `src/lib/analyze.ts`
- `tests/prose-altitude.test.ts` (new)
- `docs/features/registry-health.md`
- `docs/concepts/doc-audience-layers.md`
- `docs/.registry.json`

```feature-map
src/lib/prose-altitude.ts | registry-health | feature | deterministic altitude heuristics over registered docs' prose sections
```

Run `codument map materialize src/lib/prose-altitude.ts`.

## Non-goals

- No NLP, no model calls — deterministic lexical heuristics only.
- Never a warn in this plan: info channel only; promotion is a separate future decision backed by
  the lint's own soak data.
- No auto-rewriting of docs.

## Decisions (settled)

- Three heuristics, each a separate info id so soak data can judge them independently:
  1. `symbol-mirror`: a prose line (outside code fences and the Key files table) that begins with an
     exported identifier from the entry's primary sources followed by a verb — the mechanism-mirror
     the standard forbids.
  2. `line-anchor`: `:<number>` file-line anchors in prose (they rot on every edit).
  3. `path-enumeration`: more than N literal source paths (default 4) in a single prose section —
     the "prose restates the file list" smell. Key files sections are exempt from path counting but
     flagged when an entry lists paths with no role text.
- Runs as part of doctor's registered-doc pass (same exclusion spec), rendered in the Notes channel
  (never a finding, never fails `--strict`), with per-heuristic tallies in `--json`.
- Dogfood is part of the plan: fix the worst self-violations the lint finds in this repo's docs, so
  it ships having eaten its own cooking.

## Delivery Plan

- [ ] Step 1: `prose-altitude.ts` heuristics with fixture docs covering true and near-miss cases
      (identifier at line start inside a code fence must NOT fire; a path in a fix-table must not
      count as prose enumeration).
- [x] Step 2: Doctor wiring (Notes channel + `--json` tallies), exclusion-spec reuse; tests that
      bare doctor exit codes are untouched.
- [x] Step 3: Dogfood run over this repo's docs; fixed the clear violations (the 4 line-anchors in
      domain-skills.md; corrected a Key-files heuristic false-positive that misread a prose sentence
      as a bare-path entry); recorded the false-fire baseline in `doc-audience-layers.md` (symbol-mirror
      over-fires on command docs; path-enumeration fires on transient delivery-plan/impact sections).
- [x] Step 4: Docs: registry-health.md gains the three info ids invariant; doc-audience-layers.md's
      planned-check note replaced with the shipped description + promotion criterion (warn only after
      an id's own false-fire soak).

## Outcome

The doc standard stops being advice: every registered doc gets a deterministic altitude reading, the
repo's own docs come out clean, and the promotion decision (info → warn) becomes data-driven exactly
like the gate flip. It does NOT fail anyone's CI and does NOT claim to measure doc *quality* — only
the three named smells.

## Acceptance criteria

Fixtures fire and near-misses don't; this repo's doctor Notes show the tallies; bare doctor exit
codes unchanged; the confirmed Key-files violations in this repo are fixed or explicitly
role-annotated.

## Verification

`npm test`; `npm run typecheck`; `node dist/cli.js doctor` on this repo before/after the dogfood fix
step, comparing tallies.
