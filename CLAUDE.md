# Codument Claude Compatibility

Shared agent guidance lives in [`AGENTS.md`](AGENTS.md). Treat that file as the canonical project contract; this file remains for Claude-specific tooling compatibility.

<!-- codument:start -->
## Claude Compatibility

Shared agent guidance lives in `AGENTS.md`. Follow that file as the canonical Codument workflow contract.

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
8. Commit focused work with a conventional commit.
9. Move to the next unchecked step.

### Intent routing
Use these routing rules at the start of each user request. Do not wait for the user to name a skill when their intent is clear.

- Rough idea, feature concept, ambiguous change, or "before we code" discussion: use `grill-with-docs` first. Load the smallest relevant docs and source context, ask one sharp question at a time, and do not edit source code.
- Settled scope with enough answers for implementation design: use `plan-with-docs`. Write or update the durable feature/concept plan, mark it awaiting approval, and stop for explicit user approval.
- Approved plan or user says to continue an approved plan: use `work-step`. Implement only the first unchecked step.
- Completed implementation step: use `review-work` before any commit.
- Clean review, or review findings explicitly fixed/deferred by the user: offer `commit-work` as the next gated action and wait for the user to ask for it.

When a request is ambiguous between planning and implementation, treat it as planning and begin with docs-backed grilling.

### Step gates
At the end of each implementation step, stop and offer review options. Do not ask to start the next plan step yet.

Required sequence for every delivery-plan step:

1. `work-step` implements and verifies one step, then offers `review-work`, correction, or pause.
2. `review-work` reviews that step, then waits for the user to approve all fixes, select fixes, defer findings with a reason, or pause. It must not fix findings automatically.
3. `commit-work` commits that reviewed step, then offers the next `work-step`, plan review, compact context, or pause.

When the user chooses compact context after a commit, use the active agent's native context-compaction command if one is available. If no native command is available, provide a concise restart note grounded in `AGENTS.md`, the active plan doc, `docs/.registry.json`, and `git status`, then pause.

Never move from one implementation step directly into the next without review and commit in between.
Only the user can decide to fix, select, or defer review findings.

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
