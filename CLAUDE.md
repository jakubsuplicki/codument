# Codument Claude Compatibility

Shared agent guidance lives in [`AGENTS.md`](AGENTS.md). Treat that file as the canonical project contract; this file remains for Claude-specific tooling compatibility.

<!-- codument:start -->
## Codument Delivery Workflow

### Core loop
Use Codument as the durable control plane for agent-led engineering work:

1. Grill the request against existing docs, code, ADRs, and project language.
2. Plan the feature in docs before changing source code.
3. Wait for explicit user approval before implementation.
4. Implement one planned step at a time.
5. Build the strongest practical feedback loop, preferring red-green-refactor when it fits.
6. Update docs and `docs/.registry.json` as part of the same step.
7. Review the diff against the approved plan, tests, docs, and architecture.
8. Commit focused work with a conventional commit, authored as the user with no AI `Co-Authored-By` trailer.
9. Move to the next unchecked step.

### Intent routing
Use these routing rules at the start of each user request. Do not wait for the user to name a skill when their intent is clear.

- Before editing source, name the one assumption the change depends on and run the assumption gate below. If a load-bearing assumption is unconfirmed, or the request is a rough idea / concept / "before we code" discussion, use `grill-with-docs` first — load the smallest relevant docs and source, surface the assumption with your recommended reading, ask one sharp question at a time, and do not edit source. If every load-bearing assumption is confirmed or cheap to reverse, go straight to implementation.
- Settled scope with enough answers for implementation design: use `plan-with-docs`. Write or update the durable feature/concept plan, mark it awaiting approval, and stop for explicit user approval.
- Approved plan or user says to continue an approved plan: use `work-step`. Implement only the first unchecked step.
- Any source edit, in or out of the delivery-plan loop, gets reviewed before commit — review is owed to the edit, not to a plan step. Scale it: a trivial edit (rename, comment, typo, pure-config) gets a one-pass self-review of the diff; a behavior change — public interface, data shape, deletion, or anything that tripped the assumption gate — gets the full `review-work` / `code-reviewer` pass. An ad-hoc bug fix is a behavior change: review it even though no plan step produced it.
- Clean review, or review findings explicitly fixed/deferred by the user: offer `commit-work` as the next gated action and wait for the user to ask for it.

### Assumption gate (before any source edit)
Default is to proceed. Stop to confirm only when a choice is BOTH load-bearing AND unconfirmed — never on ambiguity alone.

Load-bearing = wrong makes the work wrong, wasted, or hard to undo: it changes a public interface, data shape, migration, a deletion, security/auth behavior, the chosen approach, or behavior other callers depend on.

It is unconfirmed (and load-bearing) when one of these holds and you cannot settle it from the request, docs, or code:
- Two readings: the request admits two materially different readings and you had to pick one.
- Inferred "correct": you are inferring intended behavior the user never stated — including which behavior is the right one for a bug fix.
- Unverified property: you are relying on an unconfirmed claim about the code or domain ("X is always non-null / sorted / unique / present").

Route:
1. Confirmed, or trivial: just do it. No preamble.
2. A guess but cheap to reverse (wrong = a quick local follow-up edit): declare the assumption inline in one line and proceed. Do not wait.
3. Load-bearing AND unconfirmed: do not edit. State your recommended reading and the one sharpest question in a single line, then wait (`grill-with-docs` if it needs docs/source to resolve).

When unsure between 2 and 3, the test is reversibility, not difficulty: reversible-with-a-follow-up is tier 2 (declare), not tier 3 (ask). One line, recommendation-first — never a questionnaire.

### Step gates
At the end of each implementation step, stop and offer review options. Do not ask to start the next plan step yet.

Required sequence for every delivery-plan step:

1. `work-step` implements and verifies one step, then offers `review-work`, correction, or pause.
2. `review-work` reviews that step, then waits for the user to approve all fixes, select fixes, defer findings with a reason, or pause. It must not fix findings automatically.
3. `commit-work` commits that reviewed step, then offers the next `work-step`, plan review, compact context, or pause.

When the user chooses compact context after a commit, use the active agent's native context-compaction command if one is available. If no native command is available, provide a concise restart note grounded in `AGENTS.md`, the active plan doc, `docs/.registry.json`, and `git status`, then pause.

Outside an explicitly opted-in autopilot run, never move from one implementation step directly into the next without review and commit in between.
Outside autopilot, only the user can decide to fix, select, or defer review findings; in an autopilot run the agent may auto-apply only safe, obvious fixes and must pause for any judgment-call finding.

### Autopilot (opt-in per run)
Autopilot is off by default and applies to one run only; never assume it from a prior turn.

- Trigger: only when the user explicitly says "codument, run the plan" (also "run the plan", "codument this plan", "autopilot", or a best-effort `/work-step --auto` hint). The `--auto` flag is a convenience hint your host may ignore; the phrase is the reliable trigger.
- Precondition: never start autopilot before the plan is approved. Confirm the active plan shows `Status: approved` (not draft or awaiting approval). If you cannot confirm approval, do not start; say so and ask the user to approve the plan.
- While active, for each remaining delivery-plan step run `work-step` -> `review-work` -> `commit-work` without stopping for routine confirmations. Each gate still runs; you simply do not wait for the user to say continue. Commit per step with a focused conventional commit, attributed to the user only.
- During `review-work` in autopilot, auto-apply only safe, obvious fixes, then proceed to `commit-work`. Always pause for any finding that needs a judgment call or that touches public interfaces, security, data loss or deletions, or dependency changes.
- Hard pause conditions (stop the run, report a compact summary, wait for the user): a judgment-call review finding, a verification failure, or any change that falls outside the approved plan.
- Interrupt: if the user says "pause" or "stop autopilot", immediately return to the manual one-step-at-a-time gated loop.
- On any pause or on plan completion, report a compact summary of steps done, commits made, and why it stopped.

The Codument CLI does not run your coding agent. There is no `codument run` command; autopilot lives entirely in these instructions, which your agent follows.

### Definition of Done
A task is NOT complete until:
1. Code works and tests pass
2. The approved plan step is complete and no extra scope was added
3. `docs/.registry.json` is checked for affected source files
4. New source files are registered in `docs/.registry.json`
5. Corresponding feature docs are created or updated with durable, compact content
6. Dependent features are flagged if an interface changed
7. `last_updated` is set on all touched docs and registry entries
8. Review findings are resolved or explicitly deferred

### Planning and approval
Do not move from a rough idea into source edits automatically. First use the docs-backed grilling and planning workflow to resolve scope, non-goals, acceptance criteria, verification strategy, and implementation steps. Begin implementation only after the user approves the plan.

### Documentation Registry
The file `docs/.registry.json` maps source files to their documentation.
Always check it before and after modifying source files.

### Documentation Structure
- Feature docs: `docs/features/{name}.md`
- Concept docs: `docs/concepts/{name}.md`
- ADRs: `docs/architecture/decisions/{NNN}-{title}.md`
- All filenames: lowercase kebab-case
<!-- codument:end -->
