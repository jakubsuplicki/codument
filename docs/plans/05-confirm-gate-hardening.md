---
status: approved
---

# Plan 05: Review-adversary confirm gate — runner hardening + soak-data hygiene

The `--require-review` gate blocks only when a finding's named test is genuinely red on a live
re-run. That makes the test *runner* part of the verdict path; today its default command undermines
the gate in three environments, and the soak telemetry the gate-flip decision depends on can be
double-counted.

## Why

Verified findings this plan fixes:

1. **The default test command is unpinned `npx tsx`** (`src/lib/review-confirm.ts:107`). In a
   project without local tsx, npx either prompts to download and execute the latest published tsx
   (unpinned third-party code on a gate's verdict path, plus a network dependency inside the surface
   README:160 frames as no-network) or, non-TTY/CI, errors — which `makeTestRunner` classifies as
   `unrunnable` → advisory → gate green (`review-confirm.ts:166-171`). So for every jest/vitest/mocha
   project the shipped default guarantees the confirm step can never block unless the user knows to
   pass `--test-command`.
2. **On Windows the confirm gate is structurally always-green.** No spawnSync in the codebase passes
   `shell: true`; since Node 18.20/20.12 (CVE-2024-27980 hardening), spawning `.cmd` shims like
   `npx.cmd`/`npm.cmd` throws EINVAL, so every named test is `unrunnable` → advisory
   (`review-confirm.ts:165-168`; also `src/lib/benchmark-quality.ts:424` spawns `npm`). Nothing in
   README/docs/engines scopes the tool to POSIX.
3. **Soak `frictionRate` inputs can be double-counted.** Drift tallies are raw counts summed across
   caught snapshots with no dedup key (`src/lib/impact-ledger.ts:106-115`; `review-events.ts:96` says
   "Provenance, not a dedup key"), unlike provable identities which ARE deduped via Sets
   (`impact-ledger.ts:94-105`). A full re-review of an unchanged diff with `--log` double-counts its
   resolved-fire tallies — and frictionRate is exactly what the info-only→blocking gate flip will be
   calibrated from. (Verified scope: only resolved fires distort, and only via cross-snapshot
   reweighting — but the hazard is unacknowledged in code or docs.)

## Scope

- `src/lib/review-confirm.ts`
- `src/lib/benchmark-quality.ts`
- `src/lib/impact-ledger.ts`
- `src/lib/review-events.ts`
- `tests/review-confirm.test.ts`
- `tests/impact-ledger.test.ts`
- `docs/features/adversarial-review-gate.md`
- `docs/features/impact-ledger.md`

Also touches root-level `README.md` (no-network framing + runner docs) — expected out-of-plan
false-fire if Plan 04 has not landed yet.

## Non-goals

- No change to the gate's blocking rule (red re-run test with TAP evidence) or to the documented
  TAP-output fail-open for non-TAP runners (that limit stays honest and documented).
- No test-framework adapters (jest/vitest reporters) — only how the command is *resolved and
  spawned*, and how "couldn't run" is surfaced.

## Decisions (settled)

- Default command resolution is local-only: use `npx --no-install tsx` (or resolve the runner from
  the project's own `node_modules/.bin`), never a network fetch on the verdict path.
- "The default command cannot run in this project" becomes a NAMED gate condition, rendered in the
  review summary ("confirm step could not run: no local tsx — pass --test-command"), not a silent
  advisory. Under `--require-review` it is still non-blocking (matching the documented fail-open
  stance) but must be impossible to miss.
- Windows: spawn npm-family commands shell-safely on win32 (`shell: true` for `.cmd` shims, args
  escaped) rather than declaring POSIX-only.
- Tally dedup: contributions are deduped by transition identity (`anchorId`, `fromHash→toHash`)
  across snapshots, mirroring the provable-line Set dedup — a transition counts once no matter how
  many snapshots observed it.

## Delivery Plan

- [x] Step 1: Local-only default command + named could-not-run condition surfaced in `review`
      human/JSON output. Tests: no-local-tsx project → summary carries the named condition; no
      network resolution attempted (`--no-install` present in the spawn args). (Shipped addition:
      availability probes local `node_modules/.bin` first, then asks npx itself on a miss, so a
      hoisted/global runner never triggers a false warning.)
- [x] Step 2: win32-safe spawning for npm-family commands in `review-confirm.ts` and
      `benchmark-quality.ts` (guard by `process.platform`, keep POSIX behavior byte-identical).
      Unit-test the command-construction helper on both platforms' code paths.
- [ ] Step 3: Dedup drift-tally contributions by transition identity in the ledger aggregation;
      document the snapshot semantics in `impact-ledger.md`. Tests: logging the same resolved diff
      twice yields identical tallies to logging it once; distinct transitions still accumulate.
- [ ] Step 4: Doc sync — `adversarial-review-gate.md` honest-limits section and README's runner
      paragraph reflect the new resolution + named condition.

## Outcome

The confirm step can no longer fetch unpinned code, silently no-op on non-tsx projects, or
always-pass on Windows — when it cannot run, it says so where the human decides. The soak data the
gate flip will be calibrated from becomes idempotent under re-review. What it does NOT do: make
non-TAP runners blockable, or change when the gate blocks.

## Acceptance criteria

The three "Why" scenarios produce the decided behaviors; re-logging an unchanged resolved diff does
not move `frictionRate`; POSIX spawn behavior is unchanged (existing tests untouched and green).

## Verification

`npm test`; `npm run typecheck`; live: a scratch project without tsx shows the named condition in
`review --require-review` output; `review --log` twice → identical soak line in `watch`.
