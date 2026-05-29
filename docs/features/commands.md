---
title: Commands
status: active
type: feature
owner: ""
sources:
  - src/commands/adopt.ts
  - src/commands/benchmark.ts
  - src/commands/init.ts
  - src/commands/scan.ts
  - src/commands/update.ts
depends_on:
  - lib
last_reviewed: 2026-05-29
---

## Summary

The CLI commands implement codument's core workflow: `init` bootstraps fresh projects, `adopt` migrates existing Codument projects into the current registry/profile model, `scan` discovers existing source files and creates documentation scaffolds, `update` keeps managed profile files in sync after package upgrades, and `benchmark` hosts the package-native proof benchmark command family.

## How it works

### init

Sets up everything a project needs for the docs-backed delivery loop:

1. **Detects project** — calls `detectProject()` to identify language (TS/JS), framework, and source directory
2. **Resolves agent profiles** — uses explicit `--agents`, existing agent files, or defaults to the Codex/generic profile
3. **Creates docs structure** — `docs/`, `docs/features/`, `docs/concepts/`, `docs/architecture/decisions/`, `docs/guides/`, plus an empty `.registry.json`
4. **Copies templates** — `overview.md` and `getting-started.md` from the package's `templates/` directory
5. **Installs core workflow skills** — copies `grill-with-docs`, `plan-with-docs`, `tdd`, `work-step`, `review-work`, `commit-work`, and `update-docs` into each selected profile's skills directory
6. **Installs profile-specific support** — Claude gets rules, subagents, settings hooks, and `CLAUDE.md`; Codex/generic gets `AGENTS.md` and `.agents/skills`
7. **Updates instruction files** — inserts a managed delivery-workflow section between marker comments
8. **Writes `.codument-meta.json`** — records version, init date, selected agents, and detected project info

The `--force` flag overwrites all existing files; without it, existing files are preserved.

### adopt

Migrates an existing Codument project without treating it as a fresh install:

1. Detects the current project instead of trusting stale `.codument-meta.json` source globs
2. Resolves selected profiles from `--agents`, stored metadata, or existing agent files
3. Reads `docs/.registry.json` and normalizes legacy `mappings` into canonical `features`
4. Writes `docs/.registry.backup.json` before replacing a migrated registry
5. Refreshes `.codument-meta.json` with the current package version, detected project, and selected agents
6. Delegates to `update` so skills, instruction files, Claude hooks, and other managed files are refreshed through the normal merge strategy

Use `adopt --dry-run` before applying it to a project with customized skills or docs.

### scan

Discovers undocumented source files and creates minimal doc scaffolds:

1. Recursively collects all `.ts/.tsx/.js/.jsx` files (excluding `node_modules`, `dist`, `.git`, `.claude`, `.agents`, and `.d.ts` files)
2. Groups files by top-level directory under `src/` — each directory becomes a feature or concept
3. Directories named `lib`, `utils`, `helpers`, `types`, `shared`, or `common` are typed as concepts; everything else as features
4. For each group not already in the registry, creates a scaffold doc with frontmatter and empty sections, and adds a `needs-review` registry entry
5. Records scan stats in `.codument-meta.json`

Root-level files (directly under `src/`) that aren't `index` are grouped by filename but the `_root` group is skipped — these are expected to be entry points handled elsewhere (like `cli.ts`).

### update

Keeps codument's managed files current after a package upgrade using a hash-based merge strategy:

1. Reads `.codument-meta.json` for stored file hashes from the previous version
2. Resolves stored profiles, or an explicit `--agents` override
3. Re-detects the current project so generated rules do not use stale source globs
4. For each managed file (skill, rule, subagent): compares the upstream version, current on-disk version, and stored hash to decide whether to overwrite, skip, or merge
5. Updates managed instruction sections such as `AGENTS.md` and `CLAUDE.md` using marker-based replacement
6. Ensures profile hooks such as the Claude PostToolUse hook exist
7. When both upstream and local have changed, backs up the local file before overwriting

The `--dry-run` flag previews all actions without modifying anything.

### benchmark

Hosts Codument's package-native proof commands.

Current subcommands:

1. `benchmark context` — runs the deterministic no-agent context-routing benchmark against the package fixture. Use `--json` for stable machine-readable output.
2. `benchmark init <dir>` — copies the quality benchmark fixture into an empty target directory, installs selected agent profile assets, writes `BENCHMARK_TASK.md`, and prints the task prompt.
3. `benchmark score <dir>` — scores the final quality fixture after an agent attempts the task. The score report includes deterministic evidence checks for metadata, locked files, tests, required behavior, docs, registry coverage, source boundaries, and shortcut scans.

The context benchmark proves registry-guided routing on a fixed fixture. The quality benchmark scores final repository state; it does not call an AI model or claim deterministic agent behavior.

## Key files

- `src/commands/adopt.ts` — Existing-project adoption: legacy registry migration, metadata refresh, and managed profile update handoff
- `src/commands/benchmark.ts` — Context and quality proof benchmark subcommands
- `src/commands/init.ts` — Project bootstrapping: docs structure, selected agent profiles, workflow skills, instruction files, and profile hooks
- `src/commands/scan.ts` — Source file discovery, directory-based feature grouping, doc scaffold generation
- `src/commands/update.ts` — Profile-aware managed file sync with overwrite/skip/merge strategy

## Gotchas

- `scan` skips files at the root of `src/` (the `_root` group). If a project has significant logic in top-level files outside `cli.ts`, those won't get documented automatically.
- `update` backs up managed skill, rule, and agent files to `.backup` when both sides have changes. Instruction files use marker-based section replacement instead.
- `init` writes the Claude hook command as a hardcoded path (`node node_modules/codument/dist/hooks/check-docs.js`), so the hook assumes the package is installed locally, not globally.
