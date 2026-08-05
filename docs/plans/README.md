# Plans — 2026-07-02 full review

Fifteen plans from the 2026-07-02 adversarially-verified full review (46-agent review; every defect
was verified against source, most reproduced live against the built CLI). Plans 01–07 fix confirmed
defects; plans 08–15 are the recommended upgrades from the strategy lens. Each plan is
self-contained: a fresh session can execute it with no other context, and every product decision is
pre-settled in its Decisions section (adjust at approval, not mid-run).

## How to run one plan

1. Flip exactly **one** plan's frontmatter from `status: draft` to `status: approved`.
   Keep the others draft — the out-of-plan gate keys off the first approved plan by filename
   (`src/lib/change-state.ts` reads this directory); if several are approved at once, `review`
   warns naming every contender and `steps` refuses, but the discipline is still one at a time.
2. Point the executing agent at the file: it follows the repo workflow (AGENTS.md): work one
   unchecked Delivery Plan step at a time, `codument review --strict` green before each commit,
   commit as the user with no AI co-author trailer.
3. `codument steps --plan docs/plans/<file>` renders the checklist.
4. When the last step lands, flip the plan to `status: shipped` (do not leave it approved).

## Recommended order — fixes (01–07)

| Plan | Theme | Why this order |
| --- | --- | --- |
| [01](01-release-hygiene.md) | Publish blockers | Small; unblocks the owed `npm publish` |
| [02](02-state-file-integrity.md) | Data-loss fixes | Worst user harm; independent of the rest |
| [03](03-gate-fail-closed.md) | Gate I/O fail-closed | Flagship-promise integrity |
| [04](04-verdict-semantics.md) | Verdict-path correctness | Builds on 03's parsing changes |
| [05](05-confirm-gate-hardening.md) | Adversary confirm gate | Independent |
| [06](06-first-run-polish.md) | First-run & guidance | Independent |
| [07](07-dogfood-sweep.md) | Doc drift + graph lints | Last of the fixes: docs settle after code |

## Upgrades (08–15) — run after the fixes they depend on

| Plan | Feature | Depends on |
| --- | --- | --- |
| [08](08-history-audit.md) | `codument audit <range>` — retroactive drift audit, the adoption wedge | 04 (deletions; shared seams) |
| [09](09-context-pack.md) | `codument context` — deterministic context packs, push → pull | — |
| [10](10-signature-body-split.md) | Signature/body anchor split — sig changes not ackable | — |
| [11](11-local-rename-canonicalization.md) | Local-rename canonicalization — kill the #1 false-fire | run right after 10 (one algoStamp shift) |
| [12](12-verify-invariants.md) | `doctor --verify-invariants` — executable invariants | 05 (shared runner) |
| [13](13-audit-surfaces.md) | Visible acks + machine-readable impact ledger | — |
| [14](14-sarif-output.md) | `review --format sarif` — PR annotations, no bot | 03 (JSON discriminant) |
| [15](15-prose-altitude-lint.md) | Prose-altitude lint (info-level) | — |

Leverage order if picking selectively: 09 and 08 first (they change who wants the product), then
10+11 together (they change what the gate can promise), then 12–14, then 15.

## Dogfood findings (16–17) — from the 2026-07-11 website build

Two plans born from a real external dogfood: an agent built a production website under the gate
(44 commits) and reported where the discipline held and where it leaked. Verified against source
before planning; both are self-contained like 01–15.

| Plan | Theme | Finding it fixes |
| --- | --- | --- |
| [16](16-gate-enforcement.md) | Pre-commit hook installer + CI required check | 1-in-44 commits slipped through a momentarily red gate; instructions alone don't enforce |
| [17](17-config-grain-calibration.md) | Config-file grain, coarse-ack signposts, ungated-source visibility | `export default` config files are coarse (every byte fires, nothing ackable is suggested); registered non-source files change silently |

Run 16 before 17; they are independent but 17's CHANGELOG rides on 16's release framing.

## Language expansion (18–25) — per-symbol drift beyond TypeScript

Per-symbol resolution is the moat. One substrate plan makes "precise" a single testable contract
(tree-sitter WASM + a conformance battery every adapter must pass); the language plans then carry
only genuinely language-specific decisions. 18 (substrate), 19 (Python), 20 (SFC), 21 (Go),
22 (Rust), 23 (JVM: Java + Kotlin), 24 (C#), and 25 (matrix) are ALL shipped — the language
expansion is complete. The runtime-compatible Kotlin grammar was resolved to the pinnable
`@tree-sitter-grammars/tree-sitter-kotlin` npm package (see plan 23's grammar-sourcing note).

| Plan | Target | Depends on | Note |
| --- | --- | --- | --- |
| [18](18-language-adapter-substrate.md) | Substrate: WASM runtime + conformance battery | — | Everything below rides this |
| [19](19-python-adapter.md) | Python | 18 | Biggest new market; per-member class split |
| [20](20-sfc-component-adapter.md) | `.vue` / `.svelte` / `.astro` | 18 (battery only) | Closes our own dogfood's blind spot; script delegates to the TS engine |
| [21](21-go-adapter.md) | Go | 18 | Cleanest public rule (capitalization) |
| [22](22-rust-adapter.md) | Rust | 18 | Visibility-literal; macros bounded honestly |
| [23](23-jvm-adapter.md) | Java + Kotlin | 18 | Enterprise pair; annotations are contract |
| [24](24-dotnet-adapter.md) | C# | 18 | Partial classes, accessors, records pinned |
| [25](25-language-matrix-presentation.md) | Language matrix: README/CLI presentation, parity-tested | any shipped adapter | Run LAST; the matrix mechanically cannot lie; the website mirrors it via its own repo's plan |

Frameworks need no per-framework adapters: React/Next/Angular/Nest are `.ts`/`.tsx` (covered
since day one), config-file shapes were calibrated by plan 17, and the component FILE FORMATS are
plan 20. Long-tail candidates (Ruby, PHP, Swift, Scala, F#) get plans when demand shows — same
substrate, same battery, same descriptor discipline.

## Field defects — nested-repo monorepo dogfood (26–29)

Four plans from a 2026-07-20 field report: `/update-docs` on a real monorepo (no root repo, two
nested git repos) hit a doctor crash, a silently-inverted coverage signal, and a missing exclusion
escape hatch. Every reported defect was verified against source and reproduced live against the
built 0.9.0 CLI before planning — and the verification found the reported mechanisms partly wrong
(scan never consults gitignore in ANY repo; the crash is a warm-set/consumption-set divergence,
not a missing warm call) plus one worse defect the report missed: a **false green from
`review --strict`** when an owned source changes inside a nested member repo (the gitlink lands in
"other" and the stale-doc verdict never fires; submodule super-repos are equally blind).

| Plan | Theme | Fixes |
| --- | --- | --- |
| [26](26-honest-scope-resolution.md) ✅ **shipped** | Honest scope: typed unknown, complete warm, one discovery path | doctor crash (root cause); scan's gitignore blindness; unknown-read-as-empty false 100%; generated-leakage lint net |
| [27](27-configurable-exclusions.md) | `exclude` block in `.codument-meta.json` | no escape hatch for `out/`, `public-preprod/`; adopt deleting hand-added meta keys; README's phantom affordance |
| [28](28-nested-repo-workspace.md) | Nested-repo workspaces: aggregate git truth across members | the gate false-green (worst defect); nested `.gitignore` aggregation; submodule blindness; workspace-honest refusals |
| [29](29-prose-altitude-test-links.md) | Prose-altitude calibration | `path-enumeration` penalizing the standard's required invariant→test links; per-mention over-counting |

**All four shipped.** 26 (`8994eb3`, `7477465`, `44b6ba7`, `48e8d95`, `13cc2ce`) closed the doctor
crash and the false-coverage inversion, and made `scan` honor `.gitignore` in every repo. 27
(`3882cbe`, `d62c878`, `09c68eb`, `b26773e`) gave the denominator its user-maintained half: an
`exclude` block every consumer reads, validated fail-loud, surfaced beside the score, and preserved
across `adopt`. 28 (`b3ced2a`, `b9bd188`) made a workspace of member repositories one aggregated git
view and killed the gate's false green, refusing by name what a single ref cannot span (ADR-016).
29 (`0e51945`) stopped `path-enumeration` climbing as a project complies with the doc standard.

Verified end-to-end on the field shape (no root repo, two member repos, one build tree gitignored
and one tracked): the aggregated ignore rules drop the gitignored tree by themselves, the declared
block drops the tracked one, coverage goes from 34 swept files to the 4 real sources with 100% now
earned, and a contract change inside a member repo exits `review --strict` at 1 where it silently
passed before.

## Field defects — Peelmeal dogfood (33–)

A 2026-08-05 field report from building Peelmeal under the gate, and the first one **measured**
rather than described: three delivery steps, six adversarial runs, ~44 minutes of review wall-clock
and ~970k subagent tokens against ~20 minutes of implementation. The gate earned its keep — two real
bugs in step 1, a tautological test in step 2, a missing negative case in step 3 — so these plans
reduce the *price* of the loop, not its bite. Every reported defect was verified against source
before planning and each first-proposed fix was adversarially refuted, which changed two of them:
the grep-the-changed-claim-across-docs idea cannot work (a doc says "hourly", the diff says
`3600_000` — no shared token), and the wrong-plan resolution is a **discovery** bug, not a
tie-break bug.

| Plan | Theme | Finding it fixes |
| --- | --- | --- |
| [33](33-review-loop-cost.md) | Delta bundles, ranked dependents, discovered test runner | Fixing a finding re-attacks the whole diff (3 full rounds on step 1); 24 unranked reason-less dependents on every run, including in the adversary's own oracle; `--test-command` re-nagged every run while the real unadjudicated-findings hole stayed silent |

## Defaults that were costing more than they protected (34–35)

Two plans about what happens when the user says nothing. Neither changes what codument checks; both
change what it makes you do first.

| Plan | Theme | Why |
| --- | --- | --- |
| [34](34-autopilot-by-default.md) ✅ **shipped** | Autopilot on by default, phrase-only opt-out | Working an approved plan end to end was opt-in behind a phrase almost nobody learned, so the shipped default was the slowest loop available — three routine confirmations per step, none asking a real question. The confirmations that matter fire on their own regardless |
| [35](35-init-scans-existing-code.md) ✅ **shipped** | `init` maps existing code in the same command | Onboarding an existing project took two commands and missing the second failed *silently*: the workflow installed, the registry stayed empty, and the gate had nothing to check — no error, just a loop owning none of your code |

34 shipped in `8a7558b`, `5359588`, `c02519f`, `ae171cf`; 35 in `fdc1b36` and the doc pass after it.
No guardrail moved in either: the plan-approval gate, the hard-pause conditions, and the step-sync
gate are unchanged, `scan` still installs nothing on its own, and both escapes are cheap — a spoken
phrase ("step by step") that holds for the session, and `--no-scan`.

Still to plan, ranked by value: shipped delivery scaffolding is never compacted out of docs (the
standard says it should be; nothing enforces it); the Decisions layer states conclusions without
naming evidence, which is how a wrong recorded decision survived two fix attempts; unmapped prose
pages are uncoverable by the gate (`orphan-doc` is scoped to `docs/features|concepts` and lives in
`doctor`, which `review --strict` never calls); an ADR named as an entry `doc` silently becomes a
`type:"concept"` umbrella and demands acks about cadence it does not describe; `steps` resolves
plans over `docs/features`+`docs/concepts` while `review` resolves them over `docs/plans`, so a plan
visible to one is invisible to the other; `context --feature` has no lean "which doc owns this file"
mode.
