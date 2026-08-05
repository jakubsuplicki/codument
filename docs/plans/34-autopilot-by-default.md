---
status: shipped
---

# Plan 34: autopilot by default — guardrails without the waiting

Autopilot exists and works, and almost nobody turns it on. It is gated behind a phrase the user has
to know and repeat every run ("codument, run the plan"), so the shipped default is the slowest
possible loop: implement one step, stop, wait to be told to review, wait to be told to commit, wait
to be told to start the next step. Three round-trips per step, none of which the user was ever asked
a real question in.

The waiting is not the guardrail. The guardrails are the plan-approval gate, the hard-pause
conditions, the review pass, and `codument review --strict` — and every one of them stays exactly
where it is. What this plan removes is the *routine confirmation*: the turns where the agent stops
and the only sane answer is "yes, carry on".

So the default flips. An approved plan runs end to end — `work-step` → `review-work` →
`commit-work`, one focused commit per step — and the user says **"step by step"** (or "stop at the
gates") when they want to drive it manually instead.

## Why

- **The default should be the mode most people want.** Speed is the reason to reach for an
  agent-led loop at all; a default that stops four times per step taxes every user to protect the
  minority who wanted to watch each step land.
- **Opt-in guardrails are guardrails nobody has.** The inverse is already true of the useful half:
  the pauses that matter (a judgment-call finding, a failing verification, an off-plan change) fire
  *automatically* today and will keep firing. Those are the ones worth having on by default. The
  routine "shall I continue?" is not one of them.
- **Nothing about rigor changes.** Every step is still reviewed, still gated on `--strict`, still
  committed separately, still adversarially attacked when the diff warrants it. The user still
  approves the plan before a line of source is edited. The loop gets faster by dropping dead turns,
  not by dropping checks.
- **The off switch has to be cheap or it is not an off switch.** A phrase costs nothing to learn and
  nothing to maintain; it works on every host, in any session, with no file to edit and no flag to
  remember.

## Scope

- `src/lib/scaffold.ts` — the generated managed section: the **Step gates** rules and the
  **Autopilot** section flip their default. Gated single-stepping becomes the named exception.
- `skills/work-step`, `skills/review-work`, `skills/commit-work` — every "Outside autopilot, stop…"
  branch inverts: continue is the default path, stop-and-offer-options is what gated mode does.
- The dogfood copies (`AGENTS.md`, `CLAUDE.md`, `.claude/skills/`, `.agents/skills/`) re-synced from
  those two sources, so this repo runs the contract it ships.
- `tests/scaffold.test.ts` — the assertions that currently pin "opt-in per run" / "off by default"
  now pin the flipped default and the off phrases, keeping a guard against a regression to a bare
  unconditional gate rule.
- `README.md` — restructured to lead with what the user actually does: a dead-simple numbered
  start block near the top (new project / existing project), autopilot promoted from a buried
  section into the headline behavior, and the opt-in framing removed.
- `docs/features/agent-delivery-workflow.md` — the workflow contract page: the "gated, not
  autonomous" design paragraph, the two invariants that name autopilot, and a new Decision.
- `src/cli.ts` — the `run`/`autopilot` signpost, whose output implies the phrase is required.
- `CHANGELOG.md`.

## Non-goals

- **No config knob.** No `.codument-meta.json` field, no `init`/`update` flag, no `doctor` line. The
  mode lives in instruction prose, which is the only place it has ever lived; a durable setting
  would need a meta field, a regenerated managed section, and a surfacing path, and a spoken phrase
  covers the need.
- **The approval gate does not move.** Source edits still never start before the active plan reads
  `Status: approved`. Autopilot on an unapproved plan remains a refusal, not a default.
- **The hard-pause list does not shrink.** A judgment-call review finding, a change touching public
  interfaces / security / data loss / deletions / dependencies, a failing verification, an off-plan
  change, and a persistently red `codument review --strict` all still stop the run.
- **Review rigor is untouched.** Same review order, same proportional adversarial pass, same
  artifact and confirm gate. This plan changes who has to say "go", nothing about what is checked.
- **No renaming.** "Autopilot" keeps its name, its README anchor, and the `codument run` alias.
- **No progress-reporting cut.** The inline step-boundary checklist stays; a faster loop that
  advances silently is worse than the slow one.

## Outcome

- **An approved plan runs.** Today: approve, then say "work the next step", "run review", "commit",
  "next step" — four turns per step, none of them a decision. After: approve once and the plan is
  delivered step by step, each one implemented, reviewed, gate-checked and committed on its own,
  with a checklist posted at every boundary so it is never silent.
- **Stopping is one sentence.** "step by step" (or "stop at the gates", "one step at a time",
  "pause") drops back to the fully-gated loop and *keeps* it there for the session, until "keep
  going" lifts it. Nothing to install, configure, or remember between sessions.
- **The decisions you actually make are unchanged.** You still approve the plan before any source is
  edited, and the run still stops on its own for a judgment-call finding, anything touching public
  interfaces / security / data loss / dependencies, a failing verification, an off-plan change, or a
  red `--strict` gate.
- **The README says what to do before it says what it is.** A reader lands on numbered steps —
  install, one command, start a session, chat, approve once — instead of finding the workflow
  described three screens down and autopilot ten screens after that.
- **Where it lands:** every project that runs `codument init` or `codument update` from this release
  onward, plus this repo's own loop. It is a change to generated instruction prose, so an existing
  project only gets it after `codument update` and a fresh agent session.
- **What it does NOT do:** it adds no enforcement — nothing in the CLI checks or knows the mode, and
  a host agent that ignores its instructions is unaffected either way. It does not make the loop
  cheaper (that is plan 33's job), does not reduce what gets reviewed, and gives no permanent
  project-level opt-out — a user who wants the gated loop asks for it per session.

## Open questions

- **Sequencing against plan 33.** The out-of-plan gate keys off the first approved plan by filename,
  so only one plan may read `approved` at a time — and plan 33's work is complete but uncommitted.
  *Recommended:* commit 33 and flip it to `shipped` first, then approve 34. Otherwise the two plans'
  edits to `skills/review-work` and `src/cli.ts` land in the same commits.
- **Whether the `src/cli.ts` signpost is worth touching.** Editing it wakes the staleness gate for
  `docs/features/cli.md`. *Recommended:* yes, include it — it is the one place the CLI itself states
  the mode, and the doc's contract (the CLI never runs your agent) is unchanged, so it clears with a
  one-clause `codument ack`.
- **Should `init` run `scan` itself on a repo that already has source?** It would collapse the
  existing-project path to one command and match what users expect from a single setup step.
  *Recommended:* not here — it changes a CLI command's behavior and deserves its own grill; this
  plan documents the path honestly as two commands.

## Decisions (settled)

- **Gated mode is session state, not a per-run flag.** Today's text says autopilot "applies to one
  run only; never assume it from a prior turn" — that inverts. Continuous is the standing default,
  and once the user asks for gated mode it *holds* until they lift it ("keep going", "run the
  plan"). A disable that silently expires after one step is the bug this plan is fixing, mirrored.
- **The off phrases are pinned, plural, and natural.** "step by step", "stop at the gates", "one
  step at a time", plus the existing "pause" and "stop autopilot" — all mean the same thing: drop to
  the manual gated loop. Pinning several phrasings is the point; a single magic phrase reintroduces
  the thing-you-have-to-know that made autopilot unused.
- **Approval is the trigger.** With continuous as the default, approving a plan is what starts the
  run — no phrase required. The old trigger phrases stay recognized so existing habits and the CLI
  signpost keep working.
- **`/work-step --auto` stays accepted as a no-op hint** rather than being removed; it is an
  advertised affordance, and rejecting it would break muscle memory for zero gain. `/work-step`
  invoked for a single step remains exactly that — an explicit single-step request is honored
  whatever the mode.
- **Keep the name.** Renaming the mode would churn the README anchor, the CLI alias, the feature
  doc, and every changelog reference to rebrand a default that is being flipped, not redesigned.
- **The README leads with usage, not architecture.** The start block goes above "What it is". The
  three-sided explanation, the language matrix, and the deterministic-core argument all stay — they
  just stop being the first thing between a reader and their first run.
- **The existing-project path keeps `scan`.** `init` installs the workflow and writes an *empty*
  registry; `scan` is what maps existing source into it, and `/update-docs` fills the scaffolds
  `scan` lays down. Documenting `init` → `/update-docs` alone would leave the agent with nothing to
  fill and a registry that owns none of the user's code.

## Delivery Plan

Status: shipped.

- [x] **Step 1 — Flip the generated contract.** Rewrite the **Step gates** and **Autopilot**
      sections in `src/lib/scaffold.ts`: continuous run as the default, gated mode as the named
      opt-out holding until lifted, the off phrases listed, and the approval precondition plus the
      hard-pause list carried through verbatim in substance. Invert the two conditioned rules
      ("Outside an explicitly opted-in autopilot run…", "Outside autopilot, only the user can
      decide…"). Update `tests/scaffold.test.ts` to pin the new default and the off phrases, keeping
      the existing guard that the gate rule stays mode-conditioned rather than regressing to a bare
      absolute. Update `docs/features/agent-delivery-workflow.md` (the "gated, not autonomous"
      paragraph, the two autopilot invariants, a new Decision) in the same step, since it is the
      owning doc for this contract.
- [x] **Step 2 — Invert the three loop skills.** In `skills/work-step`, `skills/review-work`, and
      `skills/commit-work`, make continue-to-the-next-gate the default branch and stop-and-offer the
      gated-mode branch, preserving every options block verbatim for when gated mode is on. Re-sync
      the dogfood copies (`codument update`) so `AGENTS.md`, `CLAUDE.md`, `.claude/skills/`, and
      `.agents/skills/` match their generators byte for byte.
- [x] **Step 3 — README: lead with what you do.** Add a **How you use it** block immediately after
      the hero, before "What it is": numbered steps for a new project (`init` → new session → chat →
      approve once) and for an existing one (`init` → `scan` → new session → `/update-docs` → chat),
      with the off phrase named in a single line under them. Rewrite the Autopilot section as
      on-by-default and fold it into that story rather than leaving it buried in section 2; keep its
      `#autopilot` anchor and details block (precondition, pause list) intact. Update the nav line
      and the `--strict` autopilot reference.
- [x] **Step 4 — Signpost and changelog.** The `codument run` output in `src/cli.ts` so it no longer
      implies the phrase is required, and a `CHANGELOG.md` entry framing this as a default change
      with a named off switch.

## Acceptance criteria

- `buildManagedSection()` states that an approved plan's steps run without waiting for routine
  confirmation, names at least two off phrases, and contains no "off by default" or "opt-in per run"
  claim about autopilot.
- The approval precondition and the full hard-pause list are still present in the generated section,
  unchanged in substance.
- Each of the three loop skills reads continue-by-default, with the gated branch and its exact
  options block preserved.
- `codument update --dry-run` reports nothing to change: the dogfood managed files and skill copies
  match their generators.
- No file in `README.md`, `AGENTS.md`, `CLAUDE.md`, or `docs/` still describes autopilot as opt-in or
  off by default. (The unrelated `--verify-invariants` and `--require-review` opt-in claims stay.)
- The README's start block appears before "What it is", carries both project shapes as numbered
  commands, names the fresh-session requirement, and names the off phrase — and every command in it
  does what the block claims (`init` installs the workflow, `scan` maps existing source,
  `/update-docs` fills the scaffolds).
- `codument review --strict` is green at each step boundary, and the full suite passes.

## Verification strategy

- `npm test` — `tests/scaffold.test.ts` carries the pinned contract; the rest guards against
  collateral damage.
- `npm run typecheck` and `npm run lint` for the `src/cli.ts` touch.
- `codument update --dry-run` after step 2 to prove the dogfood copies are in sync.
- `grep -rn "opt-in per run\|off by default" README.md AGENTS.md CLAUDE.md docs/ src/` — every
  surviving hit must belong to `--verify-invariants` or `--require-review`, not autopilot.
- `codument review --strict` before each commit.
