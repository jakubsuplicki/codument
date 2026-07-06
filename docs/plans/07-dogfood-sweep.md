---
status: shipped
---

# Plan 07: Dogfood sweep — registry-graph lints + every confirmed doc drift

The review found the product's own disease in its own repo: a stale orientation doc the gate
structurally cannot see, dangling registry edges doctor cannot lint, and ~10 confirmed doc-drift
items. This plan adds the two missing lints (so the class stays fixed) and clears every confirmed
drift.

## Why

Verified findings this plan fixes:

1. **Registry graph inconsistency, invisible to doctor.** Three entries declare
   `depends_on: ["agent-delivery-workflow"]` (`docs/.registry.json` — adversarial-review-gate,
   plan-adversary, project-charter-gate) but no such entry exists; the core-loop doc
   `docs/features/agent-delivery-workflow.md` is unregistered, so the gate can never mark it stale
   and `plan-grounding.ts:86` silently drops the edges. Doctor has no dangling-edge lint
   (`analyze.ts:534` checks emptiness only) and reads 100%/no-findings over this graph.
2. **`docs/overview.md` says "The CLI has five commands"** (line 13: init/scan/adopt/update/
   benchmark) — untouched since 2026-05-29, before the entire change-control pivot (17 top-level
   commands today). It is registry-unowned, so the staleness gate structurally cannot flag it.
3. **README claims a doctor coverage channel that does not exist**: README.md:175 lists
   "freshness/drift (over a git-history window)" among scored ratios; live output has exactly three
   (ownership/dependency/risk); `analyze.ts:430-433` and `registry-health.md:48` both say freshness
   is intentionally not wired yet. README also omits the 0.7.0 thin-doc/link-rot lints and the
   foundation exemption in its empty-depends-on fix row (README.md:364).
4. **Stale status/pointer cluster** (each verified):
   - `plan-adversary.md:71` "commits held at the user's request" — but 757dd93 shipped in 0.7.0,
     tree clean, all 5 steps checked; per the doc standard the Delivery Plan should compact; registry
     still says in-progress.
   - `impact-ledger.md:92` says "**Uncommitted**" about a feature CHANGELOG 0.6.0 shipped; registry
     says in-progress — three mutually inconsistent statuses.
   - `adversarial-review-gate.md:69-70` forward pointers "ADR 011/012" now land on unrelated ADRs
     (011 = plan adversary, 012 = file-grain acks); the review-gate ADR remains genuinely unwritten.
   - `agent-delivery-workflow.md:73` claims "Made Codex/generic the default profile" — the 0.6.0
     flip (commit 1fa0bd8) made Claude the default (`agent-profiles.ts:156`, README:92).
   - Frontmatter drift: `change-control-gate.md:30` and `registry-health.md:16` say `risk: []` while
     the registry carries `["data-loss"]`; five docs still use the v1 `sources:` frontmatter key.
     Nothing reads feature-doc frontmatter machine fields — they are unvalidated decoration that
     drifts against ADR 001's single source of truth.
   - `codument run`'s help prints a hand-maintained command list missing cost/map/ack/emit
     (`src/cli.ts:222-223`), and the shipped managed-section sentence "There is no `codument run`
     command" (`scaffold.ts:172`, pinned by `tests/scaffold.test.ts:141`) is literally false — a
     signpost stub is registered.

## Scope

- `src/lib/analyze.ts`
- `src/cli.ts`
- `src/lib/scaffold.ts`
- `docs/.registry.json`
- `docs/overview.md`
- `docs/features/plan-adversary.md`
- `docs/features/impact-ledger.md`
- `docs/features/adversarial-review-gate.md`
- `docs/features/agent-delivery-workflow.md`
- `docs/features/change-control-gate.md`
- `docs/features/registry-health.md`
- `docs/features/complete-cost-capture.md`
- `docs/concepts/doc-audience-layers.md`
- `docs/concepts/review-effectiveness-metric.md`
- `tests/analyze.test.ts`
- `tests/scaffold.test.ts`

Also touches root-level `README.md` — after Plan 04, add it to this scope list properly.

## Non-goals

- No new coverage ratios (freshness stays unwired and honestly N/A — the fix is the README, not
  wiring it here).
- No prose-altitude lint (a separate feature candidate).
- No content redesign of healthy docs; only the confirmed drifts.

## Decisions (settled)

- **Two new doctor lints**: `dangling-depends-on` (warn: a depends_on slug names no registry entry)
  and `orphan-doc` (info: an .md under docs/features|concepts with no registry entry pointing at
  it — info so legitimately-unowned pages don't fail CI). Both documented in `registry-health.md`
  with the usual fix rows.
- **Register `agent-delivery-workflow`** as a `concept` entry owning its doc, with
  `related_sources: ["src/lib/scaffold.ts", "src/lib/agent-profiles.ts"]` (the workflow's install
  surface) and no primary sources — the three existing edges then resolve. If doctor's analyzers
  reject a primary-source-less entry, fall back to retargeting the three edges at the `cli` feature
  and cross-linking the doc in prose; prefer registration.
- **Own `docs/overview.md`**: rewrite to the current three-part identity (deterministic checks +
  adversarial gates + delivery workflow, all off the registry) with the real command surface, and
  add it to the `cli` feature's docs array so the gate covers it from now on.
- **Frontmatter**: strip machine fields (sources/primary_sources/related_sources/depends_on/risk)
  from feature-doc frontmatter entirely, keeping title/status/type/last_reviewed — the registry is
  the single source of truth per ADR 001 and unvalidated duplicates only drift. Update the scan
  scaffold generator to match.
- **`run` signpost inventory**: generate the command list from the registered commander commands at
  print time; hand lists drift. Fix the managed-section sentence to the accurate framing
  ("`codument run` is only a signpost; the autopilot loop lives in these instructions") and update
  the pinned assertion in `tests/scaffold.test.ts:141`.

## Delivery Plan

- [x] Step 1: Add `dangling-depends-on` + `orphan-doc` lints to `analyze.ts` with tests and
      `registry-health.md` rows. (Expect them to fire on this repo until Step 2 lands — that is the
      lints working.) Shipped shape: per-edge warn + info note, both firing live (3 edges, 1
      orphan); review hardening folded in — `docs[]` paths shape-canonicalized at parse so the
      string-keyed orphan check can't false-fire on a `./` spelling, and the LintFindingId
      exhaustiveness map extended.
- [x] Step 2: Fix the graph: register `agent-delivery-workflow`, fix its stale default-profile line
      and compact its build log; re-run doctor → the new lints read clean. Shipped shape: concept
      entry, no primary sources (related: scaffold + agent-profiles), doc rewritten to the standard
      layers with the shipped sub-plans compacted and the genuinely-unshipped next-step-handoff
      draft kept; `doctor --strict` green WITH the new lints active.
- [x] Step 3: Rewrite `docs/overview.md` to the current identity + command surface; register it under
      the `cli` feature's docs. Shipped shape: three-part identity (deterministic checks /
      adversarial gates / delivery workflow) off the one registry, all 17 commands grouped by
      role with `--help` named as the authoritative reference; gate now wakes the overview when
      `src/cli.ts` changes.
- [x] Step 4: README truth sweep: drop/futures-mark the freshness channel (:175), add
      thin-doc/link-rot rows plus fix rows for the two new graph lints (dangling-depends-on,
      orphan-doc — so this plan doesn't recreate the drift class it fixes), correct the
      empty-depends-on row to the isolated-entry semantics (:364), sync the runner/limits
      wording only where it drifted. Shipped shape: coverage bullet names the three real ratios
      + an honest why-not-freshness; lint/notes bullets and the fix table carry all four
      recent lints with severity-honest guidance; runner wording verified already in sync.
- [x] Step 5: Status reconciliations: compact `plan-adversary.md`'s shipped Delivery Plan and flip
      its registry status to current; reconcile `impact-ledger.md` to one status (current) and flip
      the registry; renumber `adversarial-review-gate.md`'s ADR pointers to "a future ADR" (step 6
      there remains honestly unchecked). Shipped shape: both shipped docs compacted to durable
      layers (impact-ledger's deferred report footer preserved as a Non-goal, its resolved
      report-parity question dropped); every status now tells one story.
- [x] Step 6: Frontmatter strip across the drifted docs + scaffold generator update; test that scan's
      generated frontmatter carries no machine fields. Shipped shape: all 16 carrier docs down to
      title/status/type/last_reviewed; scan + map materialize generators, both templates, and the
      update-docs skill template match; the doc standard (doc-audience-layers + the managed-section
      sentence) now states the minimal-frontmatter rule; scan test pins the absence of every
      machine field.
- [x] Step 7: Generate `run`'s command inventory from registered commands; fix the managed-section
      sentence in `scaffold.ts` + the pinned test; regenerate AGENTS.md/CLAUDE.md managed sections
      (`codument update` on this repo). Shipped shape: inventory derived from `program.commands` at
      print time with a dynamic test (every `--help` command must appear — the drift class is
      closed, not just the instance); managed sections regenerated, which also re-synced the lagged
      `.agents` Codex skill copies to the 0.7.0 adversary wiring.

## Outcome

The repo passes its own product's standard: every doc the README leans on is registry-owned and
gate-covered, the dependency graph has no silent dangling edges (and never can again — the lint
class is closed), README describes the doctor that actually runs, and every status tells one story.
What it does NOT do: write the still-unwritten review-gate ADR (that belongs to the gate-flip work),
or wire freshness into coverage.

## Acceptance criteria

`codument doctor --strict` exits 0 on this repo WITH the two new lints active; grep confirms no
`sources:` frontmatter remains under docs/; `node dist/cli.js run` lists every registered command;
each cited drift line reads correct against live behavior.

## Verification

`npm test`; `npm run typecheck`; `codument doctor --strict` and `codument review --strict` green on
this repo; spot-read the rewritten overview.md against `node dist/cli.js --help`.
