---
status: shipped
---

# Plan 06: First-run experience & resolution guidance

A newcomer's first ten minutes currently contain three self-inflicted contradictions: doctor warns
about the tool's own fresh scaffolds, review suggests an ack command that ack rejects, and the
installed hook can error on every edit. Each is small; together they burn exactly the trust the
product sells.

## Why

Verified findings this plan fixes (all confirmed, most reproduced live):

1. **`init → scan → doctor` immediately fires warnings against fresh scaffolds.** scan writes every
   entry with status `needs-review`; `isMatureEntry` exempts only draft/planned/proposed
   (`src/lib/registry.ts:35,49-50`), so seconds-old scaffolds trip `empty-depends-on` (3 warns,
   dependency ratio 0%, headline 50% on a fully-owned repo — reproduced live), and `doctor --strict`
   in CI fails from minute one. Inconsistent with the thin-doc lint in the same file, which exempts
   `needs-review` as "a scaffold or in-flight doc" (`src/lib/analyze.ts:489-492` vs `:531-539`).
   Worse, README's fix row says "confirm there are none" but no confirm mechanism exists — a leaf
   feature with genuinely zero deps can never honestly clear the finding (the foundation exemption
   requires inward edges).
2. **`review` suggests a per-symbol ack for added/removed symbols that `ack` then rejects.**
   `review.ts:551-557` renders the same two-way guidance for every unresolved finding regardless of
   kind; running the suggested command for an `added` symbol fails with "was added, not changed…"
   (reproduced live end-to-end), and that error doesn't mention the actual documented resolution
   (file-grain ack, README:225,233). The tool's core resolution loop contradicts itself.
3. **The installed Claude hook hard-errors on every Write/Edit when codument isn't in local
   node_modules.** init writes the cwd-relative command `node node_modules/codument/dist/hooks/…`
   with no existence check (`src/lib/claude-settings.ts:1-3`); npx-cache-only or global installs get
   a MODULE_NOT_FOUND stack + exit 1 on every edit (verified live). In the parent-cwd/monorepo case
   the hook silently never runs instead. Silent-write of an unvalidated install-dependent hook.
4. **No version-skew nudge**: `.codument-meta.json` records the scaffolded version but nothing
   compares it to the running package, so after an upgrade the installed skills/managed sections
   silently lag until the user remembers `codument update`.

## Scope

- `src/lib/registry.ts`
- `src/lib/analyze.ts`
- `src/commands/review.ts`
- `src/commands/ack.ts`
- `src/commands/init.ts`
- `src/lib/claude-settings.ts`
- `src/hooks/check-docs.ts`
- `src/commands/doctor.ts`
- `tests/analyze.test.ts`
- `tests/review.test.ts`
- `tests/ack.test.ts`
- `tests/init.test.ts`

Also touches root-level `README.md` (fix-table row) — expected out-of-plan false-fire if Plan 04 has
not landed.

## Non-goals

- No re-scoring of doctor's coverage model; only the scaffold exemption + confirm mechanism.
- No new onboarding docs (overview/getting-started rewrites live in Plan 07).
- No hook redesign; same hook, robust resolution.

## Decisions (settled)

- `empty-depends-on` exempts `needs-review` (matching thin-doc's in-flight rationale). A leaf
  feature clears the finding explicitly via a registry field (`depends_on_confirmed: true` set by a
  human/agent after review — name it consistently with existing registry style); doctor treats a
  confirmed-empty as satisfied and the fix-table documents it.
- Drift guidance branches on finding kind: `changed` keeps the two-way per-symbol guidance;
  `added`/`removed` suggest doc update or the file-grain `codument ack <path>` form. `ack`'s
  added/removed rejection message names the file-grain alternative.
- Hook robustness: init resolves the hook target at write time — if `node_modules/codument` is
  absent, warn and write a guarded command (the hook script itself exits 0 silently when its module
  or the registry is missing; a nudge hook must never break the user's editor loop).
- Version skew: `doctor` and `review` print one dim line when meta.version < package version:
  "codument X.Y installed, project scaffolded at A.B — run codument update".

## Delivery Plan

- [x] Step 1: Scaffold exemption + confirmed-empty mechanism in `registry.ts`/`analyze.ts`; update
      README's fix-table row. Tests: fresh scan → doctor reports no findings and a sane headline;
      a mature isolated entry still fires; `depends_on_confirmed` clears it honestly.
- [x] Step 2: Kind-aware drift guidance in `review.ts` + cross-referencing rejection message in
      `ack.ts`. Tests: added-symbol finding renders the file-grain suggestion; the suggested command
      actually succeeds; removed-symbol likewise.
- [x] Step 3: Hook resolution + fail-silent hook + init warning when local install is missing.
      Tests: hook exits 0 (no stack) when module absent; init warns on missing node_modules.
      (Shipped shape: the WRITTEN COMMAND guards its own target — existence check + same-process
      import so stdin survives — and the settings normalizer recognizes older command forms by the
      stable target path, so upgrades replace rather than accumulate.)
- [x] Step 4: Version-skew nudge in doctor/review (dim, one line, never a finding). Test with a
      stubbed meta version. (Shipped notes: human output only so both --json contracts stay
      byte-identical; a corrupt meta downgrades the nudge to a repair pointer rather than crashing
      an advisory surface; version resolution became layout-agnostic — by package name, never a
      consumer's manifest — so unbundled test contexts can import it.)

## Outcome

The recommended first run ends green with an honest headline; every resolution command the tool
prints actually works when pasted; the hook can never spam errors into an editor session; and
upgrades stop silently de-syncing the installed workflow. What it does NOT do: change what doctor
measures or add any new gate.

## Acceptance criteria

Live `init → scan → doctor` on a scratch express/TS project: zero findings, no 0% ratios; pasted
guidance from a live `review` run succeeds for changed, added, and removed symbols; hook silent
without local install; skew line appears/disappears correctly.

## Verification

`npm test`; `npm run typecheck`; the live first-run walkthrough above, plus a `--strict` CI-style
run on the fresh scaffold exiting 0.
