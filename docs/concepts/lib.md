---
title: Core Library
status: active
type: concept
owner: ""
sources:
  - src/index.ts
  - src/lib/agent-profiles.ts
  - src/lib/benchmark-context.ts
  - src/lib/claude-settings.ts
  - src/lib/codemod.ts
  - src/lib/detect.ts
  - src/lib/markers.ts
  - src/lib/registry.ts
  - src/lib/scaffold.ts
  - src/lib/version.ts
depends_on: []
last_reviewed: 2026-05-29
---

## Summary

The core library provides shared utilities that the commands and hooks depend on: agent profile resolution, benchmark context scoring, Claude settings migration, project detection, file scaffolding, registry I/O, content hashing for merge decisions, and marker-based instruction-file management. These are the building blocks that keep the commands themselves focused on workflow orchestration.

## How it works

### Agent profiles (`agent-profiles.ts`)

Defines the concrete output profiles that map Codument's neutral delivery workflow into agent-specific files. The Codex/generic profile writes `AGENTS.md` plus `.agents/skills`; the Claude profile writes `AGENTS.md`, `CLAUDE.md`, `.claude/skills`, `.claude/agents`, `.claude/rules`, and `.claude/settings.json`.

The module also owns `DELIVERY_SKILLS`, the ordered list of core workflow skills installed by `init` and refreshed by `update`.

### Benchmark context (`benchmark-context.ts`)

Implements the deterministic no-agent context benchmark used by `codument benchmark context`. It reads a package fixture task, builds a naive context from all candidate source/docs files, builds a Codument context from `docs/.registry.json` feature dependencies, estimates tokens with a stable local heuristic, and reports relevance coverage.

### Claude settings (`claude-settings.ts`)

Normalizes `.claude/settings.json` so Codument has one docs hook for Claude Code. It preserves unrelated hooks, upgrades the matcher to `Write|Edit|MultiEdit`, and handles both older nested hook entries and newer simple command entries without duplicating the Codument hook.

### Registry (`registry.ts`)

Provides typed read/write for `docs/.registry.json`. The registry maps feature names to their doc paths, source files, dependencies, and status (`current`, `stale`, `needs-review`). Reads normalize legacy registries that contain source-to-doc `mappings`, which lets older Codument projects be adopted without breaking hooks or scans. `updateRegistryEntry` does an in-place read-modify-write using synchronous fs operations — it's designed for simple single-entry updates from hooks or scripts.

### Scaffold (`scaffold.ts`)

Handles file-system setup: resolving the package root (relative to the compiled output), reading/copying templates, creating directories, and managing marker-bounded instruction sections. The managed section can be inserted or replaced without touching the rest of the file, and it carries the delivery-loop step gates that require review and commit between implementation steps. Review findings are a user decision point: the agent must ask whether to fix all, fix selected findings, defer selected findings, or pause. After commit, the managed section offers an agent-neutral compact-context checkpoint that uses native compaction when available or emits a concise restart note before pausing.

The managed section also carries the intent router for new chats. It tells agents to enter `grill-with-docs` for rough or ambiguous ideas, move to `plan-with-docs` once scope is settled, start `work-step` only from an approved plan, then require `review-work` and offer `commit-work` as a user-approved gate before the next implementation step.

Key exports: `packageRoot()`, `ensureDir()`, `copyTemplate()`, `buildManagedSection()`, `upsertManagedSection()`, plus path helpers for `skillsDir()`, `agentsDir()`, `rulesDir()`.

### Codemod (`codemod.ts`)

Implements the hash-based merge strategy used by `codument update`. Stores SHA-256 hashes (truncated to 16 hex chars) of managed file contents in `.codument-meta.json`. The `decideMergeStrategy()` function compares upstream content, current on-disk content, and the stored hash to produce one of three outcomes: overwrite (upstream changed, user didn't), skip (no changes or only user changes), or merge (both changed — caller handles conflict).

### Detect (`detect.ts`)

Sniffs project characteristics by checking for root or nearby TypeScript files, `src/` directory, and framework-specific dependencies in `package.json`. Returns a `ProjectInfo` with language, source directory, glob patterns, and detected framework (Next.js, Remix, Express, NestJS, React, Vue, or Svelte). TypeScript detection skips generated and dependency directories so monorepos with nested apps can still get TS/TSX rules without being fooled by `node_modules`.

### Markers (`markers.ts`)

Exports the two HTML comment strings (`<!-- codument:start -->`, `<!-- codument:end -->`) used to delimit the managed section in CLAUDE.md. Centralized here so the boundary format is consistent across scaffold and codemod logic.

### Version (`version.ts`)

Reads the package version from `package.json` at the package root. Used by the CLI for `--version` and by the update command to stamp `.codument-meta.json`.

## Key files

- `src/index.ts` — Public package exports for registry and agent-profile helpers
- `src/lib/agent-profiles.ts` — Agent profile definitions, profile detection, agent id parsing, and core delivery skill list
- `src/lib/benchmark-context.ts` — Deterministic context benchmark scoring and report formatting
- `src/lib/claude-settings.ts` — Claude hook settings normalization for Codument's docs reminder
- `src/lib/registry.ts` — Registry I/O: read, write, and update individual entries in `docs/.registry.json`
- `src/lib/scaffold.ts` — File-system helpers: package root resolution, template copying, directory creation, managed instruction section upsert
- `src/lib/codemod.ts` — Hash-based merge strategy for managed file updates; meta file read/write
- `src/lib/detect.ts` — Project detection: language, source directory, framework from `package.json` dependencies
- `src/lib/markers.ts` — HTML comment marker constants for CLAUDE.md managed section boundaries
- `src/lib/version.ts` — Reads package version from `package.json`

## API / Interface

```typescript
// agent-profiles.ts
type AgentProfileId = "claude" | "codex"
interface AgentProfile {
  id: AgentProfileId
  displayName: string
  instructionFiles: string[]
  skillsDir: string
  agentsDir?: string
  rulesDir?: string
  settingsFile?: string
  capabilities: AgentCapabilities
}
const DELIVERY_SKILLS: readonly string[]
function parseAgentIds(input?: string | string[]): AgentProfileId[]
function detectAgentIds(root: string): AgentProfileId[]
function resolveAgentIds(root: string, input?: string | string[]): AgentProfileId[]
function getAgentProfiles(ids: AgentProfileId[]): AgentProfile[]

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
function readRegistrySync(registryPath: string): Registry
function writeRegistry(registryPath: string, registry: Registry): Promise<void>
function updateRegistryEntry(registryPath: string, key: string, entry: Partial<RegistryEntry>): Registry
function normalizeRegistry(input: unknown, date?: string): Registry
function hasLegacyMappings(input: unknown): boolean

// codemod.ts
interface MetaFile {
  version: string;
  initialized: string;
  agents?: string[];
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
- Agent profiles are neutral in interface but concrete in output. Do not assume every agent supports hooks, rules, or subagents.
- `updateRegistryEntry` in registry.ts uses synchronous file operations (unlike the async `readRegistry`/`writeRegistry`), which is intentional for hook contexts but would block the event loop in long-running processes.
- Legacy registry mappings can map one source file to multiple docs. Normalization inverts that into one canonical registry entry per doc and keeps all mapped sources.
- `decideMergeStrategy` treats a missing stored hash conservatively — it assumes the user may have modified the file and returns `"merge"` rather than overwriting.
