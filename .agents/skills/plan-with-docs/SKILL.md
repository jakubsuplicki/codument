---
name: plan-with-docs
description: Turn resolved decisions into a Codument feature plan with scope, non-goals, acceptance criteria, verification strategy, and implementation steps.
---

# Plan With Docs

Use this after grilling has resolved enough uncertainty to create an implementation plan. The output is a durable feature or concept doc that the agent can resume from later.

## Workflow

1. Read `docs/.registry.json`, `docs/overview.md`, relevant feature/concept docs, and relevant ADRs.
2. Choose the narrowest doc home:
   - Feature behavior: `docs/features/{feature}.md`
   - Cross-cutting model or pattern: `docs/concepts/{concept}.md`
   - Hard-to-reverse architecture decision: `docs/architecture/decisions/{NNN}-{title}.md`
3. Write or update the plan with:
   - Summary
   - Current decision
   - Non-goals
   - Delivery plan
   - Acceptance criteria
   - Verification strategy
   - Open questions
4. Mark the plan as awaiting approval.
5. Stop and ask the user to approve or change the plan before implementation.

## Delivery Plan Format

```markdown
## Delivery Plan

Status: draft, awaiting approval before source edits.

- [ ] Step 1: ...
- [ ] Step 2: ...
- [ ] Step 3: ...
```

## Rules

- Keep implementation steps independently reviewable and commit-sized.
- Do not mix unrelated features into one plan.
- Do not begin source edits until approval is explicit.
- Do not preserve working chatter once the durable decision is captured.
- If existing docs conflict with the requested plan, surface the conflict before writing the final plan.
