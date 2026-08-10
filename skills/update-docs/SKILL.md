---
name: update-docs
description: >
  Run this skill to document the project. Reads source code and writes real
  documentation following the project's doc architecture. Use after `codument scan`
  to fill in all scaffold docs, or anytime to update docs after code changes.
  Invoke with /update-docs to bootstrap all documentation or keep it current.
---

# Documentation Workflow

## How to Document

You are writing documentation that another developer will read to understand this project. Your goal is to explain **why things exist and how they fit together** — not to restate what the code already says.

### What good documentation looks like

Follow the documentation standard (the `doc-audience-layers` concept) — these are its layers, and the test for every line is "would this survive a refactor that renamed every symbol and reordered every line?":

- **In plain terms**: 2-3 sentences a reader takes in 10 seconds to know if this is relevant to them. No jargon.
- **Design approach**: why it is shaped this way — the forces and the chosen-vs-rejected approach, at role level. No identifiers, counts, or call order; that is mechanism, it drifts, and the agent reads it live from the code.
- **Invariants & boundaries**: what must always hold or is forbidden — the landmines a reader cannot see in the local code, and what the feature deliberately does NOT do. Link each invariant to the test that enforces it, or mark it "untested". This is consistently the most valuable section.
- **Decisions**: pointers to the ADRs that hold the durable why. Reference, never restate.
- **Key files**: each file's one-line narrative role (orchestrator / analyzer / seam) — not its exports. The registry holds the exact file list.

### What bad documentation looks like — do NOT write this

- Restating function names as descriptions ("readRegistry reads the registry")
- Listing exports without explaining what they're for
- Copy-pasting large code blocks instead of referencing file paths
- Revision history, glossaries, or timeline sections
- Vague descriptions ("handles X logic for the application")

## Start from `codument doctor`

Before writing anything, find out what actually needs work — don't guess. `codument doctor` is the deterministic gap list; let its **findings** (warnings) drive the pass, and re-run it after each fix so you can watch the finding clear. A finding that re-runs clean is the done signal — there is no separate sign-off.

`doctor` also prints **Notes** (informational). Notes are *not* findings — clearing them is not the goal, and "clean" is defined over findings only. Read them, act only if one points to something genuinely wrong (see high-fanout below). Never edit the registry just to make a note disappear.

```bash
codument doctor          # human-readable
codument doctor --json   # stable contract to consume programmatically
```

Fix each finding by its type — the doc fix is **not** the same for every one:

- **bloated-doc** — *compact, don't rewrite.* The message names the signal that tripped:
  - `N completed-log items` — a `[x]` delivery-plan checklist was never compacted. The work is already recorded in git history; delete or collapse the done log and keep only the durable decisions it produced.
  - `section "X" is N lines` — split that section out, or summarize it down to its decisions.
  - `N lines (> …)` — trim the doc to its durable core (the standard's layers: In plain terms, Design approach, Invariants & boundaries, Decisions, Key files). A shipped plan leaves no delivery checklist behind — that is the most common over-size cause.
  - Compact to the durable core, then **stop** — do not shave lines to slip just under the limit. The threshold is a prompt to review length, not a number to hit. If the genuine durable core still exceeds it (every line earns its place), raise `--max-doc-lines` / `--max-section-lines` for the repo rather than cutting content that belongs.
- **missing-doc** — a registered feature has no doc; create it from the template below.
- **unmapped-source** — a real source file has no owner; assign it to a feature in `docs/.registry.json`, or split out a new feature doc (see the entry points below).
- **generated-leakage** — a file matching an exclusion rule (build/generated/test/data, e.g. `dist/**`, `*.seed.json`) is listed as a source. Usually de-list it — it is not tracked source, so don't write docs for it. But confirm the label fits first: the heuristic matches by path, so it can misfire on hand-authored data (a `*.seed.json` that is a real source of truth). If it's genuinely authored content you want tracked, adjust the exclusion rather than forcing docs onto it — and never drop a file that matters just to clear the finding.
- **empty-depends-on** — registry shape, not prose: a mature feature declares no `depends_on`; read its imports and declare the real edges to the features it builds on.

A **note** has its own rule:

- **high-fanout** (informational) — a file is mapped across many features. This is usually *correct*: shared infra (security rules, shared types, a root layout, a barrel file) is meant to be mapped widely, and that breadth is exactly what lets `codument review` flag every dependent when the file changes. **Do not collapse a shared file to a single owner to silence this** — that destroys the dependent-tracking signal it exists to provide, and a single owner is often the wrong one. Act only if the breadth is *wrong*: a test helper, fixture, or unrelated utility accidentally mapped into many features should be removed from the ones that don't truly own it. Genuinely-shared infra: leave it mapped widely.

After you change code, `codument review` is the companion check — it flags docs that went **stale** (a source changed but its mapped doc didn't) for the current diff. Update those the same way (see "Updating docs after code changes" below), then re-run `codument review` to confirm they clear.

## Three Entry Points

### 1. Planning a new feature

Developer says "plan out feature X" or "let's build X" — this is `plan-with-docs`' job:
1. Write the durable doc in the standard's layers (In plain terms, Design approach, Invariants & boundaries, Decisions, Key files) plus a transient `## Delivery Plan` block; align on scope before writing code
2. Fill the durable layers as you build; the Delivery Plan tracks the steps
3. On ship, the Delivery Plan compacts out (plan-with-docs → Compaction on ship), leaving the durable doc in the standard's layers

### 2. Filling in scaffold docs (after `codument scan`)

Scan creates doc files with frontmatter and file listings but no content. You are the **orchestrator**. If the active agent supports subagents, delegate the actual writing to the `doc-writer` agent so each feature gets its own focused context window. Otherwise, process features one at a time in the main session.

**Process:**

1. Read `docs/.registry.json` to find all entries with `status: "needs-review"`
2. For each entry, spawn a **doc-writer agent** when available, or handle the entry inline with the same specific instructions:

   ```
   Read these source files: [list from registry entry's sources array]
   Write documentation to: [doc path from registry entry]
   Follow the documentation standard's layers: In plain terms, Design approach, Invariants & boundaries (link each invariant to its enforcing test), Decisions (ADR pointers), Key files (narrative role). No mechanism in prose — no signatures, counts, or copy-pasteable examples; the agent reads those live from the code.
   Update docs/.registry.json: set status to "current", update depends_on based on imports, set last_reviewed to today.
   ```

   **Be specific in your instructions to the agent.** Don't just say "document this feature." Tell it exactly which files to read, which doc to write, and what sections to include. Agent failures are almost always invocation failures — vague instructions produce vague docs.

3. For small projects (< 6 features), you can process them in parallel. For larger projects, batch 3-5 at a time to avoid overwhelming the system.

4. After all agents complete, read the registry and verify all entries are `"current"`. Fix any that the agents missed.

**Why sub-agents?** A codebase with 40 features and 200 source files can exhaust the main context window. When the active agent supports subagents, each doc-writer gets a focused context with only its feature's source files. When subagents are not available, use smaller batches and preserve progress in the docs.

### 3. Splitting oversized docs

When filling in a scaffold doc, check if it covers too many unrelated concerns. A doc should be split when:
- It covers **more than ~10 source files** that serve clearly different purposes
- The files span **distinct features** (e.g., auth logic and payment logic grouped under one `api.md`)
- You can't write a coherent 2-3 sentence Summary because the module does too many unrelated things

How to split:
1. Identify the natural feature boundaries — look at what the files actually do, their imports, and which ones work together
2. Create new doc files for each feature group: `docs/features/{feature-name}.md`
3. Move the relevant source files to the new registry entries
4. Remove the oversized entry from the registry (or keep it if some files still belong there)
5. Fill in each new doc following the normal template

Example: a `components.md` covering 30 React components should be split by domain — `docs/features/auth-ui.md`, `docs/features/dashboard.md`, `docs/features/settings.md` — grouping components by what feature they serve, not by the directory they sit in.

Use your judgment. A `lib.md` covering 6 tightly related utility modules is fine as one doc. A `pages.md` covering 15 unrelated page routes should be split.

### 4. Updating docs after code changes

For single-feature updates, do this inline (no agent needed):
1. Run `codument context --file <path> --owner` for the doc mapped to the changed file (a flat registry read answers the same question at the cost of the whole map)
2. Open the doc, compare against your code changes
3. Make the two-way call:
   - **A documented contract or behavior changed** → update only the now-outdated layers at intent altitude (the standard above — the contract, the design, the why; never a symbol mirror or an export dump). Don't rewrite the whole doc.
   - **A pure-internal refactor changed no documented contract** → do not edit prose to clear `codument review`. Record it: `codument ack <path>::<symbol> --reason "<the invariant that stayed constant>"`. Default to updating the doc; ack only when you can name in one clause what stayed constant.
4. If your change affects the feature's public interface, check `depends_on` and flag dependent features.
5. **If the section you must edit is written at mechanism altitude, rewrite that section — and only that section.** A legacy doc written wall-to-wall in mechanism voice (hex values, call sequences, symbol mirrors) offers a false choice: match its voice and write what the standard forbids, or write to the standard and leave the doc in two registers. Neither is the answer. Rewrite the section your edit touches to the standard, and leave every section you did not touch alone. Rewriting the whole doc is its own decision for whoever owns it — a scope the gate never asked for, and a diff nobody planned to review. The prose-altitude lint already names the other offending sections; that list is a proposal for a future step, not this step's work.
6. **Bring a stale `status` current in the same step.** Registry `status` is authored metadata nothing maintains automatically, so a `needs-review` entry stays `needs-review` after its doc has been rewritten and its gate driven green — the field repo's i18n entry did exactly that. When resolving a feature's docs genuinely brings them current, say so in `docs/.registry.json` while you are there. Do not touch a status your edit did not earn.

For large refactors touching multiple features, delegate to doc-writer agents per affected feature to avoid context bloat.

## Feature Doc Template

```markdown
---
title: Feature Name
status: current
type: feature
last_reviewed: YYYY-MM-DD
---

## In plain terms

2-3 sentences: what this is and whether a reader cares for their task. No jargon.

## Design approach

Why it is shaped this way — the forces and the chosen-vs-rejected approach, at
role level. No identifiers, counts, or call order; that is mechanism and lives in
the code. Would it survive a rename-everything refactor?

## Invariants & boundaries

What must always hold or is forbidden — the landmines not visible in local code,
and what the feature deliberately does NOT do. Link each to its enforcing test,
or mark it "untested".

## Decisions

Pointers to ADRs (docs/architecture/decisions/). The durable why; reference, never restate.

## Key files

- `src/path/to/file.ts` — narrative role (orchestrator / analyzer / seam)
```

### The layers are fixed, not conditional

Use these five layers for every feature. Do not add sections the standard
excludes: no API/Interface signature dumps or copy-pasteable usage examples
(that is mechanism — it drifts, and the agent reads it live from the code), no
revision history, no glossaries. Edge cases and non-goals belong in
**Invariants & boundaries**; links to ADRs and dependent docs belong in
**Decisions**.

## Concept Doc Template

Use for cross-cutting concerns (data model, error handling, deployment). The same five layers, in `docs/concepts/`.

## ADR Creation

When you make a significant architectural choice (choosing a library, designing a data model, picking an approach over alternatives), suggest creating an ADR:
- Location: `docs/architecture/decisions/{NNN}-{kebab-case-title}.md`
- Use sequential four-digit numbering (001, 002, ...)
- Include: Context, Decision Drivers, Considered Options, Decision Outcome, Consequences

## Registry Operations

The registry at `docs/.registry.json` maps source files to their documentation.

### Adding a new entry
```json
{
  "feature-name": {
    "doc": "docs/features/feature-name.md",
    "type": "feature",
    "primary_sources": ["src/path/to/file.ts"],
    "related_sources": [],
    "docs": [],
    "depends_on": ["other-feature"],
    "risk": [],
    "status": "current"
  }
}
```

### Registry keys
- Short, lowercase names a developer would say out loud: `auth`, `payments`, `cli`
- Keys match doc filenames: `auth` → `docs/features/auth.md`

### Status values
- `current` — docs are up to date
- `stale` — source files changed but doc wasn't updated
- `needs-review` — generated by scan, needs to be filled in

## Rules

- Keep docs lean — dense and high-signal, not exhaustive
- Never document unverified behavior — if uncertain, use `<!-- NEEDS REVIEW: [specific question] -->`
- Keep mechanism out of prose — no signatures, counts, ordered call sequences, or copy-pasteable code; the agent reads those live from the code. Key files carries narrative role, not paths the registry already holds.
- Every doc follows the standard's layers: In plain terms, Design approach, Invariants & boundaries, Decisions, Key files
- Prefer explaining WHY over WHAT — the code shows what, docs explain why
- Do NOT add: revision history tables, glossaries, UML diagrams, project timelines
