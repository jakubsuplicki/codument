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

The loop is gated where a decision is owed, and continuous everywhere else. Source edits never start before a human approves the plan, and every step still passes `work-step` → `review-work` → `commit-work` in order — but once the plan is approved the agent runs those gates back to back instead of asking permission to proceed between them. The waiting was never the guardrail: the approval, the pause conditions, and the step-sync gate are, and they are unchanged by running without it. What stops a run is a decision the agent should not make alone — a judgment-call finding, anything touching public interfaces, security, data loss or dependencies, a failed verification, work drifting outside the approved plan. The user drops back to a fully gated, one-step-at-a-time loop by saying so, and that choice then holds for the session rather than expiring after a step; the off switch is deliberately a spoken phrase and not a setting, because a mode that must be configured to be escaped is not an escape. Intent routing lives in the always-loaded instructions so the user never has to name a skill: rough ideas route to grilling, settled scope to planning, approved plans to implementation.

The contract governs what the agent *says*, not only what it does. Every gate in the loop hands the user a decision, and a decision buried in the analysis that produced it is a decision the user cannot make — so response altitude joins the quality bar and implementation discipline as a third standing rule: lead with the answer, offer the evidence rather than delivering it. It is a default rather than a mode, because a toggle would still require asking for brevity, which is the friction it removes. The obvious ways to obey it are worse than ignoring it — answering faster by reading less, or shortening a mandated format by dropping one of its parts — so the rule is written with both failure modes closed, and the invariants below pin them.

Compaction is a first-class checkpoint, not an afterthought. After any reviewed-and-committed step everything durable — code, docs, review state, the commit — is already on disk, so the post-commit gate always offers compact-context alongside next-step, plan-review, and pause, agent-neutrally, with a restart-note fallback for hosts without a native compaction command.

Adoption of an existing project is gentle: scan and map what exists, create missing docs only where needed, and mark uncertainty instead of pretending the scan is authoritative.

## Invariants & boundaries

- Every implementation step passes the gate sequence `work-step` → `review-work` → `commit-work`, and the agent never advances to the next plan step without review and commit in between. This holds in both modes: running without waiting removes the pauses between the gates, never a gate. *(pinned by the managed-section assertions in `scaffold.test.ts` — the generated instructions carry the gate text)*
- **Repo-wide health is looked at once per plan, and it reports rather than gates.** `review` answers whether *this change* is in sync and runs at every step; `doctor` answers whether the knowledge base is still worth reading and runs once, when the last step is committed. Splitting them that way is what keeps the loop honest in both directions: a field run made 37 review-family calls across five commits without ever learning its own health surface stood at 140 findings — one of them on a doc that session had just edited — and putting `doctor` in the per-step gate instead would block every plan on an adopting repo's pre-existing debt, which is how a gate gets switched off. *(behavioral — carried in the `commit-work` skill; the delivery loop is not itself executed by the CLI)*
- Source edits never start before the plan is approved. After approval the steps run without waiting for routine confirmation, and only a decision the agent should not make alone stops the run — a judgment-call finding, a change touching public interfaces, security, data loss or dependencies, a failed verification, or work outside the approved plan. *(pause conditions and the approval precondition pinned by `scaffold.test.ts`; the rest is behavioral)*
- The gated one-step-at-a-time loop is always reachable by asking for it in plain language, and that choice holds for the session rather than expiring after one step. Only the user resolves review findings in that mode. *(the off phrases are pinned by `scaffold.test.ts`; enforcement is behavioral)*
- The workflow executes in the agent, never in the CLI: codument installs, audits, and gates — it does not drive the coding agent.
- Claude is the default profile when no agent files are detected; other profiles are selected explicitly or by detection. *(test: `agent-profiles.test.ts` "defaults to claude when no agent files exist")*
- Choosing compact-context never bypasses the review-and-commit gate or starts the next step automatically. *(pinned by the `commit-work` skill assertions in `scaffold.test.ts`)*
- **The loop's own housekeeping is checked, not left to discipline.** The final step compacts the plan's delivery scaffolding out of the doc it lived in, and that instruction had no reading outside the agent obeying it every time — so a doc whose checklist is complete is now named by the health surface. This is the same stance the loop takes everywhere else: a rule the tool mandates and does not check is one that reads as optional the first time a run is under pressure. *(the `shipped-scaffolding` finding in [[registry-health]]; the compaction instruction itself is pinned by the `work-step` skill assertions in `scaffold.test.ts`)*
- The contract names the escape when the agent cannot invoke the CLI as written. The whole loop assumes `codument …` runs and its arguments arrive intact; where a launcher breaks that assumption the agent sees an argument-count error from codument and has no reason to suspect the launcher, so the instruction is keyed to that symptom and gives a different way to invoke rather than describing a platform. A guarantee the loop depends on is worth one line even when it holds almost everywhere — the session that hit it lost the acknowledgment route for its entire run. *(pinned by the mangled-argument assertions in `scaffold.test.ts`, which require the symptom, both invocations, and the line's position inside the loop it serves)*
- The response-altitude rule never licenses reading less, and never excuses a mandated format from carrying its required parts — brevity that drops the grounding clause, or an exemption that lets a format skip a part, is the regression. *(pinned by the response-altitude assertions in `scaffold.test.ts`, which require the grounding clause inside the section and forbid an exemption phrasing)*

## Decisions

- `AGENTS.md` is the canonical cross-agent instruction file when a project supports multiple agents; `CLAUDE.md` remains a compatibility target (the agent-neutral pivot).
- Claude became the default profile in 0.6.0, replacing the original Codex/generic default; both remain first-class installs.
- Skills group around the delivery loop — `grill-with-docs`, `plan-with-docs`, `tdd`, `work-step`, `review-work`, `commit-work`, `update-docs` — not around tools or file types.
- Working plan state stays durable enough that compaction can be offered after every reviewed-and-committed step, not only at feature completion.
- Running an approved plan without waiting is the default, inverting the original opt-in autopilot. The opt-in default made the slowest possible loop the shipped one — three routine confirmations per step, none of which asked the user a real question — while the confirmations that matter fire on their own regardless. The escape is a spoken phrase rather than a project setting, and it holds for the session: a configured opt-out would need a file to edit and a session to remember it, which is the friction the flip exists to remove, and one that expired after a step would repeat the original bug.
- Response altitude is a standing rule in the contract, not an opt-in mode. A brevity toggle would still require the user to ask for brevity, which is the friction it exists to remove. Rejected alongside it: a compression *register* (dropping articles, abbreviating, substituting symbols) — the failure being fixed was surface area, not spelling, and abbreviations measure as no cheaper under the tokenizer while costing the reader.

## Key files

- `src/lib/agent-profiles.ts` — the profile model: maps the neutral workflow onto each agent's instruction files, skills directories, and capability set. ([[lib]] owns the module; this page owns the workflow it installs)
- `src/lib/scaffold.ts` — the install surface: templates, the marker-bounded managed instruction section, skills copying. ([[project-charter-gate]] and [[lib]] document the machinery)
- `templates/skills/` — the delivery-loop skill sources `init` installs into a project.

## Delivery Plan — explicit next-step handoff

Status: draft, awaiting approval before source edits.

The post-commit gate currently offers a bare "start the next unchecked plan step" option. This draft would make it name the actual next step (`Step N - <summary>`), label the final step, and drop the option when no unchecked step remains — so an agent cannot repeat the option without re-reading the active plan after compaction. Not approved; no source has changed for it.

- [ ] Step 1: Update the reusable and dogfooded `commit-work` skill instructions so the post-commit gate requires the actual next unchecked step number and summary, including final-step and no-unchecked-step handling.
- [ ] Step 2: Update the workflow documentation and focused tests so initialized/updated skills preserve the explicit next-step handoff requirement.
