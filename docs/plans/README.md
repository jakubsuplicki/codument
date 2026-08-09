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

## Field report — Expo app dogfood (36–39)

A 2026-08-07 field report from building an Expo app under the gate — the first to answer "what
would you keep": the doc standard and the invariant→test rule found the session's real bugs (a
vacuous placeholder check, a UTC-midnight date bug, three contract divergences found while writing
prose), the plan survived a context compaction and a session kill, and mandatory review caught
what nothing local could. The friction list drove these plans; every mechanism was verified
against source first.

Verification sharpened the worst item: the multi-owner churn is a **routing** defect, not a
design defect — the designed resolutions (`owned_symbols` claims, `related_sources` demotion)
exist and were never surfaced at the wake, while `codument ack` recorded acks for unassigned
shared symbols that drift never consults: a green checkmark over a red gate. Two reported items
dissolved on verification: file acks refusing moved symbols is ADR 012 working as decided, and
the "luck" that kept 240 generated locale files ungoverned is the source-extension spec working
as designed — the missing piece was recorded intent (plan 27's `exclude` block), which is
guidance, not mechanism.

| Plan | Theme | Finding it fixes |
| --- | --- | --- |
| [36](36-shared-file-ownership-resolution.md) ✅ **shipped** | Shared-file ownership churn: resolution block, ownership-aware ack refusal, materialize warning | "Worst part by far": N stale docs per one-line edit, no ack clears it, prose written into five docs to buy green; inert acks recorded on unassigned symbols |
| [37](37-brownfield-charter.md) ✅ **shipped** | Brownfield charter: derive from code, confirm in one message | Charter gate interviewed a shipping app through datastore/auth/hosting its code settled months ago |
| [38](38-fan-out-step-sizing.md) ✅ **shipped** | Fan-out step sizing: skill rule + adversary objection class | "Generate twelve locales" as one step — ~35 agents, blown session, nothing flagged it before approval |
| [39](39-field-polish.md) ✅ **shipped** | Field polish: generated-artifact intent, Windows invocation fallback, single-anchor render collapse, verdict-last line, touched-section rule for legacy docs, `ack --prune` | The report's practical notes plus the two-register clash and dead-ack accumulation (342 acks, 52 auto-invalidated, nothing sweeps them) |
| [40](40-registered-file-governance.md) ✅ **shipped** | Registration is governance: file-grain wake for registered files no adapter judges | **Structural false green** (probes B and D, both reproduced live): rewriting a registered locale/contract file counted "0 source, 1 other" and exited 0; deleting one printed "1 deleted" and exited 0 with no advisory at all |
| [41](41-rename-honesty-registry-integrity.md) ✅ **shipped** | Rename honesty + registry-pointer integrity + post-ship materialize | Probe C: `git mv` on a registered source is add-only to the gate, leaves a permanent ghost in `primary_sources` nothing reaps (doctor's `missing-source` warn lives where the loop never looks), and `map materialize` is unreachable after plan compaction — two mandated behaviours disabling each other |

Two follow-up interrogations of the reporting session (registry pastes, `ack --list`, transcript
grep, live probes B/C/D) confirmed the unassigned-shared-symbol mechanism, corrected one
mislabelled file, and rewrote the ranking. The ownership signpost had fired **25 times** and was
ignored because of *placement* (an advisory block below the blocking line); the stale-docs hint
recommended file-grain acks that structurally cannot clear unassigned changed anchors (two
accumulated, one dead). Probe B surfaced the plan-40 false green; probes C and D surfaced the
plan-41 rename/ghost-pointer cluster and confirmed deletion blindness live. The reporter's
exit-code complaint dissolved (`--strict` returns 1 correctly; their `$?`-after-`tail` reading
was the error — plan 39's verdict-last line still meets the habit halfway), and the bunx failure
was pinned to bun's own argument marshalling (arity equals the quoted value's word count),
filable upstream. Two watch items, no plan: `related_sources` is exercised by exactly two entries
in the field repo, both created that session, so the impact-only rule has near-zero field
mileage; and entry `status` is authored metadata nothing maintains (routed to plan 39's
update-docs line).

**36 is shipped too** (`682a1f7`, `d8f0cc5`, `661bb4b`, `d274174`, and its doc pass). No wake or
ack semantics moved — every existing gate-wiring and drift assertion passes unmodified — because
the defect was never the wake. Waking every candidate is what derived-first ownership chose over
guessing an owner; what failed is that the two registry edits ending it printed as an advisory
below the blocking line, the stale-doc hint recommended a file ack that structurally cannot clear
an unclaimed changed anchor, and `ack` recorded inert acknowledgments while printing a green
checkmark. The resolution now renders inside the finding, every hint is computed from what would
actually clear it, `ack` refuses and routes, and `map materialize` warns at the moment a second
feature claims a file — where the churn is created rather than where it is finally paid for.

**36 was then reopened and closed again** (`6eeaf9d`). An adversarial pass over the whole
post-41 range confirmed four findings out of twelve; three of them land here, sharing one root:
the new resolution block is computed per FILE and printed under every doc that file woke,
consulting neither how the anchor moved, nor which doc it prints under, nor which of the two
ownership shapes fired. So it denied an ack that works for an added symbol — three lines under
where it printed that very ack; it attached itself to concept umbrellas, whose file-grain wake
`owned_symbols` cannot fix, and took away the file ack that does clear them; and its `--strict`
summary told a doubly-claimed symbol to claim itself again. The plan's own criterion — *no
output anywhere suggests an ack that cannot clear the wake* — held in the direction it was
written and failed in the other. The fourth finding is plan 39's verdict line, fixed in the same
commit: it counted findings only under `--strict`, so a bare run signed off `clean` over stale
docs it had just listed.

**39 is shipped** (`65c6091`, `6eeaf9d`, `ff4b563`, `e4e3734`). The bunx failure was narrowed
during step 2 and is not about codument at all: `bunx --yes prettier --check "one two three"`
reports three missing patterns where `npx` reports one, on bun 1.2.19 / Windows 11, identically
from PowerShell and Git Bash — bunx's download-and-run path specifically, since a bin already in
local `node_modules` keeps its quoting. Filing that upstream posts publicly and is left for the
maintainer; the shipped guidance is symptom-keyed and carries no issue link until one exists.

Run 40 first — a false green on explicitly-claimed files beats every ergonomic fix, the same
ranking plan 28's workspace false green got. Then 41 (silent corruption of the control plane the
gate itself reads), then 36 (the report's "worst part by far", now with the placement and hint
fixes the follow-up demanded). 37–39 are independent and in any order.

**40 and 41 are shipped, 41 the long way round.** 40 (`3d50d97`, `1d2543c`, `e6cd910`) closed the false green at its root:
a registered file no adapter can parse now gates at whole-file grain — edits and deletions alike —
clearable by doc attention or a file ack, with `related_sources` still never waking and the
exclusion spec still overriding registration, both now worded apart (ADR-017). 41 (`ad64ca0`,
`fe46639`, `a842ee2`, `4c931e3`) made a rename visible on both sides: the listers report `{from,
to}` pairs instead of discarding the origin, a change that strands a registered path holds
`--strict` red until the entry stops naming it, and `map materialize --feature <slug>` gives
post-ship files a route that does not depend on a compacted-out Map. Implementation found one thing
the plan had not: a pure rename was reporting every symbol as *added*, which both lied and forced a
doc edit for a change that moved no contract — base-side anchors now read from where the file
actually lived, so a pure rename fires nothing and a rename-plus-edit reports exactly what moved.

A three-lens adversarial pass over those four commits then confirmed ten findings against them, so
41 went back to `approved` with a remediation checklist rather than staying marked shipped over
known blockers. Three roots: the rename map reached only one caller (so `review` printed an ack
that `ack` refused, and the rename-aware read never left the precise grain); a pair git labels a
rename was trusted without checking that the origin was gone (a copy, or a `git mv` plus a
re-export shim, made `--strict` unsatisfiable); and the new blocking finding was never added to
SARIF, the watch verdict, or the HTML report, so CI uploaded a clean-reading SARIF while the check
exited 1. Four remediation steps (`33323af`, `d8cdba1`, `a3d3b85`, and this doc pass) closed all
three, each fix mutation-tested individually. The full triage — including the five refuted
findings and the two gaps deliberately left as future work — is in the plan's own post-ship
remediation section.

The lesson is about the review, not the code: plan 41's four steps were committed without an
adversarial pass, against a repo whose own workflow mandates one, and the pass found a blocker in
the most safety-critical code here. Every defect it caught was introduced by a fix, and the two
worst were introduced by the fix for the plan's own headline finding — which is the argument for
the gate stated as plainly as it gets.

**42 is shipped** (`caa058f`, `be48c31`, `1a822a5`, `81c8d35`, `a64801b`, and this doc pass). The
second interrogation of the same Expo app, run after 0.15.0, got the answer the first one never
reached: asked which prose it wrote mainly to clear the gate, the agent named a type union it had
been maintaining by hand inside a code fence — a symbol mirror the standard forbids, kept fresh
because the gate went red and no ack existed. The tool was compelling in one surface what it
forbids in another, and the lint that names that smell skips fences by design.

Six steps closed that and three neighbours: the file-ack route is now decided per doc rather than
per file (it was wrong in both directions at once — withheld from an umbrella it would clear,
offered to the owner it cannot), a signature-move denial names the registry escape instead of
leaving prose as the only exit, `doctor` reports a `fenced-mirror` smell and discloses scaffolds
the tree has moved past, and `commit-work` runs `doctor` once per plan.

Three of the defects fixed here came from attacking the work, not from the report — and the
sharpest was that **every per-symbol ack command codument has ever printed is a shell syntax
error**: `foo().` bare is a bash parse failure and `<module>` is a redirection. The field report
could not see it because the agent quoted the anchor reflexively and never noticed it was doing
the tool's job. The lesson generalises the one from 41: a report tells you where it hurt, and the
worst defects are in what the reporter silently worked around.

**43 is shipped.** The other half of the same report, and the largest ungoverned surface it
produced: six language packs — 120 files, about 5,400 user-visible strings — landed reporting as
`60 other`, exit 0. Not a false green in ADR 017's sense, because nothing claimed those files.
They were unclaimed because claiming them meant typing 380 paths by hand, and answering for a
correction pass across them meant 27 signatures. The 380 registry lines and the field repo's 345
acknowledgments are the same missing unit: there was no way to say "this tree is one governed
thing".

A `primary_sources` entry may now name a tree, it wakes once with a count, and one `ack <pattern>`
answers for it — judged whole, so one file moving or a new file appearing spends it, and honored
only for a tree some entry actually declares. ADR 018 records it.

Two of the four steps' defects came from attacking the work rather than from the report, and the
larger one was not in the new code: `doctor` had never learned that a source can be a pattern, so
a correctly-registered tree scored 0% ownership and produced a false finding per file. A lint
about trees shipping beside three findings denying trees are registrations would have been worse
than shipping neither. The other was a literal NUL byte written as a hash separator, which made
git classify the acknowledgment module as binary — the central file of the change had no
reviewable diff at all, in that review or any later one.

**44 is shipped.** The remainder, and one shape seen three times: two surfaces of the same tool
answering the same question differently, with the user finding out. The changed-file headline
counted every path while every bucket beside it filtered the exclusion spec out, so editing a test
file printed a line that did not add up. `steps` and `map materialize` discovered plans under
`docs/features|concepts` while the gate read `docs/plans`, so on this very repository both refused
with "no approved plan" on the line before `review` reported that plan's scope — from instructions
the documented workflow gives. And a registry naming a file that does not exist was known only to
`doctor`, never to the surface the loop runs every step, though every ownership answer and every
adversary grounding is derived from it; it is now reported and deliberately never gated, because
failing on state the change did not create is how a gate gets bypassed.

Fixing the headline surfaced its sibling: `watch` called a tests-only change "working tree clean",
the same false-clean the gloss already guarded against for config and asset files.

**45 is shipped.** The tail of the same report, and one theme: codument failing rules codument
enforces. `update` wrote a backup on an upgrade where the two sides had converged, so every upgrade
layered untracked litter into a repository from the tool whose subject is not leaving mess in one.
Nothing checked the compaction the standard is most explicit about, so this repo obeyed it only by
hand. A Decisions layer could assert a conclusion citing nothing — the shape that let a wrong
recorded decision survive two attempts to fix what it was wrong about. And the loop's most frequent
question, which doc owns this file, cost a full context pack, which is how it becomes a guess.

Fixing the third surfaced the worst defect of the release: section awareness in the altitude lint
had never worked on a CRLF checkout, so the exemptions the calibration depends on were dead and
`path-enumeration` was firing on Key files sections *because* they comply.

Still to plan, ranked by value: unmapped prose pages are uncoverable by the gate (`orphan-doc` is
scoped to `docs/features|concepts` and lives in `doctor`, which `review --strict` never calls, and
widening it needs a decision about which trees are expected to be owned); an ADR named as an entry
`doc` silently becomes a `type:"concept"` umbrella and demands acks about cadence it does not
describe; and the field report's claim that a review-bundle delta named a file that did not move
could not be reproduced from the code — it stays open, named as unreproduced rather than fixed on a
guess.
