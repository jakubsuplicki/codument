---
status: approved
---

# Plan 48: the confirm gate owns its own clock

Plan 47 taught the change-control gate two rules: a block must be provable, and a route is
offered only where it can work. The **confirm gate** — the half of the adversarial review
gate that adjudicates a finding by running the test it names — never learned either one.

Its budget is a hardcoded 120 seconds that no caller sets and no surface exposes. Measured
on this repository: `tests/review.test.ts` takes **230 seconds**. So a finding naming the
largest test file in codument's own suite cannot be adjudicated by codument, and the tool
cannot review itself with the gate it ships. That is not a slow-machine edge case; it is
the ordinary path on the ordinary repo.

What happens when the clock expires is the worse half. `spawnSync` returns `ETIMEDOUT`, the
runner reads a truthy `error` and returns `unrunnable`, and `unrunnable` is the bucket that
also holds *runner missing*, *test not found*, and *toolchain error*. The gate then prints
one condition line for all four causes with one route stapled to the end of it:

> the runner produced no test evidence, so they read advisory rather than judged — set
> testCommand in .codument-meta.json, or pass `--test-command "<your runner> {file}"`

Every word of that advice is wrong for a timeout. The runner was present. The command was
correct. The `{file}` slot was there. The test started and was running fine. The only thing
that went wrong is that **codument ran out of patience** — and it reported that as a defect
in the project, handed the reader a command that cannot help, and passed the gate.

That is the route-that-cannot-clear class the last release existed to end, alive in the
second gate. And the honesty condition's own doc already states the principle it is
violating: *"point your runner at TAP" is bad advice when the declared runner was fine.*

So, stated once: **codument's clock is codument's fact.** It must be reachable by the
project, adequate by default, named as itself when it expires, and it must never be
disguised as a gap in someone else's toolchain.

## Verified mechanisms

Each of these was reproduced against the code before being written.

1. **The budget is unreachable.** `TestRunnerOptions.timeoutMs` exists; `makeTestRunner`
   defaults it to 120 seconds; no caller in the codebase passes it and neither `review` nor
   `doctor` exposes it. There is no meta key either. The only way to change it is to edit
   codument's source.
2. **The default is under half of what this repo needs.** `npx --no-install tsx --test
   tests/review.test.ts` — the default command, the real file — takes 230 seconds.
3. **A timeout is distinguishable, and the partial output survives.** On expiry `spawnSync`
   sets `error.code === "ETIMEDOUT"`, `signal === "SIGTERM"`, `status === null`, and
   **returns whatever the child had already written**. Verified both directly and through
   the `shell: true` path win32 takes.
4. **The kill orphans the child on win32.** With `shell: true`, Node kills `cmd.exe`; the
   `node` grandchild is reparented and keeps running. Verified: one survivor per timeout.

## Why it matters more than its size

The confirm gate's entire claim is *verify, don't trust*. A finding blocks only when its
named test is genuinely red. Fail-open on the unverifiable is deliberate and correct — but
it is only honest while "unverifiable" means something about the project. A timeout is
codument choosing not to wait, and routing that through fail-open means the gate silently
green-lights a commit for a reason the reader is never told and could not act on if they
were. On this repository, on its biggest test file, by default.

## Scope

- `src/lib/review-confirm.ts` — the resolver, the named cause, the per-cause routes, the
  partial-TAP judgment
- `src/lib/invariant-check.ts` — carry the cause so `doctor --verify-invariants` can route it
- `src/commands/review.ts`, `src/commands/doctor.ts` — pass the timeout, count it, print it
- `src/cli.ts` — `--test-timeout <seconds>` on both commands
- `src/lib/codemod.ts` — `testTimeoutSeconds` in the meta file

## Delivery Plan

Status: approved (2026-08-14), pre-approved by the user for an autopilot run.

- [x] **Step 1 — the budget is reachable, and adequate.** `resolveTestTimeout` beside
  `resolveTestCommand`, same precedence (flag > `testTimeoutSeconds` in
  `.codument-meta.json` > default) and the same refusal discipline: a non-integer, zero, or
  negative declaration is refused out loud and degrades to the default, never silently
  obeyed. The unit is **seconds and says so in the key**, because a millisecond value read
  as seconds makes every test time out and every finding advisory — a silent always-green,
  which is the exact failure this gate exists to prevent. Expose `--test-timeout <seconds>`
  on `review` and `doctor`, and thread it through `makeTestRunner` and `invariantProbes`
  (which drops it today). Raise the default to **300s**, the smallest round number above
  this repo's measured worst file, so the tool can adjudicate its own suite.
- [ ] **Step 2 — a timeout is its own cause, with a route that can work.** Name it:
  `TestRunResult.cause`, set from `ETIMEDOUT`, carried onto the confirmed finding and the
  invariant result so both surfaces can count it. `confirmCondition` then takes every
  refused declaration and the timeout count, names each cause that is actually present, and
  offers **only the routes that apply** — the timeout route for a timeout, the runner route
  for everything else, both when both fired. The verdict does not move: a timeout is still
  unrunnable and still never blocks.
- [ ] **Step 3 — a timeout that already proved red is judged red.** If the output captured
  before the kill already carries a failing TAP line, the file went red before the clock ran
  out and the reproduction is on the wire — so the finding is `failed`, not unrunnable. This
  is one-directional by construction: a timeout can become a block, never a pass, because a
  clock that expired proves nothing about the tests that never ran. Proven with a real
  fixture that fails and then hangs.
- [ ] **Step 4 — say it where the reader is.** README and CHANGELOG, and an end-to-end proof
  on this repository rather than a fixture: a recorded finding naming the 230-second test
  file is judged by `--require-review` instead of timing out.

## Outcome

**A project can set the gate's clock, and codument's own default fits codument.** The
budget is `--test-timeout <seconds>` for one run and `testTimeoutSeconds` in
`.codument-meta.json` for the project, resolved by the same precedence as the test command
and refused just as loudly when it is garbage. The default moves 120s → 300s, so a finding
naming this repo's largest test file is adjudicated rather than abandoned.

**When the clock does expire, the reader is told that, and given something that works.**
Today a timeout reads as "the runner produced no test evidence" and routes to
`--test-command`. After: it reads as a timeout, says what budget expired, and offers the
budget. A run where both a runner and the clock failed names both, with both routes — never
one stapled over the other.

**A timeout that already demonstrated the bug blocks.** Where the child had emitted a
failing test before the kill, the finding is confirmed rather than downgraded; the gate
stops discarding evidence it already holds.

**What it deliberately does not do.** A timeout on its own still never blocks — an expired
clock proves nothing, and ADR 020 governs this gate too. The confirm runs stay sequential.
On win32 a timed-out child is still orphaned; that is measured, named as an honest boundary,
and left, because reaping the tree needs an async spawn and a job object — a restructuring of
the runner for a symptom the raised budget makes rare. Bare `doctor` and the meaning of
`unrunnable` for every other cause are untouched.

### Acceptance criteria

- `--test-timeout` and `testTimeoutSeconds` both reach the runner, with the flag winning;
  a garbage declaration is reported and falls back to the default.
- A timed-out finding's condition line names the timeout and the budget, and offers the
  timeout route — and does not offer `--test-command` unless a non-timeout cause also fired.
- A run mixing a timeout with a no-evidence failure names both causes and both routes.
- A test that emits a failure and then hangs is `failed`; a test that hangs having emitted
  nothing, or only passes, is `unrunnable` — never `passed`.
- `doctor --verify-invariants` words the same incident identically to
  `review --require-review` (the existing parity contract).
- On this repository, a finding naming `tests/review.test.ts` is judged rather than timed
  out under the new default.

### Verification strategy

- Unit tests in `review-confirm.test.ts` for the resolver's precedence and refusals, the
  named cause, the per-cause routes in every combination, and the partial-TAP rule against a
  real fixture process.
- The existing `adversarial-review-testcommand-parity.test.ts` contract extended to the
  timeout, so the two surfaces cannot diverge on the new cause.
- `npm run typecheck`, `npm run build`, `npm test`, `codument review --strict`,
  `codument doctor --strict` on every step.
- Step 4 verifies against the built CLI on this repo, not a fixture.

### Non-goals

- No parallel or async confirm runs; the classifier stays pure over a synchronous runner.
- No process-tree reaping on win32 (named boundary, above).
- No change to the fail-open stance for genuinely unverifiable claims.
- No new blocking condition beyond the one the reproduction proves.

### Open questions

None. The two that could have been open are settled by measurement and by ADR 020: the
default is 300s because this repo's worst file is 230s, and a bare timeout stays
non-blocking because a block must be provable.

### Independent plan pass

The plan introduces no source files — every change lands in an existing registered file — so
there is no Feature Map and nothing for a grounded plan adversary to attack. Skipped, per
the `plan-with-docs` contract.
