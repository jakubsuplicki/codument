---
title: Commands
status: active
type: feature
owner: ""
sources:
  - src/commands/init.ts
  - src/commands/scan.ts
  - src/commands/update.ts
depends_on:
  - lib
last_reviewed: 2026-03-29
---

## Summary

The three CLI commands implement codument's core workflow: `init` bootstraps a project with docs structure and Claude Code integration files, `scan` discovers existing source files and creates documentation scaffolds, and `update` keeps managed files in sync after package upgrades.

## How it works

### init

Sets up everything a project needs for automated documentation:

1. **Detects project** — calls `detectProject()` to identify language (TS/JS), framework, and source directory
2. **Creates docs structure** — `docs/`, `docs/features/`, `docs/concepts/`, `docs/architecture/decisions/`, `docs/guides/`, plus an empty `.registry.json`
3. **Copies templates** — `overview.md` and `getting-started.md` from the package's `templates/` directory
4. **Installs Claude Code integration** — copies a documentation rule, the `update-docs` skill, and two agents (`doc-writer`, `doc-scanner`) into `.claude/`
5. **Registers a PostToolUse hook** — adds a hook to `.claude/settings.json` that fires on Write/Edit to remind developers about doc updates
6. **Updates CLAUDE.md** — inserts a managed section (between marker comments) with the Definition of Done checklist and doc structure reference
7. **Writes `.codument-meta.json`** — records version, init date, and detected project info

The `--force` flag overwrites all existing files; without it, existing files are preserved.

### scan

Discovers undocumented source files and creates minimal doc scaffolds:

1. Recursively collects all `.ts/.tsx/.js/.jsx` files (excluding `node_modules`, `dist`, `.git`, `.claude`, and `.d.ts` files)
2. Groups files by top-level directory under `src/` — each directory becomes a feature or concept
3. Directories named `lib`, `utils`, `helpers`, `types`, `shared`, or `common` are typed as concepts; everything else as features
4. For each group not already in the registry, creates a scaffold doc with frontmatter and empty sections, and adds a `needs-review` registry entry
5. Records scan stats in `.codument-meta.json`

Root-level files (directly under `src/`) that aren't `index` are grouped by filename but the `_root` group is skipped — these are expected to be entry points handled elsewhere (like `cli.ts`).

### update

Keeps codument's managed files current after a package upgrade using a hash-based merge strategy:

1. Reads `.codument-meta.json` for stored file hashes from the previous version
2. For each managed file (rule, skill, agents): compares the upstream version, current on-disk version, and stored hash to decide whether to overwrite, skip, or merge
3. Updates the CLAUDE.md managed section (between `<!-- codument:start -->` / `<!-- codument:end -->` markers) using section-based replacement
4. Ensures the PostToolUse hook exists in `.claude/settings.json`
5. When both upstream and local have changed, backs up the local file before overwriting

The `--dry-run` flag previews all actions without modifying anything.

## Key files

- `src/commands/init.ts` — Project bootstrapping: docs structure, Claude Code integration files, settings hook, CLAUDE.md managed section
- `src/commands/scan.ts` — Source file discovery, directory-based feature grouping, doc scaffold generation
- `src/commands/update.ts` — Hash-based managed file sync with overwrite/skip/merge strategy

## Gotchas

- `scan` skips files at the root of `src/` (the `_root` group). If a project has significant logic in top-level files outside `cli.ts`, those won't get documented automatically.
- `update` backs up files to `.backup` when both sides have changes, but only for non-CLAUDE.md files. The CLAUDE.md managed section is always replaced in-place since it uses marker-based boundaries.
- `init` writes the hook command as a hardcoded path (`node node_modules/codument/dist/hooks/check-docs.js`), so it assumes the package is installed locally, not globally.
