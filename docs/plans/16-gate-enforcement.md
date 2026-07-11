---
status: approved
---

# Plan 16: enforce the gate — pre-commit hook installer + CI required check

Today `codument review --strict` is advisory: the AGENTS contract tells the agent to run it before
every commit, and nothing stops a commit while it is red. Dogfooding the website build produced the
proof case: a well-instructed agent, 44 commits, and exactly one slip — a shell-chained commit that
landed while the gate was momentarily red. Instructions alone do not enforce, even on a compliant
agent. This plan adds the two mechanical arms: a git pre-commit hook (local speed bump) and a CI
workflow scaffold (the authority).

## Why

- The enforcement ladder today has a hole: editor nudge (weakest, advisory) → AGENTS contract
  (advisory) → `review --strict` exit code (mechanical, but nothing invokes it at commit time) →
  nothing. A hook closes the local hole; CI closes the remote one and is where "required check"
  becomes literal (branch protection).
- `review --strict` is already hook-clean: no TTY, no prompts, no writes (bare `--strict` never
  touches disk), pure static analysis (git + TS parse; no test spawning — that is `--require-review`
  and stays out of the hook). The gate was built for this seat; only the seat is missing.
- Plan 14 named the "eventually-planned CI required-check story" and shipped only annotations. This
  is that story's delivery.

## Scope

- `src/lib/git-hooks.ts` (new)
- `src/lib/git.ts` (one helper: resolve the effective hooks directory)
- `src/commands/hooks.ts` (new)
- `src/cli.ts`
- `src/commands/init.ts` (`--hooks` flag)
- `templates/ci-codument.yml` (new)
- `tests/git-hooks.test.ts`, `tests/hooks-command.test.ts` (new)
- `.github/workflows/ci.yml` (dogfood: the repo's own PR gate)
- `docs/features/hooks.md` (rescoped), `docs/features/change-control-gate.md`,
  `docs/architecture/decisions/013-*.md` (new), `README.md`, `CHANGELOG.md`, `docs/.registry.json`

```feature-map
src/lib/git-hooks.ts | hooks | feature | hooks-dir resolution + managed pre-commit block writer
src/commands/hooks.ts | hooks | feature | hooks install/status/uninstall command surface
```

Run `codument map materialize` for both new sources. Independent of Plan 17; run first.

## Non-goals

- No `review --staged` mode. The gate evaluates the working tree against HEAD; with partial staging
  the hook may check bytes that differ from the commit. Documented honestly as a speed bump, not a
  proof of the committed bytes; a staged-index mode is a named follow-up, not smuggled in here.
- No `--require-review` in the hook by default (test spawning at commit time is how a hook gets
  uninstalled). Users who want it can edit the managed block; the block says so.
- No hosted GitHub Action, no hook manager integrations (husky/lefthook users get a documented
  one-liner instead — their managers own the hook file).
- No doctor check for hook presence (`hooks status` owns that question; revisit if demand shows).

## Decisions (settled)

- Command surface: `codument hooks install [--ci]`, `codument hooks status`,
  `codument hooks uninstall` — a subcommand group like `map`/`emit`. The "hooks" namespace now
  covers all enforcement arms: editor nudge (existing), git hook (this plan), CI scaffold (this
  plan). `codument init --hooks` calls the same installer (flags, not prompts — init's pattern).
- Hooks dir resolution: `git rev-parse --git-path hooks`, which honors `core.hooksPath` and
  worktrees. No hand-derived `.git/hooks`.
- The hook file: POSIX sh, managed block between `# >>> codument gate >>>` / `# <<< codument gate <<<`
  markers, `chmod 0o755`. Absent file → created with shebang + block. Existing sh script → block
  appended (or replaced in place when markers exist; install is idempotent). Existing non-sh hook
  (foreign shebang, binary) → refuse with the exact line to add manually, exit 1. Uninstall removes
  the block, and the file too if only our scaffold remains.
- Block behavior: runs `npx --no-install codument review --strict` (local-only resolution — the
  verdict path never fetches). Red gate → block the commit, print the failure and both named
  escapes. Escapes: `git commit --no-verify` and `CODUMENT_SKIP_GATE=1` (checked by the block). An
  honest override beats a wall; the point is that skipping is a stated act, never a slip.
- Missing binary degrades loudly, not closed: if neither a local install nor a PATH `codument`
  resolves, the hook prints a named one-line warning and exits 0. Blocking every commit after an
  `rm -rf node_modules` trains users to delete the hook; "could not run, said out loud" matches the
  adversarial gate's unrunnable→advisory stance. Fail-closed stays the rule when the gate RUNS.
- CI scaffold: `hooks install --ci` writes `.github/workflows/codument.yml` from
  `templates/ci-codument.yml` — on `pull_request`, `fetch-depth: 0`,
  `npx codument review --strict --base "origin/${{ github.base_ref }}"`. Refuses to overwrite an
  existing un-managed file. Making the check *required* is a branch-protection setting; README
  documents that one click. The SARIF upload step is included commented, pointing at the Plan 14
  recipe.
- Dogfood: this repo's own `ci.yml` gains a PR job running the strict gate against the merge base.

## Delivery Plan

- [x] Step 1: `git-hooks.ts` — hooks-dir resolution helper in `git.ts` + managed-block
      planner/writer/remover with foreign-hook classification and 0o755; unit tests in temp repos
      (fresh repo, existing sh hook, foreign hook, `core.hooksPath` set, reinstall idempotence).
- [x] Step 2: `codument hooks install|status|uninstall` + CLI registration + `init --hooks`; e2e
      tests: in a temp repo with a red gate a real `git commit` is blocked, `--no-verify` and
      `CODUMENT_SKIP_GATE=1` pass it, a green gate commits normally, missing binary warns and
      passes.
- [ ] Step 3: `--ci` scaffold + template + tests (fresh write, managed re-write, un-managed refusal);
      the repo's own ci.yml PR gate job.
- [ ] Step 4: docs — rescope `hooks.md` (three arms, one feature), change-control-gate invariant
      ("a red strict gate blocks a hooked commit; every escape is a named act"), ADR-013
      (enforcement posture: local hook = speed bump, CI = authority, missing-runtime degrades
      loudly), README enforcement section, CHANGELOG, registry.

## Outcome

`codument hooks install` and the 1-in-44 slip class is gone locally; `--ci` plus one branch-protection
click and it is gone remotely, where it is actually authoritative. Nothing about the gate's verdict
changes — only who is guaranteed to hear it.

## Acceptance criteria

The e2e proves a real `git commit` is blocked by a red gate and both escapes work; reinstall is
byte-idempotent; a foreign hook is never clobbered; `core.hooksPath` is honored; missing binary
degrades with a named warning; full suite green; `review --strict` green at every commit of this
plan.
