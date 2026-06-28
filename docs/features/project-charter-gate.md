---
title: Project Charter Gate
status: current
---

## Summary

An upfront, agent-driven gate that establishes a project's **seriousness** (quick demo vs.
serious/enterprise app), then leads **every** user through the core tech and architecture
questions — recommendation-first, each explained in plain language with its trade-off — so even
a non-technical user understands and learns from the choices they make. Seriousness sets *depth*
(serious → drill harder, research uncertain choices, write ADRs; demo → same questions but lighter,
with a sensible default pre-picked per choice and no research/ADRs). The captured intent lives in a
durable `docs/charter.md` (with a 2-line summary mirrored into `docs/overview.md`) so every later
grill reads it and drills accordingly.

This fixes the current implicit default where the loop assumes a project is a quick demo and
asks only shallow, per-change questions — fine for a vibe-coded demo, wrong for a serious build
where architecture / datastore / auth / scaling decisions must be made early and on purpose.

**Upskilling is the point, not a side effect.** We do not ask the user how experienced they are
and we do not branch on it — branching on experience would gate the vibe coder out of the real
questions and cap their learning. Instead, everyone gets the same important questions; the
recommendation carries enough plain-language explanation and trade-off that a non-technical person
can follow it, while an expert skims. Experience is *inferred live* from how the user answers and
the agent's verbosity adapts to it — never asked, never a gate.

## Problem

Today the questions a user hears when "running the project" come from the grilling loop
(`AGENTS.md` intent routing → `grill-with-docs`). That loop is reactive and per-change: it
surfaces one load-bearing assumption at a time. It never establishes, upfront:

- **How serious is this project?** (throwaway demo vs. production system)
- **What stack/architecture/datastore fits?** — and it never proactively researches the answer,
  nor explains the choices in terms a non-technical user can learn from.

So load-bearing architecture decisions get made implicitly and late, serious projects get
demo-grade grilling, and users never learn *why* a choice was made.

## Decisions (settled with user)

- **Trigger:** agent-driven, no new CLI command. The user's flow is **install → `codument init`
  → start chatting**; `init` is silent scaffolding and the interview is conducted by the agent in
  chat (the CLI can't grill). The gate fires when **both** hold: (1) no `docs/charter.md` exists, and
  (2) the user's message is **real-work intent** — building or changing something (a feature, the
  app, "let's make X"). A **pure question or read-only request** on an uncharted project does **not**
  trip it — the agent just answers and the gate waits for the first real-work turn. This is
  judgment-based (not a string match), encoded in the skill + routing prose. (Considered and
  rejected: firing on the very first message of any kind — too pushy on a plain question; and an
  opt-in "want to set up a charter?" prompt — softens "enforced" too much. Also rejected: a
  `codument charter` command; "there is no `codument run`" — the gate belongs in instructions.)
- **Lead axis = seriousness only, never experience.** The single opening question is *demo/throwaway
  vs. serious/enterprise app*. We do **not** ask the user's experience and do **not** branch on it —
  branching on experience would demean the vibe coder and cap their learning. Everyone gets the same
  important questions; experience is inferred live and only tunes the agent's verbosity.
  (Considered and rejected: a two-axis tier + experience gate — it gated beginners out of the real
  questions, contradicting the upskilling goal.)
- **Both paths lead through the core tech questions; seriousness sets depth.** Demo and serious both
  walk architecture / datastore / auth / hosting. **Demo:** same questions, lighter — each carries a
  pre-picked sensible **default** the user can accept fast, fewer follow-ups, "you can revisit later,"
  no research, no ADRs. **Serious:** drill harder, spin research agents for genuinely uncertain
  choices, write ADRs.
- **Every recommendation teaches.** Each tech question leads with a concrete recommendation, a
  one-line plain-language *what this means*, and the **key trade-off vs. the main alternative** — so a
  non-technical person understands and chooses, and an expert skims. Never present an unresearched
  guess as fact.
- **Charter home:** **`docs/charter.md` + `docs/overview.md`.** The charter doc holds seriousness and
  stack rationale; a 2-line summary is mirrored into `overview.md` (which every grill already loads).
  Stack choices that are real architecture decisions also get **ADRs** under
  `docs/architecture/decisions/`. (Considered and rejected: ADRs-only — seriousness fits the ADR
  format awkwardly.)

## Non-goals

- No new CLI command (`codument charter` is explicitly out).
- No interactive prompts in CLI code — the interview is conducted by the agent in chat, not by
  Node `readline`. CLI changes are limited to scaffolding the skill + template + meta field.
- Not a replacement for `grill-with-docs` — the charter gate runs **once, before** the normal
  per-change grilling loop, and then biases it. Per-change grilling is unchanged in mechanics.
- No auto-research on every choice — research is reserved for genuinely uncertain decisions on the
  serious path.
- **Does not ask the user's experience level**, and never branches behavior on it.
- Does not block demo projects: the lead question + lightweight defaulted tech questions, then it
  steps aside.

## How It Works

1. **Scaffold (CLI):** `establish-charter` is added to `DELIVERY_SKILLS` so `init`/`update` install
   it for every agent profile. A `charter.md` template is added and copied on `init` only if the
   user opts to seed it (otherwise the skill writes it live). `.codument-meta.json` gains an
   optional `charter: { seriousness, established }` field for at-a-glance status (the doc remains the
   source of truth).
2. **Routing hook (instructions):** `buildManagedSection()` in `src/lib/scaffold.ts` — the single
   source of the managed block written into `AGENTS.md`/`CLAUDE.md` — gains a **first** intent-routing
   bullet: *before the normal grill, if no `docs/charter.md` exists **and the user's message is
   real-work intent (building/changing something, not a pure question or read-only request)**, run
   the charter gate first.* Existing projects pick this up on `codument update`. The
   `buildClaudeManagedSection()` wrapper inherits it automatically.
3. **The skill (`establish-charter`):** conducts the adaptive interview:
   - **Q1 (always):** seriousness only — *quick demo/throwaway vs. serious/enterprise app I intend
     to ship and maintain* — recommendation-first, framed plainly. No experience question.
   - **Then, on BOTH paths, lead through the core tech questions** — architecture style, datastore,
     auth, hosting (plus scale/testing on the serious path). Each question leads with a concrete
     recommendation, a one-line plain-language *what this means*, and the **key trade-off vs. the main
     alternative**, so a non-technical user can follow and learn.
   - **Demo → lighter:** every core question carries a pre-picked sensible **default** the user can
     accept in one go; fewer follow-ups; explicit "you can revisit later"; **no** research agents,
     **no** ADRs. Write a charter with `seriousness: demo`.
   - **Serious → drill:** push deeper on each choice; **spin a research agent** (web-capable) for any
     choice that is genuinely uncertain or where best practice may have moved, then present a
     recommendation-first synthesis (never a raw dump); write `seriousness: serious`.
   - **Adapt verbosity live:** infer the user's fluency from their answers — terser when they're
     clearly fluent, more teaching when they ask "what's X?" — but never ask their experience and
     never skip a question because of inferred experience.
   - **Persist:** write `docs/charter.md`, mirror a 2-line summary into `overview.md`, and (serious
     path) write an **ADR per real architecture decision** (datastore, auth model, etc.). Set
     `last_updated`.
4. **Downstream bias:** because `overview.md` carries the tier and `grill-with-docs` already loads
   it first, every later grill reads the tier and drills proportionally — serious projects get
   harder grilling for free; demos stay light.

## Acceptance Criteria

- Fresh `init` then "let's build X" → agent runs the charter gate first (no charter doc yet),
  and the single opening question is **seriousness only** (demo vs. serious) — the user's experience
  is never asked.
- Demo answer → still led through the core tech questions, each with a pre-picked default and a
  plain-language recommendation + trade-off; user can accept defaults fast; `docs/charter.md` exists
  with `seriousness: demo`; no ADRs/research; `overview.md` shows a 2-line summary.
- Serious answer → deeper, recommendation-first grilling into arch/DB/auth with plain-language
  trade-offs; at least one ADR written for a real decision; a research agent is used for at least one
  genuinely uncertain choice (output synthesized recommendation-first, not dumped raw).
- Every tech recommendation a user sees includes a plain-language "what this means" and the trade-off
  vs. the main alternative (verified by reading the skill's required output shape).
- Existing already-documented project (charter present, or `overview.md` already populated) →
  gate does **not** re-fire; normal loop runs.
- `codument update` on a project initialized before this feature → the new routing bullet appears in
  the managed section of `AGENTS.md`/`CLAUDE.md`.
- `establish-charter` appears in `DELIVERY_SKILLS` and is installed by `init`.

## Verification Strategy

- **Unit (`src/lib/scaffold.ts`):** assert `buildManagedSection()` contains the charter-gate routing
  bullet and that it is the first routing rule. Add to existing scaffold/init test coverage.
- **Unit (`src/lib/agent-profiles.ts`):** assert `establish-charter` is in `DELIVERY_SKILLS`.
- **Init/update integration:** assert the `establish-charter` skill file is installed under each
  profile's skills dir, and the managed-section update path emits the new bullet.
- **Meta:** assert the optional `charter` field round-trips and is absent until set.
- **Manual / scripted walkthrough:** run the demo path and the serious path against a throwaway repo,
  confirming the acceptance criteria above (the interview itself is agent-conducted, so its behavior
  is validated by the skill prose + a manual transcript, not a unit test).

## Delivery Plan

- [ ] **Step 1 — Charter skill.** Author `skills/establish-charter/SKILL.md`: the adaptive,
  tier-gated interview (Q1 always; demo stops; serious proportional grill; research-when-uncertain;
  persist to `charter.md` + mirror to `overview.md` + ADR per real decision). Add `charter.md`
  template to `templates/`. No source/CLI behavior yet → trivial-review tier.
- [ ] **Step 2 — Register & install the skill.** Add `establish-charter` to `DELIVERY_SKILLS` in
  `src/lib/agent-profiles.ts`; confirm `init`/`update` install it. Unit test the list membership and
  installation. Full review (interface/data list change).
- [ ] **Step 3 — Routing hook in managed section.** Add the charter-gate bullet as the first
  intent-routing rule in `buildManagedSection()` (`src/lib/scaffold.ts`); regenerate the in-repo
  `AGENTS.md`/`CLAUDE.md` managed blocks via the same path. Unit test the bullet's presence and
  position. Full review (changes the contract every project inherits).
- [ ] **Step 4 — Meta `charter` field.** Add the optional `charter: { seriousness, established }` field to
  `.codument-meta.json` writing/reading; test round-trip and absence-by-default. Full review
  (data-shape change).
- [ ] **Step 5 — Docs + registry.** Finalize this feature doc, register
  `src/lib/...`/skill/template under `docs/.registry.json`, update
  `docs/features/agent-delivery-workflow.md` to mention the charter gate as loop step 0,
  set `last_updated`. Trivial-review tier.

## Key Files (to touch)

- `skills/establish-charter/SKILL.md` (new) — the interview skill.
- `templates/charter.md` (new) — durable charter doc template.
- `src/lib/agent-profiles.ts` — add to `DELIVERY_SKILLS`.
- `src/lib/scaffold.ts` — the charter-gate routing bullet in `buildManagedSection()` (the shared contract generator, which also carries the quality bar and the documentation-altitude standard — those are change-control concerns, see [[registry-health-and-change-control]]).
- `src/commands/init.ts` / `src/commands/update.ts` — inherit install + meta field (mostly no-change).
- `.codument-meta.json` writer — optional `charter` field.
- `docs/.registry.json`, `docs/overview.md`, `docs/features/agent-delivery-workflow.md` — docs wiring.
- Tests: `tests/scaffold*.test.ts` / `tests/init*.test.ts` (or nearest existing), meta round-trip test.
