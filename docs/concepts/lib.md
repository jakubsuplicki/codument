---
title: Core Library
status: active
type: concept
owner: ""
sources:
  - src/index.ts
  - src/lib/agent-profiles.ts
  - src/lib/analyze.ts
  - src/lib/benchmark-context.ts
  - src/lib/claude-settings.ts
  - src/lib/codemod.ts
  - src/lib/detect.ts
  - src/lib/markers.ts
  - src/lib/registry.ts
  - src/lib/scaffold.ts
  - src/lib/version.ts
depends_on: []
last_reviewed: 2026-06-16
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

Provides typed read/write for `docs/.registry.json` over the **v2 model** — the single shape the analyzers read. A v2 entry splits the old flat `sources` array into `primary_sources` (files the feature owns) and `related_sources` (files it impacts but does not own), adds durable `docs` and optional `risk` hints, and **preserves the real `status` vocabulary** instead of flattening unknown values like `in-progress` to `current`. `allSources(entry)` unions owned + related (deduped, sorted) for consumers that only need "is this file mentioned anywhere"; `isMatureEntry(entry)` is true when an entry owns a source and its status is not a planned/draft placeholder.

The normal read path is **v2-only**: it does not read the legacy flat `sources` array or the old `mappings` shape. The one-shot `migrateRegistry` (surfaced as `codument migrate-registry`) is the only code that reads those legacy shapes, folding a flat `sources` array into `primary_sources` and each `mappings` source into its doc's feature, with an optional backup; `registryNeedsMigration` detects what still needs converting. A legacy-only entry therefore reads with empty `primary_sources`, which `doctor` surfaces until the registry is migrated. `updateRegistryEntry` does an in-place read-modify-write using synchronous fs operations — it's designed for simple single-entry updates from hooks or scripts.

### Analyzer (`analyze.ts`)

The shared, deterministic registry/docs analyzer behind `doctor` (and later `review`/`watch`). It reads only the v2 model and is a pure function of repo state — filesystem + registry + an optional injected git window — with no wall clock and no randomness, so the same state always yields the same output. It returns **two separate channels that are never blended into one number**:

- **Coverage** — scored ratios with an explicit denominator: ownership (in-scope source files with a documented owner), dependency (mature entries declaring `depends_on`), and risk (declared high-risk areas with a durable doc). The headline score is the equal-weight average of the ratios whose denominator is non-zero; a zero-denominator ratio is excluded, never counted as 0% or 100%. (Freshness/drift is no longer a coverage ratio — it is being re-sourced from the unified two-ref freshness gate; see `two-ref.ts` below.)
- **Lint** — typed warnings reported as counts with evidence, never folded into the score: missing/leaked sources, missing docs, high-fanout files, empty `depends_on` on mature entries, unmapped in-scope sources, and bloated docs. Bloat is measured by three independent signals (whole-doc lines, oversized section, completed-log `[x]` accumulation) with conservative CLI-overridable thresholds (`DEFAULT_BLOAT_THRESHOLDS`), calibrated against `fixtures/benchmarks/doc-bloat`.

`DEFAULT_EXCLUSION_SPEC` is the one canonical exclusion spec (generated/build/test dirs and globs) shared by every analyzer and applied to **both** the numerator and denominator — `detect.ts` and `scan.ts` now derive their ignore lists from it so source discovery never disagrees. All traversal is sorted for reproducible output.

### Change state (`change-state.ts`) and git (`git.ts`)

`computeChangeState` is the shared, deterministic diff analyzer behind both `review` (snapshot) and `watch` (live) — so the two can never disagree. It is a pure function of `(registry, changedFiles, optional planScope)`: no git, no clock, fully sorted. From a list of changed paths it derives changed sources grouped by owning feature, unmapped changes, stale docs (source changed but mapped doc didn't), docs changed without source, high-fanout changed files, risk touches (changes in a risk-tagged feature), dependents (the blast radius of changed features), and out-of-plan changes when a plan scope is supplied.

`git.ts` is the thin git-native data source: `isGitRepo` and `getWorkingTreeChanges` shell out to the already-required `git` CLI with `GIT_OPTIONAL_LOCKS=0` (so polling does not create lock churn that re-triggers the agent), returning sorted repo-relative working-tree changes (deletions excluded). It is kept separate from `computeChangeState` so the analyzer stays pure and testable without a repo.

### Two-ref plumbing (`two-ref.ts`)

The determinism layer for the freshness gate: a pure function of repo state at two refs, with no wall clock in any result. `readBlobAtRef` returns a file's byte-normalized content at a ref (or `null` when the path is absent there — a first-class added/deleted signal), failing loud (`GateError`) on an unresolvable ref. `resolveBase` resolves a single deterministic base to diff against: one merge-base for linear history, a lexicographically-smallest tie-break for a criss-cross (recorded via `ambiguous`), the empty tree when there is no common ancestor, and a best-effort shallow deepen-then-fail-closed when a ref is unreachable. `changedPathsBetween` classifies changes with deletions and renames first-class (unlike the working-tree view); `worktreeChangesSince` lists the branch's drift since it diverged from a base (merge-base..working-tree), the local advisory view `review --base` consumes. `byteNormalize` strips a BOM and folds CRLF/CR to LF; `algoStamp` stamps the parser + exact bundled `typescript` version + algo version, so a TS bump invalidates anchors rather than mass-staling the repo. Pinned `typescript` (exact, a runtime dependency) is the determinism unit.

### Fingerprint / language adapters (`fingerprint.ts`)

The `LanguageAdapter` seam that keeps the gate language-agnostic: an adapter turns file content into a deterministic fingerprint, and the gate compares fingerprints across two refs without looking inside one. Adding a language is registering an adapter — zero changes to the determinism core, the two-ref harness, or the gate. Phase 1 ships only `coarseAdapter` (a whole-file sha256 over byte-normalized content), the universal fallback and the non-TS gate: cosmetic churn (CRLF, a leading BOM, a re-saved newline) and the date-bump game normalize away before hashing, so they never move the fingerprint. `fileContentChange`/`contentChangedFiles` use it to refine "a path appeared in the diff" down to "the content really moved", dropping cosmetic-only churn. `changedAnchors` is the per-symbol diff the gate will use (see `ts-adapter.ts`).

### TypeScript anchors (`ts-adapter.ts`)

The precise TS adapter, registered ahead of the coarse one for `.ts`/`.tsx` (not `.d.ts`). It fingerprints each EXPORTED declaration individually, so editing one symbol in a shared file moves only that symbol's fingerprint — the cascade dissolution. Syntactic parse only (`ts.createSourceFile`, no type-checker, which is non-deterministic across machines). Each fingerprint is a **token-stream hash**: `ts.createScanner` with `skipTrivia` concatenating `getTokenText()` (literal token text, not `getTokenValue` or `getText()`+regex), so reformatting, comments, CRLF, and BOM do not move it, but `0x10` ≠ `16` and intra-string-literal edits are caught. Identity is a SCIP-descriptor-shaped FQN (`path::Name#` for types, `name().` for functions, `name.` for terms, `default.` for the default export) and is order-independent, so reordering declarations is a no-op. Body-inclusive by default. Each export's fingerprint is **transitively closed over the same-file non-exported declarations it references** (a lexical, no-type-resolution over-approximation), so a private-helper behavior change moves every caller that reaches it — closing the private-helper blindness — while a helper used by `f` but not `g` still wakes only `f`. A file also carries one **residual backstop anchor** (`path::<module>`, kind `module`) hashing every top-level statement no precise anchor covers — imports, side-effecting calls, and module state unreferenced by any export — so a changed owned file is never read as fresh just because the exported bodies did not textually move; it is emitted only when such residual content exists, and a closure-covered helper is excluded from it (no double-count). (Barrel/generated classification and gate wiring land in the following slices.)

### Symbol ownership (`ownership.ts`)

`resolveOwner(registry, anchorId)` answers "which feature does the gate wake when this anchor moves?", **derived-first**: a file in exactly one feature's `primary_sources` owns all its symbols (including the `<module>` backstop) with zero authoring — the common case. Ownership comes from `primary_sources` (owned), never `related_sources` (merely impacted). Per-symbol ownership is a **feature** concept: only `type: "feature"` entries are candidates. A `type: "concept"` entry (the `lib` umbrella narrating a whole directory file-by-file) is **not** a per-symbol owner — it co-documents at file grain, woken by a coarse whole-file change in the wiring, and never fragments a feature's symbols nor counts toward `unassigned`/`ambiguous`. So a file owned by one feature plus any number of concept umbrellas still resolves derived; only a file in two+ **features'** `primary_sources` is a genuine split, handled per-symbol by an optional `owned_symbols` registry field (`Record<path, descriptor[]>`, the descriptor being an anchor id's `::`-tail): the resolver routes a claimed symbol to its single owner and returns `unassigned` (no feature claims it) or `ambiguous` (two claim it) so the gate fails loud rather than silently waking every co-owner. A file owned only by a concept resolves `unowned` (the umbrella, not a per-symbol owner, covers it). `splitAnchorId` splits `path::descriptor` on the first `::` (paths never contain it). The resolver is pure; seeding `owned_symbols` from the import graph and wiring the result into the verdict are the next slices.

### Import graph (`import-graph.ts`)

First-party import harvesting from the same syntactic parse the anchors use, for two consumers: seeding shared-file symbol ownership (a shared-file symbol that references feature X's exclusively-owned files is attributed to X) and the facts/graph data contract (feature → file → file edges). `resolveSpecifier(fromPath, specifier)` maps a relative specifier to a repo-relative source path — `.js`/`.jsx`/`.mjs`/`.cjs` (ESM output extensions) fold back to `.ts`/`.tsx`/`.mts`/`.cts`, `..` normalizes, and a bare/`node:`/package specifier returns null (external). `harvestImports` returns every named/default/namespace/aliased binding (`local` name → `resolved` path; type-only imports included, side-effect imports excluded since they bind no name); `importedFiles` returns the deduped, sorted first-party edges (side-effect imports included). Pure — it never touches the filesystem, so the caller intersects `resolved` with the real file set.

### Events (`events.ts`)

`appendEvent`/`readRecentEvents` manage the append-only `.codument/events.jsonl` flow-event log that `watch` tails — review summaries, work-step notes, and the review-effectiveness notes from [[review-effectiveness-metric]]. Timestamps here are wall-clock because it is a live log, not the deterministic coverage artifact, so it never feeds any score. Writing is opt-in (e.g. `review --log`) to avoid surprise file writes.

### Report HTML (`report-html.ts`)

`renderReviewReportHtml(data)` renders a self-contained HTML review report — inline CSS, no network, no JavaScript (native `<details>` for the collapsible sections). It uses a dark "control room" theme (high-contrast instrument readout): the verdict leads, a conic coverage ring is the secondary gauge (colour tracks the level; N/A when null), findings triage by severity (risk > warning > info), and the per-file detail is tucked behind toggles. It is a pure function of the data passed in, so the same change renders the same page. It leads with a plain-language **verdict** ("needs a look" vs "looks clean") and the **coverage delta**, shows finding **cards** (counts + chips) for stale docs / unmapped / out-of-plan / risk / fanout / dependents, and tucks the per-file breakdown into a collapsible section — so the value reads at a glance instead of as a wall of filenames. When there are actionable findings it shows a **without/with codument contrast** strip (without it the diff merges with nothing surfaced; with it, here is what to look at) and demotes the coverage delta to a "health gauge, not the verdict" — so the findings, not the percentage, are the headline. Every finding card carries a clickable **"what this checks"** note (a one-sentence explanation of that check), so a report is self-explaining for anyone reading it cold. The optional `data.demo` field (a `DemoExplainer`) adds a collapsible **"How this demo works"** callout — the throwaway-repo framing, the planted scenario, and a per-file table of why each change is flagged; `codument demo` passes it so the showcase report needs no narration. It powers `codument report` and is the natural Studio teaser surface (a deterministic artifact a richer UI can re-skin).

### Badge (`badge.ts`)

`renderCoverageBadge(percent, label?)` renders a flat, shields-like coverage badge as a static SVG string — no network, no package dependency. It is pure and deterministic (same percent → byte-identical SVG), colors the value pill by threshold, and renders `N/A` (never a misleading `0%`) when no ratio is applicable. `doctor --write` persists the deterministic score artifact `.codument/coverage.json` plus `.codument/coverage.svg` via `writeCoverageArtifacts`. The artifact carries no timestamp so it diffs cleanly; the public README badge is only exposed after the Peelmeal git-history backtest confirms the score drops at known drift moments.

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

- `src/index.ts` — Public package exports for registry, analyzer, and agent-profile helpers
- `src/lib/agent-profiles.ts` — Agent profile definitions, profile detection, agent id parsing, and core delivery skill list
- `src/lib/analyze.ts` — Shared deterministic coverage + lint analyzer over the v2 registry; canonical exclusion spec and source discovery
- `src/lib/badge.ts` — No-network static SVG coverage badge renderer
- `src/lib/change-state.ts` — Shared deterministic diff analyzer (`computeChangeState`) behind review and watch
- `src/lib/git.ts` — Git-native working-tree change extraction (GIT_OPTIONAL_LOCKS=0)
- `src/lib/events.ts` — Append-only `.codument/events.jsonl` flow-event log (append/read) for `watch`
- `src/lib/report-html.ts` — Self-contained HTML review report renderer (verdict + coverage delta + finding cards)
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

// registry.ts (v2 model)
interface RegistryEntry {
  doc: string;
  type: "feature" | "concept";
  primary_sources: string[];   // files the feature owns
  related_sources: string[];   // files it impacts but does not own
  docs: string[];              // durable docs/ADRs/runbooks
  depends_on: string[];
  risk: string[];              // optional risk hints
  status: string;              // preserved verbatim (not flattened to "current")
}
interface Registry { features: Record<string, RegistryEntry> }
function readRegistry(registryPath: string): Promise<Registry>
function readRegistrySync(registryPath: string): Registry
function writeRegistry(registryPath: string, registry: Registry): Promise<void>
function updateRegistryEntry(registryPath: string, key: string, entry: Partial<RegistryEntry>): Registry
function normalizeRegistry(input: unknown, date?: string): Registry
function migrateRegistry(input: unknown, date?: string): { registry: Registry; changed: boolean }
function registryNeedsMigration(input: unknown): boolean
function hasLegacyMappings(input: unknown): boolean
function isLegacyEntry(value: unknown): boolean
function allSources(entry: RegistryEntry): string[]
function isMatureEntry(entry: RegistryEntry): boolean
const PLANNED_STATUSES: Set<string>

// analyze.ts
function analyze(input: AnalyzeInput): AnalysisResult  // { coverage, lint, inScopeSourceCount }
function discoverSourceFiles(root: string, srcDir: string, spec?: ExclusionSpec): string[]
function isExcluded(relPath: string, spec?: ExclusionSpec): boolean
function isSourceFile(relPath: string, spec?: ExclusionSpec): boolean
function rollupScore(ratios: CoverageRatio[]): CoverageReport
const DEFAULT_EXCLUSION_SPEC: ExclusionSpec

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
