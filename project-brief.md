# Codument — Project Brief & Specification

## What This Document Is

This is the complete specification for building an open-source npm package that automates documentation for JavaScript/TypeScript projects using Claude Code. It synthesizes decisions from multiple research rounds and design discussions. **Use this as the single source of truth when building the package.**

---

## 1. Project Overview

### What It Is

An npm package (devDependency) that installs Claude Code skills, rules, sub-agents, and a documentation registry system into any JS/TS project. Once installed, Claude Code automatically documents features as the developer builds them — no manual prompting required.

### The Problem It Solves

Documentation is everyone's least favorite task. It rots fast, goes out of sync, and developers treat it as an afterthought. AI coding assistants like Claude Code make this worse — they generate code fast but never document it unless explicitly asked. This package makes documentation an automatic byproduct of development by encoding documentation workflows into Claude Code's skill and rule system.

### Who It's For

JavaScript/TypeScript developers using Claude Code (in VS Code or terminal) who want their projects to stay documented without manual effort. Works for solo developers and teams.

### Distribution

Open source on npm. Free. MIT license. Published as `codument`.

### Market Gap

14+ existing Claude Code scaffolding tools were analyzed (claude-code-templates, context-forge, claude-collective, claude-forge, etc.). None center documentation as the primary workflow. All focus on code quality, testing, or general Claude Code setup. Documentation-first automation is unoccupied territory.

---

## 2. Installation & Usage Flow

### Install

```bash
npm install -D codument
```

### Initialize

```bash
npx codument init
```

This one-time command:
- Detects project type (TS/JS, framework, directory structure) by checking `tsconfig.json`, `package.json` dependencies, and `src/` structure
- Creates the `docs/` directory with the documentation structure
- Creates `.claude/` configuration (skills, rules, agents)
- Adds a managed section to `CLAUDE.md` (using `<!-- codument:start -->` / `<!-- codument:end -->` markers so it never clobbers existing content)
- Creates `docs/.registry.json` (the source-to-doc mapping index)
- If a `docs/` folder already exists, **ignore it** — don't merge, don't reorganize. The existing docs serve only as context for the bootstrap scan. The package creates its own fresh structure.

### Bootstrap Scan (for existing projects)

```bash
npx codument scan
```

This expensive one-time command:
- Reads existing codebase to understand features, modules, and architecture
- Reads any existing documentation (old `docs/`, READMEs, JSDoc, inline comments) purely for context
- Generates fresh documentation in the new structure
- Populates `docs/.registry.json` with source-to-doc mappings
- Uses parallel sub-agents for heavy lifting
- Marks uncertain sections with `<!-- NEEDS REVIEW: [specific question] -->`
- Outputs `docs/TODO.md` listing areas needing human review
- Tracks scan results in `.codument-meta.json`

### Update (when package improves)

```bash
npm update codument
npx codument update
```

- Skills loaded from `node_modules/` via Claude Code's `--add-dir` update automatically with `npm update` — no manual sync needed
- The `update` command handles files that must live in the project (`.claude/settings.json`, `CLAUDE.md` managed section, rules)
- Uses mrm-style codemods for non-destructive updates
- Version tracking via `.codument-meta.json` (records package version and file hashes)
- Logic: upstream changed + user didn't modify → overwrite; both changed → section-based merge; only user changed → skip
- Supports `--dry-run` to preview changes

### Then What?

**The developer just uses Claude Code normally.** That's it. The skills, rules, and CLAUDE.md instructions make Claude documentation-aware automatically. When Claude modifies source files, the path-scoped rule fires, the registry is consulted, and docs are updated as part of the normal development flow.

---

## 3. Runtime Behavior — How It Actually Works

### The Enforcement Stack (Layered, Redundant)

No single mechanism reliably ensures documentation updates. The package uses multiple layers that reinforce each other:

**Layer 1 — CLAUDE.md (always loaded, sets expectations)**
Contains the Definition of Done checklist and documentation maintenance rules. Loaded at every Claude Code session start. Lightweight — under 60 lines for the managed section.

**Layer 2 — Path-scoped rules (contextually triggered)**
`.claude/rules/documentation.md` with `paths: ["src/**/*.ts", "src/**/*.tsx"]` frontmatter. Loads automatically into Claude's context whenever it touches source files. This is the strongest enforcement mechanism because it injects instructions directly into Claude's context at the exact right moment.

**Layer 3 — Documentation skill (on-demand workflow)**
`.claude/skills/update-docs/SKILL.md` — loaded when Claude determines it's relevant (via description field matching) or when developer types `/update-docs`. Contains the complete documentation workflow: check registry, find affected docs, update or create using template, update registry.

**Layer 4 — Sub-agents (isolated context for heavy work)**
`doc-writer` agent for creating/updating feature docs. `doc-scanner` agent for bootstrap scanning. Run in isolated context windows — critical for the scan command which processes many files without polluting the main conversation.

**Layer 5 — PostToolUse hook (human-facing safety net)**
A hook in `.claude/settings.json` matching `Write|Edit` events. Runs a shell script that checks if source files were modified without corresponding doc updates. Outputs a warning to the terminal. Note: Claude does NOT see this output — it's a nudge to the developer, not to Claude.

### What Claude Actually Sees and Responds To

- CLAUDE.md rules — always in context
- Path-scoped rules — injected when source files are accessed
- Skill instructions — loaded on demand

The hook warning is developer-facing only. Claude's documentation behavior is driven entirely by layers 1-3.

### Realistic Reliability Expectation

With all layers active, Claude updates docs alongside code ~90-95% of the time. The remaining 5-10%, the developer notices (via hook warning or their own review) and says "update the docs for what you just changed." Claude already knows HOW because of the skill — it just needs the nudge.

100% reliability isn't possible because Claude is a language model making probabilistic decisions, not a deterministic program. The missing primitive is a hook type that can inject messages back into Claude's conversation — if Anthropic adds this, full automation becomes possible.

### Three Entry Points the Skill Must Handle

1. **Explicit planning** — developer says "plan out the auth feature" → Claude creates doc with Summary, DoD, Non-goals first, then builds
2. **Implicit new feature** — developer says "add OAuth to login" → Claude detects significant new functionality, creates doc alongside code
3. **Modification to existing feature** — Claude modifies a source file → registry lookup finds existing doc → doc is updated

---

## 4. The Documentation Registry

### Purpose

The registry (`docs/.registry.json`) is the single source of truth mapping source code files to their documentation. It enables fast, deterministic lookups — Claude doesn't have to guess or scan directories to find which doc to update.

### Format

Single JSON file. One file for the whole project (not split per feature). Rationale: Claude opens one file and has the complete map. Split files would require globbing across directories, costing context and time.

Located at `docs/.registry.json` — dotfile so it doesn't clutter the docs directory visually, committed to git, versioned with everything else.

### Schema

```json
{
  "features": {
    "auth": {
      "doc": "docs/features/auth.md",
      "type": "feature",
      "sources": [
        "src/auth/login.ts",
        "src/auth/oauth.ts",
        "src/auth/session.ts"
      ],
      "depends_on": ["database", "encryption"],
      "last_updated": "2026-03-29",
      "status": "current"
    },
    "payments": {
      "doc": "docs/features/payments.md",
      "type": "feature",
      "sources": [
        "src/payments/stripe.ts",
        "src/payments/webhook.ts"
      ],
      "depends_on": ["auth", "database"],
      "last_updated": "2026-03-28",
      "status": "current"
    },
    "database": {
      "doc": "docs/concepts/database.md",
      "type": "concept",
      "sources": [
        "src/db/client.ts",
        "src/db/migrations/",
        "src/db/models/"
      ],
      "depends_on": [],
      "last_updated": "2026-03-27",
      "status": "current"
    }
  }
}
```

### Registry Keys

- Use the simplest possible name for the concept: `auth`, `payments`, `notifications` — not `user-authentication-system` or `stripe-payment-processing`
- Short keys that a developer would naturally say out loud
- These keys also correspond to doc filenames: `auth` → `docs/features/auth.md`

### Two Document Types

1. **`feature`** — maps to specific source files, has clear boundaries. Lives in `docs/features/`
2. **`concept`** — cross-cutting concerns (database layer, deployment, error handling patterns) that span many files. Lives in `docs/concepts/`

### Status Values

- `current` — docs are up to date
- `stale` — source files were modified but doc wasn't updated in the same session
- `needs-review` — generated by bootstrap scan, needs human verification

### How the Registry Is Used at Runtime

1. Claude modifies `src/auth/login.ts`
2. Path-scoped rule fires: "Check `docs/.registry.json` for this file"
3. Claude opens registry, finds `src/auth/login.ts` → maps to `auth` feature → `docs/features/auth.md`
4. Claude opens that doc, verifies it's still accurate, updates if needed
5. Updates `last_updated` timestamp in registry
6. Checks `depends_on` — if the change affects the auth interface, flags `payments` (which depends on auth) as `stale`

### Registry Maintenance

The skill workflow always includes "update `docs/.registry.json` with any new file mappings" as a step. The bootstrap scan generates the initial registry. From that point forward, the skill maintains it incrementally.

---

## 5. Documentation Structure

### Directory Layout

Follows the Diátaxis framework (adopted by Django, Cloudflare, Gatsby, Kubernetes, Python). The package creates:

```
docs/
├── .registry.json           # Source-to-doc mapping index
├── overview.md              # What this project is, high-level architecture
├── getting-started.md       # Setup, dev environment, first run
├── features/                # One .md per feature (the primary doc type)
│   ├── auth.md
│   ├── payments.md
│   └── notifications.md
├── concepts/                # Cross-cutting architectural docs
│   ├── database.md
│   ├── api-design.md
│   └── error-handling.md
├── architecture/
│   └── decisions/           # Architecture Decision Records (ADRs)
│       ├── 001-use-typescript.md
│       └── 002-stripe-over-square.md
└── guides/                  # How-to guides for common tasks
    ├── deployment.md
    └── testing.md
```

### Naming Conventions

- **Lowercase kebab-case for all filenames** — industry standard per Google Developer Documentation Style Guide. `auth-setup.md` not `auth_setup.md` or `AuthSetup.md`. Hyphens, not underscores (search engines treat hyphens as word separators).
- **Feature doc names match registry keys** — `auth` key → `features/auth.md`. No lookup needed, it's convention.
- **ADRs use sequential numbering** — `001-use-typescript.md`. Four-digit zero-padded with kebab-case title. This is the established convention (Nygard format, MADR format).
- **No number prefixes on feature docs** — `auth.md` not `01-authentication.md`. Features aren't ordered.
- **Index files** — use `overview.md` at docs root (not `index.md` or `README.md`) to avoid confusion with repo-level README.

### Maximum Directory Depth

2-3 levels maximum. React's official guidance warns against deep nesting. The structure above never exceeds 3 levels.

---

## 6. Feature Document Template

### Design Principles

- **Planning document that becomes documentation** — you define DoD and scope first, fill in technical details as you build, and by the time everything is checked off, the doc is already written.
- **Lean for AI context efficiency** — Anthropic's engineering team warns about "context rot." HumanLayer recommends CLAUDE.md files under 60 lines. Feature docs should be dense and high-signal.
- **Minimal required core + conditional sections** — not every feature needs all sections. A small utility doesn't need Non-goals. A complex auth system needs everything.
- **Follows Diátaxis** — Summary/How It Works = explanation; API/Interface = reference; Usage Examples = how-to guide.

### Frontmatter Schema

```yaml
---
title: Feature Name
status: active | deprecated | experimental
type: feature | concept
owner: @team-or-person
sources:
  - src/auth/login.ts
  - src/auth/oauth.ts
depends_on: [database, encryption]
last_reviewed: 2026-03-29
---
```

Fields synthesized from Docusaurus, Hugo, Astro Starlight, GitHub Docs, and our registry design. The `sources` and `depends_on` fields are novel — they duplicate info in the registry but make each doc self-describing even without the registry.

### Document Sections

**Always required (minimal core):**

1. **Summary** — 2-3 sentences. What this feature does and why it exists. Always first.

2. **Definition of Done** — Checklist specific to this feature. Created during planning phase, checked off during development. The only section that's temporal — once complete, either stays as historical record or collapses to `status: active` in frontmatter.

   ```markdown
   ## Definition of Done
   - [ ] Core auth flow implemented
   - [ ] Error handling for expired tokens
   - [ ] Rate limiting on login endpoint
   - [ ] Unit tests for all auth functions
   - [ ] Integration test for full OAuth flow
   - [ ] Environment variables documented
   - [ ] Feature doc complete and reviewed
   ```

3. **How it works** — Technical design at guide level. Enough for a developer to understand the architecture without reading every line of code. Focus on trade-offs and design decisions, not implementation minutiae. Include a simple diagram if multiple components are involved.

4. **Key files** — List of source files with one-line descriptions of what each handles.

   ```markdown
   ## Key files
   - `src/auth/login.ts` — Login flow, credential validation
   - `src/auth/oauth.ts` — OAuth2 provider integration
   - `src/auth/session.ts` — Session management, token refresh
   - `src/auth/types.ts` — TypeScript type definitions
   ```

**Conditional (added by skill based on feature complexity):**

5. **API / Interface** — Exported functions, types, config options. Include TypeScript signatures and 2-3 focused code examples per major concept. Type annotations serve as inline API documentation.

   ```markdown
   ### `authenticate(credentials: AuthCredentials): Promise<AuthResult>`
   Validates user credentials and returns a session token.
   ```

   Configuration options as a table:

   | Option | Type | Default | Description |
   |--------|------|---------|-------------|
   | `timeout` | `number` | `30000` | Request timeout in ms |

6. **Usage examples** — Start with the simplest case, then show one advanced pattern. Examples should be copy-pasteable. Specify SDK/library versions to prevent AI assistants from mixing syntax across versions.

7. **Gotchas / Edge cases** — Non-obvious things, surprising behaviors, known limitations. This is consistently rated the most valuable section for developers joining a project. Claude is well-positioned to write this because it sees all the error handling and edge case code as it builds.

8. **Non-goals and boundaries** — What this feature explicitly does NOT handle. Where its responsibilities end and another feature's begin. Multiple templates (Google, GitLab, Monzo) flag this as one of the most valuable sections for preventing scope creep.

9. **Related** — Links to ADRs, dependent feature docs, external resources.

### Code Examples Best Practice

- 2-3 focused snippets per major concept
- Always show the simplest use case first
- Type annotations serve as inline API reference
- Prefer referencing file paths over copy-pasting large code blocks (reduces staleness)
- Mark uncertainty: `<!-- NEEDS REVIEW: is this the correct error handling pattern? -->`

### Anti-Patterns to Avoid (the skill should never generate these)

- Revision history tables (redundant with git)
- Glossary sections (rarely consulted)
- Complete API/schema copy-pastes (verbose, stale fast — better auto-generated)
- Project timeline/milestones (outdated within weeks)
- Detailed UML diagrams (extremely high maintenance cost)
- Documentation as implementation manual — "this is how we implement it" without trade-offs adds zero value beyond the code itself

---

## 7. Architecture Decision Records (ADRs)

### Format

Use MADR (Markdown Architectural Decision Records) v4 format:

```markdown
---
status: accepted | deprecated | superseded
date: 2026-03-29
---

# 001 — Use PostgreSQL for database

## Context

What is the issue that we're seeing that is motivating this decision?

## Decision Drivers

- Performance requirements for X
- Team familiarity with Y

## Considered Options

1. PostgreSQL
2. MongoDB
3. SQLite

## Decision Outcome

Chosen option: PostgreSQL, because [reasons].

## Consequences

### Good
- [positive impact]

### Bad
- [negative impact]
```

### Conventions

- Naming: `001-kebab-case-title.md` — four-digit zero-padded sequential numbers
- Location: `docs/architecture/decisions/`
- Append-only: supersede rather than delete. Reference the superseding ADR.
- The skill should suggest creating an ADR when Claude makes a significant architectural choice during development

---

## 8. Definition of Done — Global Checklist

This lives in CLAUDE.md (the managed section). It defines what "done" means for any task, separate from the per-feature DoD in each feature doc:

```markdown
## Definition of Done

A task is NOT complete until:
1. Code works and tests pass
2. `docs/.registry.json` is checked for affected source files
3. If registry entry exists → corresponding doc is opened and verified/updated
4. If no registry entry exists and this is significant new functionality → doc is created using template, registry is updated
5. `last_updated` is set on any touched docs
6. If the change affects a feature's interface → dependent features in registry are flagged as `stale`
7. Per-feature DoD items (if present in the feature doc) are checked off
```

---

## 9. The `.claude/` Directory Structure

### What the Package Creates

```
.claude/
├── rules/
│   └── documentation.md         # Path-scoped rule, triggers on src/** access
├── skills/
│   └── update-docs/
│       └── SKILL.md             # Auto-documentation workflow skill
└── agents/
    ├── doc-writer.md            # Creates/updates individual feature docs
    └── doc-scanner.md           # Bootstrap scanner for undocumented code
```

Plus managed sections added to:
- `CLAUDE.md` — documentation maintenance rules and DoD
- `.claude/settings.json` — PostToolUse hook for doc validation warnings

### Path-Scoped Rule: `.claude/rules/documentation.md`

```markdown
---
paths: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "src/**/*.jsx"]
description: Enforces documentation updates when source files are modified
---

When you modify any source file:

1. Open `docs/.registry.json`
2. Search for the modified file path in any feature's `sources` array
3. If found:
   - Open the corresponding doc file
   - Verify the documentation is still accurate given your changes
   - Update any sections that are now outdated
   - Update `last_updated` in the registry entry
   - If your change affects the feature's public interface, check `depends_on` and flag dependent features as `stale`
4. If NOT found and this file contains significant logic (not just types, configs, or utilities):
   - Create a new feature doc using the update-docs skill
   - Add the mapping to the registry

Your task is NOT complete until documentation is verified. This is part of the Definition of Done.
```

**Key: use imperative, assertive language.** Not "consider updating docs" but "Your task is NOT complete until documentation is verified." Aggressive wording in rules significantly improves compliance.

### Documentation Skill: `.claude/skills/update-docs/SKILL.md`

```markdown
---
name: update-docs
description: >
  Creates and updates feature documentation. Use when implementing features,
  fixing bugs, making API changes, or when asked to document code. Handles
  registry updates, template-based doc creation, and dependency tracking.
---

# Documentation Workflow

## Creating a New Feature Doc

1. Determine the feature name (short, lowercase, what a developer would say out loud)
2. Create `docs/features/{name}.md` using the template below
3. Start with Summary, Definition of Done, and Non-goals (planning phase)
4. Fill in How It Works and Key Files as you build
5. Add API/Interface, Usage Examples, Gotchas as complexity warrants
6. Update `docs/.registry.json` with the new feature entry

## Updating an Existing Feature Doc

1. Read `docs/.registry.json` to find the doc path
2. Open the doc, compare against your code changes
3. Update affected sections — keep the doc concise, don't add bloat
4. Update `last_updated` in both the doc frontmatter and the registry
5. Check `depends_on` in registry — flag dependents as stale if interface changed

## Template

[Include the full feature doc template from Section 6]

## Rules

- Keep docs lean — dense and high-signal, not exhaustive
- Never document unverified behavior — if uncertain, use `<!-- NEEDS REVIEW: [question] -->`
- Reference source file paths rather than copy-pasting large code blocks
- Code examples must be copy-pasteable and include type annotations
- Every doc must have at minimum: Summary, How It Works, Key Files
- Add Gotchas/Edge Cases section whenever you handle non-obvious error cases
- Suggest creating an ADR when making significant architectural decisions
```

### Sub-Agents

**doc-writer agent** (`agents/doc-writer.md`):

```markdown
---
name: doc-writer
description: >
  Creates and updates feature documentation. Invoke with specific instructions
  about which doc to update and what changes to reflect.
tools: Read, Write, Edit, Glob, Grep
model: sonnet
---
```

Important: most sub-agent failures are invocation failures, not execution failures. The skill must invoke doc-writer with specific instructions: "Update docs/features/auth.md to reflect the new OAuth redirect flow added in src/lib/auth.ts. Include the new redirectUrl parameter and updated error codes." NOT just "Update the docs."

**doc-scanner agent** (`agents/doc-scanner.md`):

```markdown
---
name: doc-scanner
description: >
  Scans codebase to identify features, modules, and undocumented code.
  Maps project structure and generates documentation coverage report.
tools: Read, Glob, Grep, LS
model: sonnet
---
```

Used by the `scan` command. Operates in isolated context window. Maps the project structure, identifies feature boundaries by analyzing directory organization, exports, and route definitions. Finds public APIs via exported functions, classes, and interfaces. Checks for existing documentation. Generates coverage report ranking undocumented features by criticality.

### PostToolUse Hook

Added to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "command": "node node_modules/codument/dist/hooks/check-docs.js"
      }
    ]
  }
}
```

The hook script:
- Checks if a source file was modified
- Looks up the file in the registry
- If the registry maps it to a doc but the doc wasn't also modified in this session → prints a warning to terminal
- This is a human-facing safety net — Claude does not see this output

---

## 10. CLAUDE.md Managed Section

The `init` command adds this to CLAUDE.md using section markers:

```markdown
<!-- codument:start -->
## Documentation Maintenance

### Definition of Done
A task is NOT complete until:
1. Code works and tests pass
2. `docs/.registry.json` is checked for affected source files
3. Corresponding docs are updated or created
4. Registry is updated with new mappings
5. Dependent features flagged if interface changed
6. `last_updated` set on touched docs

### Documentation Registry
The file `docs/.registry.json` maps source files to their documentation.
Always check it before and after modifying source files.

### Documentation Structure
- Feature docs: `docs/features/{name}.md`
- Concept docs: `docs/concepts/{name}.md`
- ADRs: `docs/architecture/decisions/{NNN}-{title}.md`
- All filenames: lowercase kebab-case
<!-- codument:end -->
```

The `update` command only modifies content between these markers — everything outside is preserved.

---

## 11. Package Architecture

### Tech Stack

- **Language**: TypeScript
- **Build**: tsup (dual ESM/CJS output)
- **CLI framework**: Commander.js (~500M weekly downloads, minimal footprint)
- **CLI entry**: `#!/usr/bin/env node`
- **Template path resolution**: `fileURLToPath(import.meta.url)` for ESM `__dirname` derivation
- **File operations**: Native `fs.cpSync()` (Node 18+) — no `fs-extra` needed
- **Variable substitution**: `String.replaceAll('{{var}}', value)` for templates
- **Interactive prompts**: `prompts` library (lightweight, promise-based) for ambiguous detection
- **Terminal colors**: `picocolors` (minimal)
- **Runtime dependencies**: Zero for skills/agents content. Only `commander`, `prompts`, `picocolors` for CLI.
- **Type validation**: `@arethetypeswrong/cli` before publishing

### package.json Structure

```json
{
  "name": "codument",
  "bin": {
    "codument": "./dist/cli.js"
  },
  "files": ["dist", "templates", "skills", "agents", "rules", "hooks"],
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./skills": "./skills/index.js"
  }
}
```

The `files` array MUST explicitly include `templates/`, `skills/`, `agents/`, `rules/`, and `hooks/` or they won't ship to npm.

### Directory Structure of the Package Itself

```
codument/
├── src/
│   ├── cli.ts                    # Commander.js entry point
│   ├── commands/
│   │   ├── init.ts               # Project initialization
│   │   ├── scan.ts               # Bootstrap documentation scan
│   │   └── update.ts             # Update managed files
│   ├── lib/
│   │   ├── detect.ts             # Project type detection
│   │   ├── scaffold.ts           # File scaffolding utilities
│   │   ├── registry.ts           # Registry read/write/update
│   │   ├── codemod.ts            # mrm-style non-destructive updates
│   │   └── markers.ts            # Section marker utilities
│   └── hooks/
│       └── check-docs.ts         # PostToolUse hook script
├── templates/
│   ├── feature.md                # Feature doc template
│   ├── concept.md                # Concept doc template
│   ├── adr.md                    # ADR template
│   ├── overview.md               # Project overview template
│   ├── getting-started.md        # Getting started template
│   └── registry.json             # Empty registry template
├── skills/
│   └── update-docs/
│       └── SKILL.md              # Documentation workflow skill
├── agents/
│   ├── doc-writer.md             # Feature doc writer agent
│   └── doc-scanner.md            # Bootstrap scanner agent
├── rules/
│   └── documentation.md          # Path-scoped documentation rule
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

### Key Architectural Decision: Skills from node_modules

Skills load from `node_modules/codument/skills/` via Claude Code's `--add-dir` flag. This means `npm update codument` automatically delivers new skill versions without any manual sync. The `init` command configures this path reference rather than copying skill files into the project.

For files that MUST live in the project (rules, hooks config, CLAUDE.md additions), the `update` command handles non-destructive merging.

---

## 12. Implementation Phases

### Phase 1 — Core (MVP)

1. Package scaffolding (package.json, tsconfig, tsup, Commander.js CLI entry)
2. `init` command — project detection, scaffold `.claude/` structure, create `docs/` directory, add CLAUDE.md managed section, create empty registry
3. The documentation skill (`SKILL.md`) — the core product, this is what makes Claude document as it codes
4. The path-scoped rule — contextual enforcement when source files are accessed
5. Feature doc template and concept doc template
6. Registry read/write utilities

### Phase 2 — Bootstrap

7. `scan` command — orchestrates doc-scanner and doc-writer agents
8. doc-scanner agent — maps codebase, identifies features and undocumented code
9. doc-writer agent — generates docs for identified features
10. Coverage report and TODO.md generation

### Phase 3 — Update & Polish

11. `update` command — codemod-based updates for managed files
12. Version tracking (`.codument-meta.json`)
13. PostToolUse hook script
14. `--dry-run` support for update command
15. `--force` flag for init (overwrite existing files)

### Phase 4 — Quality & Release

16. Tests for CLI commands, registry operations, codemod logic
17. README, CONTRIBUTING, LICENSE
18. npm publish configuration
19. GitHub repo setup, CI/CD

---

## 13. Research-Backed Design Decisions

### Why Diátaxis for Directory Structure
Adopted by Django, Cloudflare, Gatsby, Kubernetes, Canonical/Ubuntu, Python. Four types: tutorials, how-to guides, reference, explanation. Every document should be one and only one type. This is the industry standard — not a personal preference.

### Why Kebab-Case for Filenames
Google Developer Documentation Style Guide mandates lowercase with hyphens. Search engines interpret hyphens as word separators but treat underscores as joiners. Every major documentation project (Next.js, Kubernetes, MkDocs, Hugo, GitLab) follows this convention.

### Why a Single Registry File
Fast lookup — Claude opens one file, has the complete project map. Split files would require globbing across directories. Merge conflict risk is low because the registry changes predictably (adding entries, updating timestamps).

### Why YAML Frontmatter in Docs
Universal across documentation frameworks (Docusaurus, Hugo, Jekyll, VitePress, Astro Starlight, MkDocs/Material, Mintlify, GitBook). Three fields are truly universal: `title`, `description`, `draft/published`. We add `sources`, `depends_on`, `status`, `last_reviewed` for our registry integration.

### Why Imperative Language in Rules
Research from HumanLayer and GitHub's AGENTS.md analysis shows LLMs follow assertive, specific instructions much more reliably than polite suggestions. "Your task is NOT complete until..." > "Consider updating..."

### Why Lean Templates
Anthropic's context engineering team documents "context rot" — model quality degrades as tokens increase. Feature docs should be dense and high-signal. No bloat sections. HumanLayer recommends under 60 lines for CLAUDE.md.

### Why DoD Per Feature
Atlassian, Scrum Guide, and industry practice confirm DoD should be defined before work starts. Embedding it in the feature doc means the planning artifact becomes the documentation artifact — no separate tracking needed.

### Why Ignore Existing Docs
Trying to merge with or reorganize existing documentation creates infinite edge cases. Cleaner to generate fresh docs in the new structure, using existing docs only as context for the bootstrap scan. Developer removes old docs when confident.

### Why the Gotchas Section
Consistently rated most valuable by developers joining projects. Claude is uniquely positioned to write this because it sees error handling, edge cases, and surprising behaviors as it codes.

### Why Not 100% Reliable
Claude Code hooks can't inject messages back into Claude's conversation — they only run shell scripts with output the developer (not Claude) sees. Until Anthropic adds a hook type that feeds back into the session, full automation isn't possible. The layered enforcement stack gets to ~90-95%.

---

## 14. Competitive Landscape

Analyzed 14+ existing tools. None center documentation:

| Tool | Focus | Stars | Gap |
|------|-------|-------|-----|
| davila7/claude-code-templates | General scaffolding | 22,700 | No doc automation |
| @claude-collective/cli | Composable skills | — | No doc focus |
| context-forge | Context management | — | No doc workflow |
| claude-forge | Skill factory | — | No doc templates |
| @schuettc/claude-code-setup | shadcn-style add | — | No doc system |
| serpro69/claude-starter-kit | Template sync | — | No doc registry |

**Documentation-first Claude Code automation is unoccupied territory.**

---

## 15. Future Considerations (Not for v1)

- Dashboard for documentation coverage visualization across repos
- Pre-built skill packs for specific frameworks (Next.js, Express, NestJS)
- Team management layer
- CI integration (GitHub Action that validates docs are updated in PRs, similar to Danger.js pattern)
- Vale integration for prose quality linting
- CODEOWNERS generation for docs directories
- Hosted registry that syncs across multiple projects
- `llms.txt` generation for external AI discovery
- AGENTS.md generation (the emerging cross-tool standard backed by Linux Foundation)

---

## 16. Key Terminology

- **Registry**: `docs/.registry.json` — the source-to-doc mapping index
- **Feature doc**: A markdown file in `docs/features/` documenting a specific feature
- **Concept doc**: A markdown file in `docs/concepts/` documenting cross-cutting concerns
- **ADR**: Architecture Decision Record in `docs/architecture/decisions/`
- **DoD**: Definition of Done — both the global checklist in CLAUDE.md and per-feature checklists in feature docs
- **Path-scoped rule**: A `.claude/rules/` file that loads into Claude's context only when matching files are accessed
- **Bootstrap scan**: One-time expensive run that documents an existing undocumented codebase
- **Section markers**: `<!-- codument:start -->` / `<!-- codument:end -->` for non-destructive CLAUDE.md updates
- **Context rot**: Degradation of LLM quality as token count increases — why docs must be lean

---

## 17. Open Questions (Decide During Implementation)

1. ~~**Package name**~~: Decided — `codument`.
2. **Skill loading mechanism**: Does `--add-dir` for `node_modules/` work reliably in practice? Need to verify with Claude Code. Fallback: copy skills to `.claude/skills/` during init.
3. **Registry format evolution**: Should the registry support custom fields for project-specific metadata?
4. **Scan granularity**: How does the scanner determine feature boundaries? Directory-based? Export-based? Route-based? Probably needs to be configurable.
5. **Multi-language support**: Currently JS/TS only. How hard would it be to extend to Python, Go, etc.?
6. **Hook feedback loop**: Monitor Anthropic's Claude Code releases for hook improvements that could close the automation gap.
