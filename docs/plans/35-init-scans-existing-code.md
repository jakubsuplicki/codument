---
status: shipped
---

# Plan 35: `init` scans a repo that already has code

Setting codument up on an existing project takes two commands, and the second one is easy to miss.
`init` installs the workflow and writes an *empty* registry; `scan` is what reads your source and
proposes which docs own which files. Run only the first and you get a delivery loop that owns none
of your code — the gate has nothing to check, `/update-docs` has no scaffolds to fill, and nothing
says so until much later.

Plan 34 documented the two-command path honestly. This plan removes the second command: when `init`
lands on a repo that already has source and no registry, it scans as part of setup.

## Why

- **The missed second command is silent.** Nothing fails. You get a working install that quietly
  covers nothing, and the symptom (`doctor` reporting no ownership, `review` finding nothing to
  stale) shows up long after the cause.
- **The condition is already known at that moment.** `init` detects the project and its source
  directory before it writes anything, and it creates the registry itself, so it knows both halves
  of "existing code, nothing documented" without a new check.
- **The hint it prints today is the admission.** `init` ends by telling you to run `scan` for
  existing code. A command that knows the next command should run, and knows you are in the case
  that needs it, can run it.

## Scope

- `src/commands/init.ts` — after the profile assets and the registry are written, run `scan` when the
  repo has source files and the registry `init` just created is empty. Add `--no-scan`.
- `src/cli.ts` — where that flag is declared; the command table is the only place a flag can exist.
- The closing next-steps hint: point at `/update-docs` when a scan ran, keep the current `scan`
  pointer when one did not.
- `tests/init.test.ts` — the fire condition, both skip conditions, and `--no-scan`.
- `README.md` — the Quick start block and the setup section collapse to one command again.
- `docs/features/commands.md` — the owning doc for both handlers.
- `CHANGELOG.md`.

## Non-goals

- **`scan` itself does not change.** Same discovery, same refusals, same provisional-registry
  behavior. This plan only calls it from one more place.
- **No change to the zero-commitment trial path.** `scan` + `audit` on an unadopted repo still
  installs no workflow; that is what makes it safe to try, and it stays a standalone entry point.
- **`adopt` is untouched.** A repo that already has a registry is adoption territory, not this case.
- **No auto-`/update-docs`.** Filling the scaffolds is the agent's job and needs a session; `init`
  stops at proposing ownership.

## Outcome

- **One command sets up any project.** `npx codument init` on an existing codebase installs the
  workflow *and* maps your source to the docs that own it. New projects are unaffected — with no
  source to scan, nothing extra happens.
- **The install can no longer be silently half-done.** The case where you end up with a delivery
  loop owning none of your code stops being reachable by forgetting something.
- **What it does NOT do:** it does not write real documentation — the scaffolds it lays down are
  empty and marked `needs-review` until you run `/update-docs` in an agent session, exactly as
  before. It adds no new mapping intelligence; a repo that scans badly today scans the same way from
  inside `init`. And it makes `init` write more files than it used to on an existing repo, which
  `--no-scan` is there to decline.

## Open questions

- **Auto-run, or ask first?** *Recommended:* auto-run with `--no-scan` to decline. A prompt makes
  the one-command path a two-answer path, and the thing being proposed is reversible — scan writes
  scaffolds and registry entries you can delete. Asking would also break non-interactive use, which
  is how `init` runs in most setup scripts.
- **What if `scan` refuses mid-init?** *Recommended:* report it and finish. The profile assets and
  the registry are already written and are useful on their own; failing the whole install because
  the mapping half could not run would be worse than saying which half is missing.

## Decisions (settled)

- **The fire condition is "has source AND the registry is empty", not "has source".** A repo with an
  existing registry is `adopt`'s case; re-scanning it from `init` would propose over ownership
  someone already authored. Both halves are known to `init` without a new check.
- **Opt-out, not opt-in.** A `--scan` flag would leave the default exactly as broken as it is now,
  since the people who miss the second command are the ones who would not pass the flag.
- **`scan` stays a first-class command.** It is the trial path's entry point and the way to
  re-derive the map later; this plan adds a caller, it does not absorb it.

## Delivery Plan

Status: shipped.

- [x] **Step 1 — Scan from `init`.** Run `scan` at the end of `init` when the repo has source files
      and the registry `init` just created is empty; add `--no-scan`; report a refusal without
      failing the install; point the closing hint at `/update-docs` when a scan ran. Cover the fire
      condition, both skip conditions, `--no-scan`, and the refusal path in `tests/init.test.ts`,
      and update `docs/features/commands.md`.
- [x] **Step 2 — Collapse the documented path.** README Quick start and setup section back to one
      command for an existing project, the `init`/`scan`/`adopt` table and the per-entry-point
      details block reworded to match, plus a `CHANGELOG.md` entry.

## Acceptance criteria

- `init` on a repo with source and no registry produces a populated registry and doc scaffolds in
  one command.
- `init` on an empty project writes exactly what it writes today — no scan, no scaffolds.
- `init` on a repo with an existing registry does not scan.
- `--no-scan` skips it in every case.
- A `scan` that refuses leaves the install complete and says which half did not run.
- `codument review --strict` green at each step boundary; the full suite passes.

## Verification strategy

- `npm test`, with the new cases in `tests/init.test.ts` carrying the contract.
- A live run of the built CLI against a throwaway fixture repo with source and no docs, and against
  an empty directory, to prove the two paths differ as claimed.
- `npm run typecheck` and `npm run lint`.
