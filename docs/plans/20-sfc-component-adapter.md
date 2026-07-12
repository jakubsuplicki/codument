---
status: approved
---

# Plan 20: single-file-component adapter — `.vue` / `.svelte` / `.astro` stop being invisible

Born from codument's own website dogfood: the site's most-touched registered sources are `.vue`
files, and the gate never judged one of them (plan 17 made that blind spot loud via the
"Registered but ungated" notice; this plan closes it). One adapter covers the three mainstream
component formats because they share one shape: named top-level blocks, one of which is a script
in a language the gate already understands.

Depends on Plan 18 (battery; runtime optional — see Decisions). Frameworks that are NOT
single-file formats (React, Next, Angular, Nest, Express…) need nothing: their components are
`.ts`/`.tsx` and were per-symbol from day one.

## Why

- A registry that names `Hero.vue` load-bearing while the gate stays silent on every edit to it is
  a standing false-fresh — the inverse of the config-file noise, and just as corrosive to trust.
- The marginal cost is low by design: the script block delegates to the EXISTING TS engine, so the
  hard parts (fingerprinting, canonicalization, closure, split) are already built and battle-tested.

## Scope

- `src/lib/sfc-adapter.ts` (new: block scanner + delegation + pseudo-anchors)
- `src/lib/fingerprint.ts` (register), `src/lib/analyze.ts` (`.vue`/`.svelte`/`.astro` join the
  source spec)
- `tests/sfc-adapter.test.ts`, `tests/review.test.ts` (e2e on a website-shaped fixture)
- `docs/features/change-control-gate.md`, `README.md`, `CHANGELOG.md`, `docs/.registry.json`

```feature-map
src/lib/sfc-adapter.ts | change-control-gate | feature | SFC block split: script→TS engine, template/style→body-grain pseudo-anchors
```

## Non-goals

- No component-contract extraction in v1 (`defineProps`/`defineEmits`/slots as a first-class
  `component.` signature). It is the right v2 — named follow-up — but it needs framework-version
  awareness the block model does not; v1's script-level per-symbol grain plus ackable template
  anchors already beats invisible.
- No CSS intelligence: a `<style>` block is one content-hashed anchor, not per-selector.
- No support for custom SFC block types beyond pass-through into the residual.

## Decisions (settled)

- **Block extraction is a small deterministic scanner, not a grammar.** Top-level
  `<script>`/`<template>`/`<style>` (and Astro's `---` frontmatter fence) are line-anchored,
  non-nesting regions — a bounded scanner is byte-deterministic, dependency-free, and immune to
  the patchy maintenance of third-party SFC grammars. A file the scanner cannot segment
  classifies `unevaluable` (fail-loud), never guessed.
- **Script blocks delegate to the TS adapter** (`lang="ts"` or plain JS — the TS parser reads
  both) with anchors keyed on the SFC path: `Hero.vue::rotateToken().`. `<script setup>` exports
  nothing by design, so its top-level declarations are treated as the public surface of the
  component (they are what the template binds), each a normal per-symbol anchor.
- **Template and style are body-grain pseudo-anchors** — `template.` and `style.` term
  descriptors, content-hashed with markup-aware trivia folding (HTML comments and
  inter-tag whitespace are not content). Both are body-only, so a template tweak is one named,
  ackable finding — never a whole-file wake, never silence.
- **Multiple script blocks** (`<script>` + `<script setup>`) fold into one extraction in source
  order, mirroring the overload-run machinery's multi-node composite.
- **Once the adapter registers, the plan-17 `ungatedRegistered` notice stops listing these
  extensions automatically** — the info surface retires itself per file type as judgment arrives,
  which was its design intent.

## Delivery Plan

- [x] Step 1: block scanner (vue/svelte/astro shapes, unevaluable on malformed) + script
      delegation; battery behaviors via the delegated engine + scanner determinism tests.
- [x] Step 2: `template.`/`style.` pseudo-anchors with markup trivia folding; ack e2e (template
      tweak → one ackable finding; script contract change → signature move refused).
- [x] Step 3: registration + extension spec + ungated-notice retirement; e2e on a
      website-shaped fixture (the dogfood repo's shape: component edit wakes exactly its owning
      feature doc).
- [ ] Step 4: docs — gate-doc matrix, README row, CHANGELOG, registry.

## Outcome

The website repo's own gate goes from "44 commits of invisible component work" to per-symbol
script drift plus ackable template/style findings — and every Vue/Svelte/Astro user gets the same.

## Acceptance criteria

Battery green through delegation; scanner refuses malformed files loudly; the website-shaped e2e
green; ungated notice no longer lists adapted extensions; suite green; strict green per commit.
