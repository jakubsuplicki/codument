---
status: approved
---

# Plan 03: Gate fail-closed — the I/O layer

The core verdict path already fails closed (unreachable base → `GateError` → red + exit 1,
`src/lib/two-ref.ts:50-58`, `src/commands/review.ts:229-240`). This plan extends that stance to the
three I/O conditions where the gate today silently reads green, plus the path-encoding bug that
silently drops files from the verdict.

## Why

Verified findings this plan fixes (all confirmed; reproduced live):

1. **Outside a git repo, `review --strict` / `--require-review` exit 0.** `review.ts:183-200`
   short-circuits on `!isGitRepo(root)` before any gate evaluation: human mode prints a yellow note,
   `--json` prints a literal `{state: null, ...}` that violates the exported `ReviewReport` type
   (`state: ChangeState`, non-null, `review.ts:88-102`), and no exit code is set. A CI job with a
   wrong working-directory or an archive checkout reads green from the flagship gate.
2. **Git output over 1MB silently reads as "Working tree clean".** No git spawn sets `maxBuffer`, so
   execFileSync's 1MB default throws on big trees, and `getWorkingTreeChanges` catches ANY error and
   returns `[]` (`src/lib/git.ts:8-15,118-125`; same pattern `two-ref.ts:27-33`). Reproduced live:
   a repo with 22k untracked files (porcelain output 1.28MB) and a genuinely stale owned doc —
   `review --strict` printed "Working tree clean", exit 0; deleting the noise files made the same
   change report stale docs + drift.
3. **Non-ASCII filenames are garbled and silently leave the verdict.** With git's default
   `core.quotePath`, a changed `src/föo.ts` arrives as `"src/f\303\266o.ts"`; `git.ts:66-78`
   unescapes only `\"` and `\\` (never octal), and the two-ref parsers (`two-ref.ts:207-252`) do no
   unquoting at all. Reproduced: editing a registered `src/föo.ts` → `staleDocs: []`, file
   misdiagnosed as "unmapped" (whose suggested fix, materialize on the garbled path, would corrupt
   the registry).
4. **Monorepo/subdirectory roots fail confusingly.** `isGitRepo` only checks
   `rev-parse --is-inside-work-tree` (`git.ts:17-23`); nothing asserts root == git toplevel. Run from
   a package dir and git returns repo-root-relative paths (`packages/app/src/x.ts`) that can never
   match the package-relative registry (`src/x.ts`) — everything reads unmapped, blob reads miss,
   the gate answers the wrong question with no hint.

## Scope

- `src/commands/review.ts`
- `src/commands/watch.ts`
- `src/commands/doctor.ts`
- `src/commands/report.ts` (step 4 — persists the same verdict the gate refuses)
- `src/lib/git.ts`
- `src/lib/two-ref.ts`
- `tests/review.test.ts`
- `tests/git.test.ts`
- `tests/two-ref.test.ts`
- `tests/watch.test.ts`, `tests/doctor.test.ts`, `tests/report.test.ts` (step 4)

## Non-goals

- Full monorepo *support* (path translation via `--show-prefix`) — this plan only makes the
  unsupported case loud instead of wrong.
- Unifying the two git parsing stacks into one module (desirable, tracked as a design cleanup; here
  both stacks just get the same `-z` treatment).
- Changing gate semantics (deletions, acks, approval — Plan 04).

## Decisions (settled)

- Non-git root: bare `codument review` keeps the friendly note and exit 0 (informational use);
  `--strict` or `--require-review` exits 1 with the same "gate could not run" shape as the
  `GateError` path. `--json` always emits a valid discriminated shape (e.g. `gate: "unavailable"`,
  `reason`), never a type-violating `state: null` — bump the JSON contract version field.
- Git spawn failures on the *change-listing* paths are `GateError`s (fail closed), never `[]`.
  Genuinely-empty output stays an empty change set. Advisory helpers (`listIgnoredPaths`) may keep
  a lenient fallback but must not swallow ENOBUFS once maxBuffer is raised.
- Path encoding: switch to NUL-terminated output (`git status --porcelain -z`,
  `git diff --name-status -z`) in BOTH stacks rather than decoding octal escapes — `-z` disables
  quoting entirely and also removes the rename-arrow ambiguity.

## Delivery Plan

- [x] Step 1: Non-git fail-closed. Rework `review.ts:183-200` per the decision above; add the JSON
      discriminant. Tests: `--strict` and `--require-review` exit 1 in a non-git dir; `--json`
      output parses and has no null state; bare `review` still exits 0.
- [x] Step 2: maxBuffer + spawn-error handling. Set a large explicit `maxBuffer` on every git
      `execFileSync`/`spawnSync` in `git.ts` and `two-ref.ts`; convert catch-to-empty on
      change-listing helpers into thrown `GateError`s that review renders red. Tests: a spawn error
      surfaces as exit 1 "gate could not run" (inject via an unreadable ref or a stubbed failing
      git), never "Working tree clean".
- [x] Step 3: `-z` parsing in both stacks; delete the C-style unquoting remnant in `git.ts:66-78`.
      Test: e2e with a registered `src/föo.ts` (and a CJK filename) — edit flags the owning doc
      stale with per-symbol drift; nothing lands in `unmapped`.
- [x] Step 4: Toplevel assertion. Resolve `git rev-parse --show-toplevel` once at review/watch/doctor
      startup — and at `report`, which persists the same verdict (added on review) — comparing
      kernel-canonical paths so a symlinked/differently-cased spelling of the true toplevel is never
      falsely refused; when `root` != toplevel, exit 1 with a message naming both paths and the fix
      (run from the toplevel; only `watch` has `--dir`, so the shipped copy names the cd fix for all).
      `--json` surfaces (review, doctor) emit a discriminated `gate: "unavailable"` shape, never human
      text. Test: running from a subdirectory errors loudly naming both paths; unit tests pin the
      `wrong-root`/`git-failed` kinds and the symlink pass-path.

## Outcome

The gate can no longer read green because it couldn't see the repo: wrong directory, huge tree,
broken git, or a filename outside ASCII all produce the same red "gate could not run / here's why"
the unreachable-base path already produces. Machine consumers get a valid JSON shape in every case.
What it does NOT do: make nested-root monorepos work — they now fail with an honest message instead
of a wrong verdict.

## Acceptance criteria

All four "Why" reproductions now fail closed (exit 1 with diagnostics) or produce the correct
verdict (the non-ASCII case flags the doc stale). No `state: null` reachable under `--json`.

## Verification

`npm test`; `npm run typecheck`; live: non-git dir, 22k-file scratch repo, `src/föo.ts` repro,
subdirectory run.
