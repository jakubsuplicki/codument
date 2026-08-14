---
status: shipped
---

# Plan 48: the confirm gate owns its own clock

Plan 47 taught the change-control gate two rules: a block must be provable, and a route is
offered only where it can work. The **confirm gate** — the half of the adversarial review
gate that adjudicates a finding by running the test it names — never learned either one.

Its budget is a hardcoded 120 seconds that no caller sets and no surface exposes. Measured
on this repository: `tests/review.test.ts` takes about **165 seconds**. So a finding naming
the largest test file in codument's own suite cannot be adjudicated by codument, and the
tool cannot review itself with the gate it ships. That is not a slow-machine edge case; it
is the ordinary path on the ordinary repo.

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
2. **The default is under what this repo needs.** `npx --no-install tsx --test
   tests/review.test.ts` — the default command, the real file — takes ~165 seconds against
   a 120-second budget, reproducibly, timed the way the runner spawns it.
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

## Outcome

**A project can set the gate's clock, and codument's own default fits codument.** The
budget is `--test-timeout <seconds>` for one run and `testTimeoutSeconds` in
`.codument-meta.json` for the project, resolved by the same precedence as the test command
and refused just as loudly when it is garbage. The default moves 120s → 300s, so a finding
naming this repo's largest test file is adjudicated rather than abandoned, with headroom
for a loaded machine rather than a margin sized to an idle one.

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

## How it landed

**The measurement was the argument — and the first measurement was wrong.** Nothing here
needed a design debate, only a stopwatch: the default budget was under what this
repository's own slowest test file needs, so the tool could not adjudicate a finding naming
it. But the number that justified the new default, 230 seconds, was an artefact of how it
was taken. Timing the file through a shell pipeline charges per output line, and on a chatty
TAP stream that reads about 40% high; measured the way the runner actually spawns it —
captured to a buffer — the file takes 165 seconds, reproducibly. The conclusion did not move
(165 is still over the old 120, so the file could never finish), but the margin did, and the
release guide's own rule applies to the author as much as to anyone: a recorded number is a
claim to interrogate once, never a figure to carry forward. Corrected in the code comment,
the pinning test, the README and the changelog; the step commit messages still carry the
first figure, which is what a corrected record looks like.

The default is deliberately about double the measurement rather than just above it. A budget
sized to an idle machine expires on a loaded one — and it expires as a silent advisory,
which is the failure this plan exists to remove.

**Two holes turned up under attack, both in the guard rather than the feature.** A
sub-millisecond declared budget passed the positive-number refusal and then rounded to zero
milliseconds — which `spawnSync` reads as *no* timeout, so the guard against a gate that
never blocks would have produced a gate that never stops. And the first real-runner fixture
for the partial-evidence rule was passing for the wrong reason: it assumed `node:test` hangs
on a never-settling test, which it does not — it reports the test and exits in 130ms, so no
budget ever expired and only the outcome assertion carried. Asserting the *cause* alongside
the outcome is what caught it; the fixture became the shape that actually strands a run in
the field, a failing test in a file that leaks a live handle.

**The gate blocked its own plan, and it was right to.** Step 1's `--require-review` came back
red because the test file pinning the fix ran red — for a Windows shim that test could never
execute, shadowing `npx` with a `#!/bin/sh` file behind a colon-joined PATH. That failure had
been sitting in the baseline invisibly, because the confirm runner timed out before ever
reaching a verdict. Fixing the clock is what exposed it: known-Windows-failure baseline 27 →
26. A gate that cannot finish its own check does not report a problem; it reports nothing,
which reads the same as clean.

**The partial-evidence rule is not a new standard.** A run cut off by the clock proves
nothing about the tests that never ran, but it does not erase what the child already put on
the wire — and the completed-run path had always accepted exactly that evidence (a nonzero
exit counts as red only with TAP). Applying the same rule to an interrupted run makes a
cut-off file behave as the finished file would have, rather than inventing a second standard
for the same question. The one-directionality is the load-bearing half: a timeout can become
a block and never a pass.

This closes the defect plan 47 named and deliberately left standing in its own last
paragraph. Still open from that note: the surfaces battery's pointer rule is asked only of
scenarios declared unackable, so a placeholder offered where nothing it names can work is
caught by targeted tests rather than by the catalog walk.
