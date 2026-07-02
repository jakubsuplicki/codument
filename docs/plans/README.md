# Plans — 2026-07-02 full review

Fifteen plans from the 2026-07-02 adversarially-verified full review (46-agent review; every defect
was verified against source, most reproduced live against the built CLI). Plans 01–07 fix confirmed
defects; plans 08–15 are the recommended upgrades from the strategy lens. Each plan is
self-contained: a fresh session can execute it with no other context, and every product decision is
pre-settled in its Decisions section (adjust at approval, not mid-run).

## How to run one plan

1. Flip exactly **one** plan's frontmatter from `status: draft` to `status: approved`.
   Keep the others draft — the out-of-plan gate keys off the first approved plan by filename
   (`src/lib/change-state.ts` reads this directory), and multiple approved plans tie-break silently.
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

Known limitation until Plan 04 lands: the scope parser drops root-level paths (no `/`), so edits to
`package.json` or `README.md` will be flagged out-of-plan even when a plan legitimately covers them.
Treat those specific flags as expected noise in Plans 01–03 and say so in the review notes.
