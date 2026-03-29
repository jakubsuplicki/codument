# codument

Automated documentation for JavaScript/TypeScript projects using [Claude Code](https://claude.ai/code).

Install codument as a dev dependency and it installs Claude Code skills, rules, and agents that make documentation an automatic byproduct of development. When Claude modifies source files, it checks the documentation registry, finds the corresponding docs, and updates them alongside the code.

## Install

```bash
npm install -D codument
```

## Setup

### 1. Initialize

```bash
npx codument init
```

This detects your project type (TS/JS, framework, source directory) and creates:
- `docs/` directory with the documentation structure (features, concepts, ADRs, guides)
- `docs/.registry.json` mapping source files to their documentation
- `.claude/rules/documentation.md` — path-scoped rule that fires when source files are touched
- `.claude/skills/update-docs/` — documentation workflow skill
- `.claude/agents/` — doc-writer and doc-scanner sub-agents
- Managed section in `CLAUDE.md` with the Definition of Done
- PostToolUse hook in `.claude/settings.json`

Works with any JS/TS project structure — `src/` directory or flat layout. Use `--force` to overwrite existing files.

### 2. Scan existing code (optional)

```bash
npx codument scan
```

Analyzes your codebase, groups source files into features, creates doc scaffolds, and populates the registry. For existing projects that need a documentation baseline.

### 3. Fill in the docs

Open Claude Code and run:

```
/update-docs
```

Claude orchestrates **doc-writer sub-agents** — one per feature — so each gets a focused context window with only its source files. Small projects are processed in parallel; larger ones are batched automatically.

### 4. Keep building

That's it. Use Claude Code normally. The path-scoped rule triggers whenever source files are modified, and Claude updates the docs as part of its workflow. For single-feature changes, docs are updated inline. For large refactors, Claude delegates to sub-agents per affected feature.

## How it works

Codument uses a layered enforcement stack — no single mechanism, but multiple reinforcing layers:

| Layer | Mechanism | When it fires |
|-------|-----------|---------------|
| CLAUDE.md | Definition of Done checklist | Every session |
| Path-scoped rule | `documentation.md` | When source files are accessed |
| Skill | `/update-docs` | On demand or auto-matched |
| Sub-agents | doc-writer, doc-scanner | Spawned per feature to avoid context limits |
| Hook | PostToolUse on Write/Edit | After file modifications (developer-facing) |

With all layers active, Claude updates docs alongside code ~90-95% of the time. The remaining 5-10%, you say "update the docs" and Claude already knows how.

## Documentation structure

Follows the [Diataxis](https://diataxis.fr/) framework:

```
docs/
  .registry.json              # Source-to-doc mapping
  overview.md                 # What this project is
  getting-started.md          # Setup and first run
  features/                   # One .md per feature
  concepts/                   # Cross-cutting concerns
  architecture/decisions/     # ADRs (Architecture Decision Records)
  guides/                     # How-to guides
```

## The registry

`docs/.registry.json` is the single source of truth mapping source files to documentation:

```json
{
  "features": {
    "auth": {
      "doc": "docs/features/auth.md",
      "type": "feature",
      "sources": ["src/auth/login.ts", "src/auth/oauth.ts"],
      "depends_on": ["database"],
      "last_updated": "2026-03-29",
      "status": "current"
    }
  }
}
```

When Claude modifies `src/auth/login.ts`, the rule fires, the registry maps it to `docs/features/auth.md`, and Claude verifies/updates the doc.

## Skills

Codument installs 6 Claude Code skills. Use them by typing the slash command in Claude Code, or Claude will invoke them automatically when relevant.

| Skill | Command | When to use |
|-------|---------|-------------|
| **update-docs** | `/update-docs` | Fill in scaffold docs after scan, or update docs after code changes |
| **code-reviewer** | `/code-reviewer` | Review code for bugs, security issues, and quality — outputs structured findings by severity |
| **senior-frontend** | `/senior-frontend` | Build React/Next.js components, optimize performance, implement accessible UI |
| **senior-backend** | `/senior-backend` | Design APIs, optimize database queries, implement auth, handle errors |
| **senior-architect** | `/senior-architect` | Design system architecture, evaluate trade-offs, plan migrations |
| **frontend-design** | `/frontend-design` | Create distinctive, production-grade UI with bold design choices — avoids generic AI aesthetics |

All skills include a documentation reminder — after making code changes, Claude checks `docs/.registry.json` and updates corresponding docs as part of the Definition of Done.

## Commands

| Command | Description |
|---------|-------------|
| `npx codument init` | Initialize codument in your project |
| `npx codument init --force` | Reinitialize, overwriting existing files |
| `npx codument scan` | Scan codebase and generate doc scaffolds |
| `npx codument update` | Sync managed files after a package upgrade |
| `npx codument update --dry-run` | Preview update changes without writing |

## Upgrading

```bash
npm update codument
npx codument update
```

The `update` command uses hash-based three-way merge to non-destructively update managed files (rules, skills, agents, CLAUDE.md section). If you've customized a file and upstream hasn't changed, your changes are preserved. If both sides changed, your version is backed up to `{file}.backup` before applying the upstream version.

## Scaling to large codebases

For large projects, codument uses a sub-agent architecture to stay within context limits:

- The `/update-docs` skill acts as an **orchestrator** — it reads the registry and spawns a **doc-writer agent per feature**
- Each agent gets an isolated context with only that feature's source files
- Small projects (< 6 features) are processed in parallel; larger ones are batched 3-5 at a time
- Single-feature updates (normal development) are handled inline without agents

This means a project with 40 features and 200 source files works the same as a project with 4 — each feature gets focused attention regardless of total codebase size.

## Requirements

- Node.js >= 18
- Claude Code (VS Code extension or CLI)

## License

MIT
