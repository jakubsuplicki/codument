---
status: draft
---

# Plan 37: brownfield charter — derive from the code, confirm in one message

The 2026-08-07 Expo-app field report: the charter gate fired on an app that had been shipping on
SQLite and Firebase for months and walked the agent through datastore, auth, and hosting choices.
"Pure ceremony. It's built for greenfield and has no notion that a project might already have made
these decisions in code."

Verified: `skills/establish-charter/SKILL.md`'s When To Run tests only charter-missing +
real-work intent, and the workflow then interviews architecture → datastore → auth → hosting
regardless of what the codebase settled long ago. Plan 35 made `init` map existing code in the
same command, so an uncharted-but-mature project now typically greets the gate with a populated
registry the skill never consults.

## Why

- Interviewing through decisions already shipping is worse than ceremony: an answer that
  contradicts the code is either silently ignored or an accidental migration decision. Deriving
  and confirming keeps everything the charter is for — seriousness, the stack's why, the bias on
  every later grill — without re-deciding decided things.
- The stack is usually legible from the repo (dependencies, config, infra files); what is not
  derivable is seriousness, which stays the one real question.

## Scope

- `skills/establish-charter/SKILL.md` + installed `.agents/skills/` copy
- `src/lib/scaffold.ts` `buildManagedSection()` — one clause on the charter routing bullet — and
  the regenerated in-repo managed blocks
- `docs/features/project-charter-gate.md` — record the decision; compact its stale shipped
  Delivery Plan while touching it (the standard's compaction-on-ship rule, applied to this doc
  only — the global never-compacted problem stays on the backlog)
- `tests/` scaffold test — pin the bullet wording
- `CHANGELOG.md`, `docs/.registry.json`

## Non-goals

- **No new CLI command and no detection code.** The skill reads what already exists (registry
  from init's scan, manifest dependencies, config files); "mature codebase" is the agent's
  judgment call, exactly like real-work intent already is — never a string match.
- **No change to greenfield behavior**, to the seriousness question, or to the no-experience-question
  rule. Charted projects still never re-fire.
- **No ADRs for derived status quo.** Mechanically minting five ADRs that restate what the code
  does is bloat; ADRs stay reserved for decisions actually made (or changed) at charter time.

## Decisions (settled)

- **The skill gains a read-before-asking step.** Before Q1, look at the repo: registry contents,
  `docs/overview.md`, manifest dependencies, config/infra files. A project with substantial
  working code takes the brownfield path.
- **Brownfield path: derive, then confirm in one message.** Derive each core dimension
  (architecture style, datastore, auth, hosting; scale/testing where visible) from the code and
  present a single confirm-first message — the derived charter, each line carrying its evidence
  in plain words ("`expo-sqlite` in dependencies → SQLite on-device") — plus the seriousness
  recommendation (a shipping app defaults to serious). One confirmation, not a questionnaire;
  only a genuinely underivable dimension earns its own question, in the existing recommendation
  format.
- **Contradiction rule.** The user correcting a derived line is a migration decision: route it to
  the normal grill/plan loop. Never write a charter that says what the code does not do.
- **Provenance is recorded.** Derived lines carry "derived from code at adoption" as their
  rationale, so later grills know the confidence source. Newly made decisions keep the existing
  ADR treatment.
- **The managed-section bullet gains one clause**: on a project whose codebase already has working
  code, the charter is derived from the code and confirmed, not interviewed. Existing projects
  inherit it via `codument update`.

## Delivery Plan

- [ ] **Step 1 — Skill brownfield path.** Read-before-asking step, the derive-and-confirm message
      shape, the contradiction rule, provenance wording; persist/mirror behavior unchanged.
      Mirror the installed copy.
- [ ] **Step 2 — Managed-section clause.** Add the clause in `buildManagedSection()`, regenerate
      the in-repo managed blocks through the same path, pin the wording in the scaffold test.
- [ ] **Step 3 — Feature doc + wiring.** Record the decision in
      `docs/features/project-charter-gate.md`, compact its stale shipped Delivery Plan, update
      CHANGELOG and registry.

## Acceptance criteria

- An uncharted repo with mapped working code + a real-work message → one derived-charter confirm
  message with per-line evidence; no datastore/auth/hosting interview; on confirm,
  `docs/charter.md` exists with derived provenance and the overview mirror.
- A genuinely fresh project gets today's interview unchanged; a charted project still never
  re-fires.
- After `codument update`, the managed block carries the brownfield clause.

## Verification strategy

- Unit: the scaffold test pins the routing bullet's new clause and position.
- The interview itself is prose-governed (the stance the original charter feature took): a
  scripted transcript walkthrough on a fixture repo with recognizable dependencies validates the
  brownfield path, plus one greenfield transcript confirming no regression.
