---
title: Change-control gate
status: current
type: feature
owner: ""
primary_sources:
  - src/commands/review.ts
  - src/commands/watch.ts
  - src/commands/ack.ts
  - src/commands/demo.ts
  - src/commands/report.ts
  - src/lib/change-state.ts
  - src/lib/fingerprint.ts
  - src/lib/ts-adapter.ts
  - src/lib/two-ref.ts
  - src/lib/ownership.ts
  - src/lib/import-graph.ts
  - src/lib/drift.ts
  - src/lib/co-movement.ts
  - src/lib/acknowledgment.ts
  - src/lib/events.ts
  - src/lib/git.ts
  - src/lib/report-html.ts
related_sources: []
docs: []
depends_on:
  - cli
  - commands
  - lib
risk: []
last_reviewed: 2026-07-01
---

# Change-control gate

## In plain terms

This is the safety check that catches a doc going stale the moment the code it describes moves. When an agent (or a person) changes a symbol but leaves its owning feature doc untouched, the gate flags it; the agent then resolves it inline as part of the same change. Three resolutions: update the doc at intent altitude; record a one-line **per-symbol acknowledgment** that a moved symbol was a contract-neutral refactor; or — for a purely additive change (a new exported helper) or a concept doc with no single symbol to point at — a **file-grain acknowledgment** (`ack <path>`) that the file's current content owes no doc change. `review` is the snapshot you run against a diff; `watch` is the live terminal view of the same signal while work happens. The whole point is that correct docs fall out as a byproduct of the work, with no separate chore.

## Design approach

The gate is split into two parts that must not be confused: a **deterministic enforcer** and an **optional LLM/agent assist** layered on top.

**The enforcer is deterministic, LLM-free forever, and CI-reproducible.** It proves one thing structurally: a documented symbol *moved* and its owning doc did *not*. It never asks whether prose is true. We detect movement by **structural symbol comparison** across two git refs, fingerprinting each exported declaration's token stream. Two alternatives were rejected. **Name-matching** (does the doc mention the symbol's name?) over-fires on renames, default exports whose name never appears in prose, and symbols named like common words, so it can never be the verdict. **Review-by-date** (a freshness timer or a `last_updated` field) is gamed by bumping a date or touching a blank line and is blind to a same-day rewrite, so the clock is excluded from the verdict entirely.

**The assist sits inside the enforcer under one rule: never trust its claim, always verify its result.** The agent is the right judge of "does the doc still describe this correctly" because it can read both the symbol and the doc; a regex cannot. So the agent reconciles each flag, and the gate re-verifies only the *form* of what it produced (an acknowledgment exists, is attributed, and names the exact moved fingerprint), never its semantic judgment. Resolution is the agent's job inline, autopilot-aligned, with a human pulled in only on a genuine judgment call or a sensitive change.

**Symbol-grained ownership is what makes the signal trustworthy at scale.** A file-grain signal cascades: a shared file with many owners flags every owning doc on a one-line edit, and the noise trains people to ignore it. Here, a changed symbol wakes only its owning feature's doc. Ownership is derived from primary ownership with zero authoring for the common single-owner file; only a file genuinely split across several features carries a per-symbol owner map, and the gate fails loud rather than silently waking all co-owners.

## Invariants & boundaries

- **The verdict is a pure function of `(base, head, codument version, algoStamp)`** and reproducible byte-for-byte across runs, machines, line-ending and BOM differences, and Node versions. No `now()`/clock value enters it. *(test: two-ref.test.ts — algoStamp embeds the exact TS version + algo version and is deterministic; byteNormalize folds CRLF/BOM; fingerprint.test.ts asserts cosmetic-only churn is `unchanged`)*
- **The fingerprint is invariant to mechanism-only churn but catches real change.** Reformatting, comments, declaration reordering, CRLF/LF, and a leading BOM do not move an anchor; a body edit, an intra-string-literal change, or `0x10` vs `16` does. *(test: ts-adapter.test.ts — token-stream invariance, order-independent identity, the `0x10`/`16` and string-literal cases)*
- **The LLM is never on the verdict path.** Structural movement and the stale-doc verdict are computed with no model; the assist only labels findings and proposes resolutions. *(test: drift.test.ts and gate-wiring.test.ts compute the verdict purely from anchor changes; honest boundary — the enforcer carries no model call)*
- **Co-movement is never a verdict input.** It is info-only telemetry — a soak signal measuring its own false-fire rate — and never clears or trips the gate. *(test: co-movement.test.ts classifies the signal in isolation; drift.test.ts surfaces it on findings without it changing `staleDocs`)*
- **An acknowledgment auto-invalidates when the anchor moves again.** It is bound to the exact `from`→`to` transition, so a later move produces a `to` no prior ack matches — no ride-forever exemption. *(test: acknowledgment.test.ts ackCovers auto-invalidation; ack.test.ts and drift.test.ts re-move re-fires the gate end-to-end)*
- **The gate verifies an ack's form, never its semantic truth.** It checks the ack exists, is attributed (non-empty fields), and names the exact moved fingerprint; code/doc equivalence is undecidable and the gate never claims to decide it. *(test: acknowledgment.test.ts parseAck rejects empty/missing fields and ackCovers requires the exact anchor + transition)*
- **A file-grain ack (`ack <path>`) clears a file's additive / concept / coarse staleness, and NEVER masks a moved symbol.** A bare-path ack binds the file's content fingerprint (so it auto-invalidates on the next change) and clears the added/removed-symbol, concept-umbrella, and coarse/non-TS contribution a per-symbol ack cannot reach; a `changed` (moved) owned symbol still wakes its feature, so a real contract change is never laundered. The converse holds with the same force: a per-symbol ack adjudicates ONE feature contract and never clears a concept umbrella's file-grain flag — the umbrella wake is judged on the pre-ack movement, so it stays flagged until a file-grain ack or a doc update resolves it. *(tests: change-state.test.ts file-grain ack honoring — additive/concept/coarse cleared, moved symbol never masked — and "concept umbrella vs per-symbol ack"; ack.test.ts "a per-symbol ack never clears the concept umbrella" end-to-end)*
- **A file-grain ack counts AS an ack, never as a doc update.** The resolution summary and the soak friction tally bucket it on the no-doc-change-owed side (a distinct `file-acked` line), so over-acking stays visible and the friction rate — the info-only→blocking soak signal — is not deflated by file acks. A parse-unevaluable file cannot be file-acked into freshness (the fail-loud stance holds). *(test: impact-ledger.test.ts friction counts a file ack on the ack side; ack.test.ts refuses an unevaluable file; review output shows `file-acked (additive)`)*
- **A signature change is the highest-signal behavior proxy and should be ineligible for the ack fast-path** (a doc update is owed). This is a named, deferred hardening: anchors are body-inclusive today, so signature-vs-body ineligibility is not yet enforced — honesty rests on the visible ack-rate and the audit trail until anchors split. *(untested — deferred enhancement)*
- **A born-wrong or already-drifted doc is out of scope.** The gate enforces code/doc *co-movement*, never prose *correctness*; only anchors that moved within the two-ref window are evaluated, so pre-existing drift is grandfathered by construction. *(honest ceiling — the label-noise limit)*
- **Non-TS files are never un-gated.** TS gets precise per-symbol anchors; every other file (and `.d.ts`, generated, barrel, `export =`, namespace-only, parse-error, side-effect-only TS) falls back to a coarse whole-file content hash on file grain. A file that fails to parse is surfaced as un-evaluable and gated file-grain, never read as fresh. *(test: ts-adapter.test.ts classifyTsFile precise|coarse|unevaluable; gate-wiring.test.ts file-grain fallback for coarse and parse-error files)*
- **Ownership comes from primary ownership only; related impact never confers it, and a shared symbol no feature claims fails loud** (wakes all candidates and lints) rather than silently waking everyone. *(test: ownership.test.ts derived-first + unassigned/ambiguous; gate-wiring.test.ts cascade dissolution and fail-loud on unresolved shared symbols)*
- **Concept umbrellas wake at file grain and never fragment a feature's per-symbol ownership.** A file owned by one feature plus any number of concept umbrellas still resolves derived. *(test: ownership.test.ts concept co-owner does not fragment; gate-wiring.test.ts concept umbrellas wake at file grain)*
- **`review` and `watch` cannot disagree.** Both derive from one pure change-state analyzer over the same git-extracted change set. *(test: review.test.ts a passed-in change set equals the self-computed report; watch.test.ts renders the same shared state)*
- **Plan approval is one shared predicate with `steps`.** Out-of-plan detection reads a plan as approved only when its markdown-stripped status equals `approved` exactly: an explicitly rejected plan ("not approved") never gates scope, and any status spelling that drives `steps` enables out-of-plan detection here too — the two surfaces cannot disagree about the same plan. *(tests: change-state.test.ts "detectApprovedPlanScope — one approval predicate with steps"; plan-steps.test.ts "an explicitly REJECTED plan is never approved")*
- **The two-ref base is single and printed**, with the empty tree when refs share no common ancestor and fail-closed on an unreachable base. *(test: two-ref.test.ts resolveBase — single merge-base, empty-tree fallback, unreachable-base GateError)*
- **A gate that cannot run fails closed, never green.** Whenever the gate cannot see the repo — outside a git repository, an unreachable base, or git itself failing (a broken invocation, or change output too large for the default subprocess buffer) — the change-listing paths raise rather than return empty, and `review --strict`/`--require-review` exit nonzero with a "gate could not run" diagnostic instead of "Working tree clean"; bare `review` stays informational. The `--json` contract is discriminated so no consumer reads a missing verdict as a pass: `gate: "ok"` carries the verdict; whenever the gate itself cannot run (no repository, unreachable base, git failure, wrong root) the same channel emits parseable JSON with `gate: "unavailable"` and a reason — a null verdict is never emitted. An unreadable state file or a bad `--record` input renders its own fail-closed human diagnostic instead (always nonzero, so still never a silent green). The live monitor (`watch`) is the one exception that degrades rather than exits: a transient git failure keeps the last good frame. *(tests: review.test.ts "review in a non-git directory (fail closed)" and the subdirectory `--json` case; git.test.ts "git change-listing fails closed")*
- **Deleting an owned source is a first-class change, not an invisible one.** A removed primary source wakes every owner — feature and concept — at file grain, resolved against the registry *as of the base*, so removing the file's registry entry in the same change cannot dodge the wake. No acknowledgment clears a deletion (per the ack-scope decision's conservative stance): the resolution is doc attention — an update, or the doc's own removal alongside its feature. A deletion-only tree is never "clean", and `--strict` fails while the owning doc is untouched. *(tests: change-state.test.ts "deletions first-class" — wake, no-ack, base-registry dodge, wholesale-removal; review.test.ts "deletions are first-class in the verdict" — worktree, `--base`, and `--strict` exit codes)*
- **A gate that would answer the wrong question refuses to answer at all.** Run from a subdirectory of a repository, git reports toplevel-relative paths that can never match the registry — every file would read unmapped and every doc fresh: a *wrong* verdict, not an absent one. So every surface that computes or persists this verdict — `review`, `watch`, and the shareable `report` — asserts the root is the repository toplevel at startup (canonical-path compare, so a symlinked or differently-cased spelling of the true toplevel is never falsely refused) and exits nonzero naming both paths and the fix, with no informational fallback: unlike the non-git case, even bare `review`, `watch --once`, and `report` refuse. Monorepo package roots are thereby honestly unsupported rather than silently wrong. *(tests: review.test.ts "review from a subdirectory of a repo (fail closed)"; watch.test.ts "errors loudly from a subdirectory of a repo — even under --once"; report.test.ts "refuses a subdirectory root"; git.test.ts "assertRootIsRepoToplevel (real git repo)")*
- **Every changed path enters the verdict byte-exact, whatever its encoding.** Change listing reads git's machine framing rather than its human display, so a filename outside ASCII or bearing a space (`src/föo.ts`, a CJK name) is matched against the registry as written instead of being escaped, garbled, and silently misread as unmapped while its owning doc reads fresh. The framing also removes the rename-arrow ambiguity, so a rename reports its post-rename path as the change. *(tests: review.test.ts "a changed non-ASCII / CJK registered source is owned and flags its doc stale, never unmapped"; two-ref.test.ts "changedPathsBetween: -z path decoding and rename ordering")*
- **The showcase never destroys a directory it did not create.** `demo` recreates its target each run, so it refuses any populated directory it cannot prove is its own; an empty, nonexistent, or prior-demo `--dir` proceeds, a real project pointed at `--dir` is left untouched. *(test: demo.test.ts — a populated foreign --dir is refused and left intact; a repeat run against demo's own dir succeeds)*

## Decisions

- Deterministic, reproducible, LLM-free verdict — [003-deterministic-reproducible-gate.md](../architecture/decisions/003-deterministic-reproducible-gate.md)
- Symbol-grained, derived-first ownership — [004-symbol-grained-derived-first-ownership.md](../architecture/decisions/004-symbol-grained-derived-first-ownership.md)
- Co-movement demoted to info-only telemetry — [005-co-movement-info-only-telemetry.md](../architecture/decisions/005-co-movement-info-only-telemetry.md)
- Agent-judge resolution: self-resolve with a durable audit trail — [006-agent-judge-resolution-self-resolve-with-audit-trail.md](../architecture/decisions/006-agent-judge-resolution-self-resolve-with-audit-trail.md)
- Freshness resolution: detect deterministically, verify by tests, resolve agent-driven — never by symbol-name matching — [010-freshness-resolution-detect-test-verify-agent-driven.md](../architecture/decisions/010-freshness-resolution-detect-test-verify-agent-driven.md)
- File-grain acknowledgment: conservative (never masks a moved symbol), binds file content, over-acking stays visible — [012-file-grain-acknowledgment-conservative-additive-residue.md](../architecture/decisions/012-file-grain-acknowledgment-conservative-additive-residue.md)

The info-only → blocking flip is **soak-data-dependent and not yet made**: the false-fire threshold and soak window come from live `events.jsonl` data, so it cannot be finished without real soak time. The gate is TS-precise today with non-TS on the coarse hash; second-party independence on an ack is an opt-in strict mode, deferred.

## Key files

- `src/commands/review.ts` — the snapshot orchestrator: resolves the base, gathers the change set, runs the analyzer, and renders each drift finding as a two-arm fork (update the doc, or run the printed `ack` command) with a per-run resolution summary.
- `src/commands/watch.ts` — the live view: the same analyzer rendered on a cheap refresh loop, tailing the event log so you can watch the gate while the agent works.
- `src/commands/ack.ts` — the reachable agent-judge surface: turns a copy-pasteable command (a `<path>::<symbol>`, a unique bare symbol name, or a bare `<path>` for a file-grain ack) into a fingerprint-bound, audited acknowledgment, recomputing the transition itself so no fingerprint is ever copied; the file-grain form guides on any moved symbol it does not cover.
- `src/commands/demo.ts` — the showcase driver: builds a throwaway fixture and runs the full gate so the machinery (caught / auto-fixed / surfaced) is visible end to end.
- `src/commands/report.ts` — emits the shareable static HTML report of a review.
- `src/lib/change-state.ts` — the pure analyzer at the centre: turns a registry plus a change set (and optional per-file anchor changes) into the deterministic stale-doc verdict; backs both `review` and `watch`.
- `src/lib/fingerprint.ts` — the adapter seam and the anchor-diff engine: binds identity to a content fingerprint, dispatches TS to the precise adapter and everything else to coarse, and diffs anchor sets across two refs.
- `src/lib/ts-adapter.ts` — the precise TypeScript engine: per-exported-symbol token-stream fingerprints, SCIP-shaped order-independent identity, transitive closure over referenced private helpers, and the residual module backstop.
- `src/lib/two-ref.ts` — the determinism plumbing: ref-blob reads, byte-normalization, single-base resolution, deletion-first-class path classification, and the algo stamp. Also exposes the merge-base deletion view the [adversarial-review gate](adversarial-review-gate.md) consumes.
- `src/lib/ownership.ts` — the ownership resolver: maps an anchor to its owning feature, derived-first, fail-loud on unassigned/ambiguous shared symbols.
- `src/lib/import-graph.ts` — first-party import harvesting from the same parse: seeds shared-file symbol ownership and feeds the facts/graph data contract.
- `src/lib/drift.ts` — the per-symbol drift layer: builds precise findings annotated with co-movement telemetry and whether a recorded ack adjudicates the move.
- `src/lib/co-movement.ts` — the info-only telemetry classifier: the symbol-scoped "did the doc lines mentioning this symbol move?" proxy, with frontmatter and link-URL churn stripped.
- `src/lib/acknowledgment.ts` — the acknowledgment protocol: parse/validate, fingerprint-bound coverage, auto-invalidation, and the loose reviewable on-disk files.
- `src/lib/events.ts` — the append-only flow-event log that records every caught / auto-fixed / surfaced action as both the audit trail and the soak's calibration data.
- `src/lib/git.ts` — git access for the analyzer, shelling out to the required `git` CLI with lock-churn suppression for polling. Also exposes the working-tree deletion view the [adversarial-review gate](adversarial-review-gate.md) consumes.
- `src/lib/report-html.ts` — the self-contained HTML renderer for the report surface.
