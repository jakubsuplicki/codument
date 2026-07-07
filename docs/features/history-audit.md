---
title: History audit
status: current
type: feature
last_reviewed: 2026-07-07
---

# History audit

## In plain terms

`codument audit <base>..<head>` scores doc drift over committed history: for each documented
feature, did an owned source move somewhere in the range while its owning doc got no attention in
the same range? It is the live gate pointed backwards — the same question `review` asks of the
working tree, asked of any two refs. Because it reads the registry as it sits on disk, a repo that
has adopted nothing can run `scan` and then audit its own history in two commands, and read the
damage report before deciding whether to adopt the workflow.

## Design approach

The engine deliberately owns no verdict logic. It resolves the range with the same two-ref
primitives the gate uses (merge-base semantics, so commits merged in from elsewhere are not
misattributed to the range; no common ancestor degrades honestly to "everything is new"), gathers
per-symbol anchor diffs between the two committed refs with the same classification discipline as
the live gate (only files the precise adapter can fully anchor get per-symbol treatment; the rest
fall back to whole-file grain; a parse-broken file is surfaced, never trusted), and hands
everything to the same pure analyzer the gate runs. One analyzer, two lenses — the audit and the
gate structurally cannot disagree about what counts as drift.

Two departures from the live gate are deliberate. Deletions include a rename's old path, so a
renamed-away owned source still wakes its owner rather than vanishing from governance. And
acknowledgments do not apply: an ack adjudicates the live working tree against its review base,
and local `.codument/` state is not part of committed history — there is no recorded adjudication
of an arbitrary historical range to honor, so the audit reports raw co-movement drift.

The command is informational by contract: findings never change the exit code, and the `--json`
shape carries the counts first-class so anyone who wants a threshold builds it themselves. Only an
audit that could not run exits non-zero, because "could not look" must never read as "no drift".

## Invariants & boundaries

- Drift is resolved per symbol, exactly as the live gate resolves it: a moved symbol whose owning
  doc changed in the same range is not reported; the same move with the doc untouched is. *(tests:
  `history-audit.test.ts` "reports a moved symbol whose owning doc did not change in the range" /
  "does not report a move whose doc was touched in the same range")*
- A cosmetic-only edit (no anchor moved) never fires. *(test: `history-audit.test.ts` "does not
  report a cosmetic-only edit")*
- Deletions are first-class and dodge-proof: a deleted owned source is reported against the
  registry as of the base ref, so removing the file's registry entry in the same range cannot hide
  it; a rename's old path counts as a deletion. *(tests: `history-audit.test.ts` "reports a deleted
  owned file even when its registry entry was removed in the same range" / "treats a rename's old
  path as a deletion")*
- A parse-broken file at head is surfaced and audited whole-file — never silently read as fresh.
  *(test: `history-audit.test.ts` "surfaces a parse-broken file and still audits it file-grain")*
- The audit is a pure function of (base, head, repo state, algo stamp): no clock, sorted
  throughout; the `--json` output is byte-identical run over run. *(tests: `history-audit.test.ts`
  "is deterministic" / "--json emits the version-tagged contract, byte-identical across runs")*
- Findings never change the exit code; a could-not-run (bad range, no repo, unreachable ref,
  broken git read) always exits non-zero, and under `--json` it is a discriminated
  `{ audit: "unavailable", reason }` shape, never human text. *(tests: `history-audit.test.ts`
  end-to-end suite)*
- The registry is read as-is from the working tree and never authored or modified here — an
  uncommitted `scan` registry is a first-class input, reported with an honest "doc never
  committed". *(test: `history-audit.test.ts` "audits history against an uncommitted registry")*

## Decisions

- One analyzer for the gate and the audit, rather than a second historical drift definition — the
  determinism contract and the single-freshness-definition stance this extends are recorded in
  [003-deterministic-reproducible-gate](../architecture/decisions/003-deterministic-reproducible-gate.md)
  and [004-symbol-grained-derived-first-ownership](../architecture/decisions/004-symbol-grained-derived-first-ownership.md).
- Ranges are refs only — no date-based ranges, which would put wall-clock on a deterministic
  surface.

## Key files

- `src/lib/history-audit.ts` — the engine: range resolution, two-ref anchor gathering, the join
  against the registry, per-entry attribution.
- `src/commands/audit.ts` — the CLI: range parsing, human rendering, the `--json` contract, the
  informational exit-code contract.
