---
title: Agent delivery workflow
status: current
type: concept
last_reviewed: 2026-07-06
---

# Agent delivery workflow

## In plain terms

The core loop codument installs into a project's agent instructions: grill the idea against the docs, write a durable plan, stop for human approval, implement one planned step at a time with real verification, review the diff, update the mapped docs and registry in the same slice, commit, repeat. Codument is not the runner — the CLI installs and audits this workflow; the agent executes it from the generated instruction files and skills. This page is the workflow's contract; the install machinery that writes it into a project is documented with its owning modules.

## Design approach

One neutral workflow, many agents. An agent profile maps the same delivery contract onto each agent's native surface — which instruction files, skills directories, and capabilities that agent supports — so the workflow stays neutral in shape while profiles stay honest about capability differences (a host without hooks simply doesn't get hook-backed nudges). `AGENTS.md` is the canonical cross-agent contract; `CLAUDE.md` remains a Claude compatibility target that defers to it. Claude is the default profile when nothing is detected; Codex/generic stays a first-class selectable target writing `AGENTS.md` and `.agents/skills`.

The loop is gated, not autonomous. Source edits never start before a human approves the plan; each step then passes `work-step` → `review-work` → `commit-work` in order, and review findings are the user's decision — fix, select, defer with a reason, or pause — never silently self-approved. Intent routing lives in the always-loaded instructions so the user never has to name a skill: rough ideas route to grilling, settled scope to planning, approved plans to implementation.

Compaction is a first-class checkpoint, not an afterthought. After any reviewed-and-committed step everything durable — code, docs, review state, the commit — is already on disk, so the post-commit gate always offers compact-context alongside next-step, plan-review, and pause, agent-neutrally, with a restart-note fallback for hosts without a native compaction command.

Adoption of an existing project is gentle: scan and map what exists, create missing docs only where needed, and mark uncertainty instead of pretending the scan is authoritative.

## Invariants & boundaries

- Every implementation step passes the gate sequence `work-step` → `review-work` → `commit-work`; the agent never advances to the next plan step without review and commit in between, outside an explicitly opted-in autopilot run. *(pinned by the managed-section assertions in `scaffold.test.ts` — the generated instructions carry the gate text)*
- Source edits never start before the plan is approved, and outside autopilot only the user resolves review findings. *(enforced by the generated instructions and skills; behavioral, no unit test)*
- The workflow executes in the agent, never in the CLI: codument installs, audits, and gates — it does not drive the coding agent.
- Claude is the default profile when no agent files are detected; other profiles are selected explicitly or by detection. *(test: `agent-profiles.test.ts` "defaults to claude when no agent files exist")*
- Choosing compact-context never bypasses the review-and-commit gate or starts the next step automatically. *(pinned by the `commit-work` skill assertions in `scaffold.test.ts`)*

## Decisions

- `AGENTS.md` is the canonical cross-agent instruction file when a project supports multiple agents; `CLAUDE.md` remains a compatibility target (the agent-neutral pivot).
- Claude became the default profile in 0.6.0, replacing the original Codex/generic default; both remain first-class installs.
- Skills group around the delivery loop — `grill-with-docs`, `plan-with-docs`, `tdd`, `work-step`, `review-work`, `commit-work`, `update-docs` — not around tools or file types.
- Working plan state stays durable enough that compaction can be offered after every reviewed-and-committed step, not only at feature completion.

## Key files

- `src/lib/agent-profiles.ts` — the profile model: maps the neutral workflow onto each agent's instruction files, skills directories, and capability set. ([[lib]] owns the module; this page owns the workflow it installs)
- `src/lib/scaffold.ts` — the install surface: templates, the marker-bounded managed instruction section, skills copying. ([[project-charter-gate]] and [[lib]] document the machinery)
- `templates/skills/` — the delivery-loop skill sources `init` installs into a project.

## Delivery Plan — explicit next-step handoff

Status: draft, awaiting approval before source edits.

The post-commit gate currently offers a bare "start the next unchecked plan step" option. This draft would make it name the actual next step (`Step N - <summary>`), label the final step, and drop the option when no unchecked step remains — so an agent cannot repeat the option without re-reading the active plan after compaction. Not approved; no source has changed for it.

- [ ] Step 1: Update the reusable and dogfooded `commit-work` skill instructions so the post-commit gate requires the actual next unchecked step number and summary, including final-step and no-unchecked-step handling.
- [ ] Step 2: Update the workflow documentation and focused tests so initialized/updated skills preserve the explicit next-step handoff requirement.
