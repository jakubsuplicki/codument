---
name: grill-with-docs
description: Stress-test a requested change against Codument docs, source mappings, ADRs, terminology, and implementation reality before planning or coding.
---

# Grill With Docs

Use this before implementation when the user has an idea, feature, bug fix, or architectural direction that needs sharpening.

## Boundary With Plan With Docs

`grill-with-docs` is for deciding what the work should be. `plan-with-docs` is for writing the agreed implementation plan after the important decisions are settled.

Stay in `grill-with-docs` when any meaningful boundary is still unresolved:

- product behavior, user workflow, or success criteria
- architecture, migration, compatibility, or data-shape tradeoffs
- scope, non-goals, rollout, or reversibility
- affected callers, docs, tests, or dependent features
- verification strategy or acceptance criteria
- the right durable doc home for the decision

If the user asks to "plan" but these decisions are still open, explain that the request needs docs-backed grilling first. Ask one sharp decision question, include your recommended answer and why, then wait for the user's decision before turning it into a plan.

## Workflow

1. Load the smallest relevant context:
   - `AGENTS.md` or the active agent instruction file
   - `docs/overview.md`
   - `docs/.registry.json`
   - relevant `docs/features/*.md`
   - relevant `docs/concepts/*.md`
   - relevant ADRs under `docs/architecture/decisions/`
2. Inspect code when docs can answer only part of the question.
3. Ask one sharp question at a time when a real product or architecture decision remains.
4. Include your recommended answer and why.
5. Stress-test answers with concrete scenarios, failure modes, and edge cases.
6. Update the narrowest durable doc only after decisions settle, unless the user is explicitly brainstorming without file edits.

## What To Challenge

- Fuzzy nouns: ask what object, actor, state, or workflow the user means.
- Scope drift: separate current scope, future scope, and explicit non-goals.
- Hidden interface changes: ask what callers, docs, tests, and dependents will be affected.
- Reversibility: identify choices that would be expensive to change later.
- Verification: ask what feedback loop will prove the change works.
- Documentation fit: decide whether the decision belongs in a feature doc, concept doc, overview, ADR, or nowhere durable.

## Rules

- Do not dump a questionnaire.
- Do not start implementation during grilling.
- Do not write a delivery plan while the key boundary is still unsettled.
- Do not treat "use Codument" or "plan the work" as permission to skip grilling when product or architecture decisions remain.
- Do not create generic `CONTEXT.md` files when Codument docs already provide the project memory.
- Prefer updating existing docs over creating new ones.
- Keep docs compact: capture settled decisions, not the whole conversation.
