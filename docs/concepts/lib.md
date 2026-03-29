---
title: Core Library
status: active
type: concept
owner: ""
sources:
  - src/lib/codemod.ts
  - src/lib/detect.ts
  - src/lib/markers.ts
  - src/lib/registry.ts
  - src/lib/scaffold.ts
  - src/lib/version.ts
depends_on: []
last_reviewed: 2026-03-29
---

## Summary

The core library provides shared utilities that the commands and hooks depend on: project detection, file scaffolding, registry I/O, content hashing for merge decisions, and marker-based CLAUDE.md section management. These are the building blocks that keep the commands themselves focused on workflow orchestration.

## How it works

### Registry (`registry.ts`)

Provides typed read/write for `docs/.registry.json`. The registry maps feature names to their doc paths, source files, dependencies, and status (`current`, `stale`, `needs-review`). `updateRegistryEntry` does an in-place read-modify-write using synchronous fs operations — it's designed for simple single-entry updates from hooks or scripts.

### Scaffold (`scaffold.ts`)

Handles all file-system setup: resolving the package root (relative to the compiled output), reading/copying templates, creating directories, and managing the CLAUDE.md managed section. The managed section is bounded by HTML comment markers and can be inserted or replaced without touching the rest of the file.

Key exports: `packageRoot()`, `ensureDir()`, `copyTemplate()`, `buildManagedSection()`, `upsertManagedSection()`, plus path helpers for `skillsDir()`, `agentsDir()`, `rulesDir()`.

### Codemod (`codemod.ts`)

Implements the hash-based merge strategy used by `codument update`. Stores SHA-256 hashes (truncated to 16 hex chars) of managed file contents in `.codument-meta.json`. The `decideMergeStrategy()` function compares upstream content, current on-disk content, and the stored hash to produce one of three outcomes: overwrite (upstream changed, user didn't), skip (no changes or only user changes), or merge (both changed — caller handles conflict).

### Detect (`detect.ts`)

Sniffs project characteristics by checking for `tsconfig.json`, `src/` directory, and framework-specific dependencies in `package.json`. Returns a `ProjectInfo` with language, source directory, glob patterns, and detected framework (Next.js, Remix, Express, NestJS, React, Vue, or Svelte).

### Markers (`markers.ts`)

Exports the two HTML comment strings (`<!-- codument:start -->`, `<!-- codument:end -->`) used to delimit the managed section in CLAUDE.md. Centralized here so the boundary format is consistent across scaffold and codemod logic.

### Version (`version.ts`)

Reads the package version from `package.json` at the package root. Used by the CLI for `--version` and by the update command to stamp `.codument-meta.json`.

## Key files

- `src/lib/registry.ts` — Registry I/O: read, write, and update individual entries in `docs/.registry.json`
- `src/lib/scaffold.ts` — File-system helpers: package root resolution, template copying, directory creation, CLAUDE.md managed section upsert
- `src/lib/codemod.ts` — Hash-based merge strategy for managed file updates; meta file read/write
- `src/lib/detect.ts` — Project detection: language, source directory, framework from `package.json` dependencies
- `src/lib/markers.ts` — HTML comment marker constants for CLAUDE.md managed section boundaries
- `src/lib/version.ts` — Reads package version from `package.json`

## API / Interface

```typescript
// registry.ts
interface RegistryEntry {
  doc: string;
  type: "feature" | "concept";
  sources: string[];
  depends_on: string[];
  last_updated: string;
  status: "current" | "stale" | "needs-review";
}
interface Registry { features: Record<string, RegistryEntry> }
function readRegistry(registryPath: string): Promise<Registry>
function writeRegistry(registryPath: string, registry: Registry): Promise<void>
function updateRegistryEntry(registryPath: string, key: string, entry: Partial<RegistryEntry>): Registry

// codemod.ts
interface MetaFile {
  version: string;
  initialized: string;
  project: Record<string, unknown>;
  lastScan?: Record<string, unknown>;
  fileHashes?: Record<string, string>;
}
type MergeResult = { action: "overwrite" | "skip" | "merge"; reason: string }
function decideMergeStrategy(upstream: string, current: string, storedHash?: string): MergeResult
function readMeta(root: string): Promise<MetaFile | null>
function writeMeta(root: string, meta: MetaFile): Promise<void>

// detect.ts
interface ProjectInfo {
  language: "typescript" | "javascript";
  srcDir: string;
  sourceGlobs: string[];
  framework: string | null;
}
function detectProject(root: string): Promise<ProjectInfo>

// scaffold.ts
function packageRoot(): string
function ensureDir(dir: string): void
function copyTemplate(name: string, dest: string): void
function buildManagedSection(): string
function upsertManagedSection(filePath: string, content: string): Promise<void>
```

## Gotchas

- `packageRoot()` in scaffold.ts navigates relative to the compiled output (`dist/`), not the source. If the build output structure changes, this will throw.
- `updateRegistryEntry` in registry.ts uses synchronous file operations (unlike the async `readRegistry`/`writeRegistry`), which is intentional for hook contexts but would block the event loop in long-running processes.
- `decideMergeStrategy` treats a missing stored hash conservatively — it assumes the user may have modified the file and returns `"merge"` rather than overwriting.
