---
name: establish-charter
description: Establish a project's seriousness and core tech/architecture decisions upfront, recommendation-first and teaching-by-default, before real building work begins. Runs once on an uncharted project, then biases every later grill.
---

# Establish Charter

Use this **before the normal grill loop**, the first time you are about to do real building work on
a project that has no charter yet. It sets the project's *seriousness* and walks the user through the
core tech and architecture choices — leading with a recommendation, explaining each in plain language
with its trade-off — so even a non-technical user understands and learns the choices they make. The
result is written to `docs/charter.md` (summary mirrored into `docs/overview.md`) and biases every
later grill.

## When To Run

Fire this gate when **both** hold:

1. **No `docs/charter.md` exists** (the project is uncharted), and
2. **The user's message is real-work intent** — building or changing something (a feature, the app,
   "let's make X"), not a pure question or read-only request.

A plain question or read-only request on an uncharted project does **not** trip the gate: just answer
it, and let the gate wait for the first real-work turn. This is a judgment call, not a string match.

Do **not** run it when a charter already exists — read the existing charter and proceed to the normal
loop. Do not re-interview.

## Core Principles

- **Lead on seriousness, never on experience.** The one opening question is *demo/throwaway vs.
  serious app I intend to ship and maintain*. **Never** ask how experienced the user is, and never
  branch behavior on it — that would gate a vibe coder out of the real questions and cap their
  learning. Everyone gets the same important questions.
- **Upskilling is the goal.** A non-technical user should come out understanding the choices they
  made, not just that choices were made.
- **Infer fluency live; adapt verbosity, not the questions.** Read the user's fluency from how they
  answer — terser when they are clearly fluent, more teaching when they ask "what's X?". Never skip a
  question because of inferred experience.
- **Recommendation-first, one choice at a time.** Never dump a questionnaire. Surface one decision,
  with your recommendation and why, and wait.
- **Never present an unresearched guess as fact.** On the serious path, when a recommendation is
  genuinely uncertain or best practice may have moved, research it before recommending (see Research).

## Workflow

1. **Confirm the gate applies.** Charter missing + real-work intent. If a charter exists, skip to the
   normal loop. If the message is a pure question, answer it and stop.
2. **Q1 — seriousness (always, first).** Ask the single question, framed plainly:
   *"Before we build: is this a quick demo / throwaway to try an idea, or a serious app you intend to
   ship and maintain?"* Recommend based on what they've described, and explain the difference in one
   line (a demo optimizes for speed now; a serious app pays a little more attention now to avoid
   painful rewrites later). Wait for the answer.
3. **Walk the core tech questions — on BOTH paths.** In order, one at a time: **architecture style →
   datastore → auth → hosting/deploy** (serious path also covers **scale/traffic expectations** and
   **testing strategy**). For each, use the Recommendation Format below.
4. **Adapt depth by seriousness** (see Demo Path / Serious Path).
5. **Persist** (see Persisting The Charter): write `docs/charter.md`, mirror a 2-line summary into
   `docs/overview.md`, and on the serious path write an ADR per real architecture decision.
6. **Hand off to the normal loop.** Once the charter is written, proceed with the user's original
   request through the standard grill → plan → work loop. The charter now informs every later grill.

## Recommendation Format

Every core tech question leads with the same shape, so a non-technical person can follow and an
expert can skim:

- **Recommendation:** the concrete choice you'd make.
- **What this means:** one plain-language line — no jargon — describing what the choice *is*.
- **Trade-off:** the key trade-off versus the main alternative (what you gain, what you give up).
- **Options offered:** let the user *accept*, *ask "tell me more"*, or pick *something else*.

Example:

```text
How should the app store its data?
→ Recommend: PostgreSQL
  What this means: a reliable database that keeps your data safe, structured, and easy to query.
  Trade-off: vs. a simple file/JSON store — Postgres is a little more setup now, but a file store
  gets slow and fragile once you have real users and real data.
  [ accept · tell me more · something else ]
```

## Demo Path (seriousness = demo)

Still lead through the **same** core tech questions — the vibe coder learns too — but lighter:

- For each question, **pre-pick a sensible default** and present it so the user can accept fast (or
  accept all at once). Keep the plain-language "what this means" + trade-off so they still learn.
- Fewer follow-ups; don't drill into edge cases.
- Say plainly that **they can revisit any of this later** as the project grows.
- **No research agents. No ADRs.** Write the charter with `seriousness: demo`.

## Serious Path (seriousness = serious)

Drill harder and make the decisions deliberately:

- Push deeper on each choice; cover scale/traffic and testing strategy in addition to the core set.
- **Research genuinely uncertain choices** (see Research) before recommending.
- Write an **ADR per real architecture decision** (datastore, auth model, hosting model, etc.).
- Write the charter with `seriousness: serious`.

## Research (serious path, when uncertain)

When a recommendation is genuinely uncertain, or current best practice may have moved since your
training, **spin up a research agent** (a web-capable subagent) to gather current recommendations and
trade-offs before you recommend. Then present a **recommendation-first synthesis** — your pick, the
plain-language meaning, and the trade-off — never a raw dump of search results. Cite what moved your
recommendation if it differs from the obvious default.

Do not research on the demo path, and do not research choices that are not genuinely uncertain.

## Persisting The Charter

- Write `docs/charter.md` from the `charter.md` template: seriousness, a one-paragraph project intent,
  and the settled tech decisions with their one-line rationale. Set `last_reviewed` to today.
- **Mirror a 2-line summary into `docs/overview.md`** (seriousness + the stack in one line), because
  `grill-with-docs` loads `overview.md` first — this is what makes every later grill drill
  proportionally for free.
- On the serious path, write an **ADR per real architecture decision** under
  `docs/architecture/decisions/{NNN}-{title}.md` using the ADR template.
- Register `docs/charter.md` appropriately and keep it compact: capture settled decisions and their
  *why*, not the conversation.
- Set the at-a-glance mirror in `.codument-meta.json`: add
  `"charter": { "seriousness": "<demo|serious>", "established": "<today ISO date>" }`. The charter
  doc stays the source of truth; this is just a convenience marker. Leave the rest of the meta file
  untouched.

## Rules

- Do not ask the user's experience level. Ever.
- Do not branch behavior on inferred experience — only verbosity adapts.
- Do not dump a questionnaire; one decision at a time, recommendation-first.
- Do not run the gate when a charter already exists, or on a pure question / read-only request.
- Do not present an unresearched guess as established fact on the serious path.
- Do not start source edits during the charter gate — this sets direction, it does not implement.
- Keep `docs/charter.md` compact and durable; do not preserve working chatter.
