---
status: approved
---

# Plan 01: Release hygiene — publish blockers

Three small fixes that must land before the owed `npm publish` of 0.7.0 (dist is gitignored, so the
publish flow is `npm run build && npm publish`; today nothing enforces that).

## Why

Verified findings this plan fixes:

1. **"studio" references leak into the OSS repo** — a hard project rule says this repo must contain
   zero indication any companion product exists; the JSON/event contracts must be justified
   intrinsically. Three tracked hits, one user-facing:
   - `src/cli.ts:125` — the `feed` command description ends "(for watch / studio)". This prints in
     `codument feed --help` and is baked into `dist/cli.js`.
   - `src/lib/claude-feed.ts:31` — comment "// studio consume the one normalized stream."
   - `src/commands/feed.ts:27` — JSDoc "which `watch` (and a future studio) consume".
2. **`codument demo --dir <path>` recursively deletes whatever directory it is pointed at.**
   `src/commands/demo.ts:115-117` runs `rmSync(dir, { recursive: true, force: true })` on the
   user-supplied path with no existence/emptiness check and no confirmation. Reproduced live: a
   pre-existing directory containing data was silently destroyed. This is the marketed
   "Try it in 30 seconds" entry point.
3. **No `prepublishOnly` guard while `dist/` is gitignored** — `npm publish` ships whatever dist
   happens to be on disk (stale code under a fresh version, or a missing bin target from a clean
   clone). `package.json` has no prepublishOnly/prepack/prepare.

## Scope

- `src/cli.ts`
- `src/lib/claude-feed.ts`
- `src/commands/feed.ts`
- `src/commands/demo.ts`
- `tests/demo.test.ts`
- `tests/oss-hygiene.test.ts` (new test file)

Also touches root-level `package.json` (prepublishOnly) — expected out-of-plan false-fire until
Plan 04 fixes the scope parser.

## Non-goals

- No change to what `feed` or the events contract does; wording only.
- No redesign of the demo flow; only the deletion guard.
- Not the publish itself — the human runs `npm publish` after this plan ships.

## Delivery Plan

- [x] Step 1: Reword the three "studio" references so the contract is justified intrinsically
      (e.g. "for `watch` and any downstream consumer of `.codument/events.jsonl`"). Add
      `tests/oss-hygiene.test.ts`: a test that scans `src/`, `templates/`, `skills/`, `agents/`,
      `rules/` for `/studio/i` and fails on any hit, so the rule is mechanically enforced from now on.
- [x] Step 2: Make `demo --dir` non-destructive. On dir creation write a marker file
      (e.g. `.codument-demo`) inside the demo dir. Before any `rmSync`: allow deletion only when the
      target is the default temp path or contains the marker; otherwise, if the dir exists and is
      non-empty, exit 1 with a message telling the user to pass a new/empty directory. Add tests:
      (a) pointing --dir at a pre-existing non-empty dir refuses and leaves it untouched,
      (b) re-running with the same --dir (marker present) still works.
- [x] Step 3: Add `"prepublishOnly": "npm run build && npm test"` to package.json scripts, then
      `npm run build` so dist reflects the reworded strings; verify `node dist/cli.js feed --help`
      no longer mentions studio.

## Outcome

A stranger's first minute with the product cannot destroy their data, the published package carries
zero private-product references (and a test keeps it that way), and a publish can never ship a stale
or absent build. After this plan the pending `npm publish` is unblocked.

## Acceptance criteria

- `grep -ri studio src/ templates/ skills/ agents/ rules/` returns nothing; the new test enforces it.
- `codument demo --dir <existing non-empty dir>` exits 1 without deleting anything; default
  `codument demo` and repeat runs against its own dir still work.
- `npm publish --dry-run` triggers build+test via prepublishOnly.

## Verification

`npm test` green; `npm run typecheck`; manual: `node dist/cli.js feed --help`, and the two demo
scenarios above run live.
