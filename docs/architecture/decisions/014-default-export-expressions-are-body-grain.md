---
status: accepted
date: 2026-07-12
---

# 014 — Default-export expressions are precise, body-grain anchors (config files stop firing on every byte)

## Context

`export default defineNuxtConfig({...})` is the shape of virtually every modern config file (Nuxt, Vite, Vitest, Astro, Tailwind, ESLint flat config). In the anchor extractor this statement is a TypeScript `ExportAssignment`, which carries no `export` modifier node — so the extractor's exported-declaration guard dropped it, the file produced zero precise anchors, and it classified **coarse**. Consequence, measured in the website dogfood: every byte change to a config file (comments and formatting included) woke the owning doc at file grain, with no token-stream invariance, no local-rename canonicalization, no per-symbol finding, and (before plan 17's signposts) no visible ack route. Config files were simultaneously the most frequently touched files in a modern repo and the worst-calibrated ones under the gate — the single largest source of mirror-edit pressure.

The signature/body split (ADR-lineage plan 10) had also *notionally* decided `export default <expr>` was all-signature, but that decision was dead code: the guard dropped the statement before the split ever saw it. Making the file precise while keeping all-signature semantics would have made things worse, not better — every config edit would become a non-ackable contract change.

## Decision

1. **An `ExportAssignment` (`export default <expr>` and `export = <expr>`) produces one precise anchor named `default`** (descriptor `default.`), the same identity anonymous `export default function/class` already gets. A config-shaped file therefore classifies precise: token-stream hashing (comment/whitespace/format invariance) and declaration-local canonicalization apply, and a change fires as one named finding instead of an undifferentiated file wake.

2. **The expression is BODY under the export frame; a producing call's callee stays SIGNATURE.** For `export default defineNuxtConfig({...})` the signature covers `export default defineNuxtConfig(` — swapping the producer is contract-grade and non-ackable — while everything inside the arguments is the ackable body. For any other expression (object literal, identifier, ternary) the frame alone is signature and the whole expression is body. Rationale: the importable contract of such a module is "there is a default export, produced by X"; the payload's doc-impact is exactly the judgment call the acknowledgment protocol exists to adjudicate (ADR 006), and the gate never decides semantic truth either way.

3. **An identifier-only body joins the closure.** `export = api` / `() => helper` reference a private declaration as their entire body; the free-identifier walk now includes a root that is itself an identifier, so editing the private value moves the default anchor rather than hiding in the module residual.

4. **`ALGO_VERSION` bumps 3 → 4.** Extraction changed, so per-symbol composite fingerprints move wholesale; per-symbol acks recorded under ALGO 3 no longer match any current transition and auto-invalidate (the fingerprint-binding working as designed). File-grain acks bind the coarse content hash, which does not derive from extraction, and survive.

## Consequences

- The dogfood arc is dead at the root: a comment edit to `nuxt.config.ts` fires nothing; a value edit is one body-only finding with a pasteable per-symbol ack; a callee swap is a signature move the ack path refuses. Pinned end to end in `review.test.ts` "config-file grain arc".
- The rejected alternative — a standing per-source noise-tolerance registry field — stays rejected (ADR 012): calibration improved by making the gate *see more precisely*, not by teaching it to ignore.
- Per-property config anchors (`default.modules`, …) remain unbuilt: the single `default.` anchor plus token invariance removed the observed noise; property grain is complexity waiting for a demonstrated need.
- Files that are only re-exports or namespace members remain coarse — a smaller, quieter class than config files, still covered by the residual/coarse backstop and now by the file-grain ack signpost.
