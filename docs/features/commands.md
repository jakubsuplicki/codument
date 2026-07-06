---
title: Commands
status: current
type: feature
last_reviewed: 2026-06-29
---

# Commands

## In plain terms

These are the lifecycle commands that stand a project up on codument and keep it there. `init` bootstraps a fresh repo (docs tree, registry, agent profile assets, instruction files), `scan` discovers existing source and writes doc scaffolds so an agent can fill them in, `update` re-syncs the managed files after a package upgrade, `adopt` brings an already-onboarded project forward without re-bootstrapping it, and `benchmark` hosts the package-native proof commands. Reach for this feature when you want to understand how a project gets onboarded, re-synced, or proven, as opposed to the steady-state delivery loop that runs once it is set up.

## Design approach

Each command owns a phase of the project lifecycle, and the shape of every command follows from one stance: the user's repo is the source of truth, never the stored metadata. `init` and `scan` are the only commands that create from nothing; everything else reconciles an existing tree against the current package, and reconciliation always re-detects the live project rather than trusting a stale `.codument-meta.json` snapshot, because source globs and frameworks drift between runs.

The riskiest operation is overwriting a file a user has edited, so `update` is built around a three-way merge: it compares the upstream version, the on-disk version, and a stored hash from the last sync, and only overwrites when the local copy is unchanged from what codument last wrote. When both sides changed, it preserves the user's work by backing it up before applying upstream, never silently clobbering. Instruction files (`AGENTS.md`, `CLAUDE.md`) are the exception: they are co-owned with the user, so codument edits only its own marked-off section and leaves the surrounding prose alone. The whole sync is also failure-isolated: one unwritable or pointer-file entry is skipped with a reason and the run completes, so a single odd entry never strands a half-applied tree.

`adopt` is deliberately thin: it normalizes the registry in place (a stray legacy field is dropped on read, with no migration path), refreshes metadata against the live project, then delegates the managed-file work to `update` so onboarding and upgrade share one merge strategy instead of drifting apart. This is why there is no separate "re-init" command. `scan` derives feature boundaries from directory structure alone, a heuristic it cannot verify, so it marks every entry it creates as needs-review, places all files in primary ownership (it cannot tell primary from related), and writes an explicit ambiguity marker into each scaffold. It never narrates content: a scaffold is a typed skeleton an agent fills in via the update-docs flow, per the [[doc-audience-layers]] standard. `scan` shares its file-exclusion spec with the health analyzer so source discovery and coverage can never disagree about what counts.

`benchmark` is fenced off from the onboarding and delivery commands on purpose: measurement must never tangle with normal work, and it proves only what can be scored deterministically (context routing and final repository state), never an agent's path or a quality judgment. The detail lives in [[proof-benchmarks]].

## Invariants & boundaries

- `init` is non-destructive, and `--force` is scoped to codument-managed files only: it overwrites the managed scaffolds, but never the human-authored `docs/.registry.json`, nor the non-codument keys (permissions, env, other hooks) in a shared `.claude/settings.json` — those are always read-merged, upserting only codument's own hook. *(tests: `init.test.ts` "does not overwrite existing registry without --force", "does not reset a populated registry under --force", "preserves non-codument settings keys under --force")*
- `init` and `adopt` read-merge `.codument-meta.json`, preserving the fields codument accumulates (`fileHashes`, `lastScan`, `charter`, and the original init date), so a re-run never discards the change-detection state `update`'s three-way merge depends on. *(tests: `init.test.ts` "preserves accumulated meta (fileHashes, lastScan) on re-init"; `adopt.test.ts` "preserves accumulated meta across adopt")*
- A present-but-unparseable config or state file (registry, settings, project metadata) is refused, never overwritten: the lifecycle commands fail closed rather than silently rewrite it from empty. *(tests: `init.test.ts` "refuses a corrupt settings.json rather than overwriting it", "refuses a corrupt .codument-meta.json rather than dropping its fields")*
- `init` writes a Claude hook idempotently: re-running never duplicates the codument hook, and an outdated hook matcher — or an older command form — is upgraded in place. *(tests: `init.test.ts` "does not duplicate hook on re-init" and "updates an existing Claude hook matcher on init")*
- The installed hook can never break the editor loop: the written command guards its own target, so a project without a local codument install (npx-cache-only, global) gets a silent no-op on every edit — never a module-not-found error — and `init` says at write time that the hook stays dormant and how to wake it. *(tests: `hooks.test.ts` "the installed hook COMMAND is guarded"; `init.test.ts` "writes the GUARDED hook command and warns")*
- `init` edits only codument's own marked-off section of an instruction file; pre-existing user content is preserved. *(test: `init.test.ts` "appends to existing AGENTS.md")*
- `update` refuses to run without `.codument-meta.json`, exiting nonzero. *(test: `update.test.ts` "fails without .codument-meta.json")*
- `update` overwrites a managed file only when the local copy is unchanged since the last sync; a user-modified file with unchanged upstream is preserved. *(test: `update.test.ts` "preserves user-modified files when upstream unchanged")*
- `--dry-run` (on `update` and `adopt`) reports the actions it would take and modifies nothing, including the stored metadata version. *(tests: `update.test.ts` "--dry-run does not modify files"; `adopt.test.ts` "dry run does not rewrite legacy registry")*
- A single unwritable or non-directory (pointer/symlink) managed entry is skipped with a reason and the rest of the `update` run still applies; the blocking entry is left untouched. *(test: `update.test.ts` "skips a pointer-file skill instead of crashing the whole run (ENOTDIR)")*
- `adopt` normalizes the registry in place, dropping a stray legacy field rather than migrating it, and backs up the prior registry before replacing a changed one. *(test: `adopt.test.ts` "normalizes the registry (dropping stray legacy keys) and installs selected profiles")*
- `adopt` re-detects the live project rather than trusting stored metadata: the refreshed metadata reflects the current language and source globs, not the stale snapshot. *(test: `adopt.test.ts` "normalizes the registry (dropping stray legacy keys) and installs selected profiles" — asserts re-detected language/globs)*
- `scan` requires an existing registry and exits nonzero without one. *(test: `scan.test.ts` "exits with error when registry does not exist")*
- `scan` marks every entry it creates as needs-review and emits a layered scaffold with an ambiguity marker, never narrated content. *(tests: `scan.test.ts` "sets status to needs-review on new entries" and "creates scaffold docs with correct frontmatter")*
- `scan` never overwrites a doc that already exists on disk: an already-documented feature is skipped byte-for-byte, and even a name-collision with an unmapped human-authored file leaves its content intact. When an entry's doc is missing, scan recreates the scaffold but preserves the entry's human-authored fields (ownership split, deps, risk, docs, status), refreshing only the scanned sources. *(tests: `scan.test.ts` "skips already-documented features", "never overwrites an existing doc file on a name collision", "recreates a missing doc but preserves the entry's human-authored fields")*
- `scan` classifies known utility directory names as concepts and everything else as features, and shares the analyzer exclusion spec so generated/tool directories and `.d.ts` files are skipped. *(tests: `scan.test.ts` "classifies concept directories correctly", "ignores generated and tool directories", "excludes .d.ts files")*
- `benchmark` is a self-contained command family separate from the delivery loop; its proofs are deterministic, run with no network or model, and the quality benchmark refuses a non-empty target and fails scoring when locked metadata changes. *(tests: `benchmark.test.ts` "exposes the benchmark command family", "does not initialize into a non-empty target directory", "fails quality scoring when locked benchmark metadata changes")*

## Decisions

- The registry v2 model `adopt` reads and normalizes directly, with no migration layer: [001-registry-v2-model-no-migration](../architecture/decisions/001-registry-v2-model-no-migration.md).
- `benchmark` proves only what is deterministically scorable and is fenced off from the delivery commands: [008-benchmark-proof-deterministic-not-judge](../architecture/decisions/008-benchmark-proof-deterministic-not-judge.md).

## Key files

- `src/commands/init.ts` — the bootstrap command: creates the docs tree, registry, agent profile assets, and instruction sections from nothing.
- `src/commands/scan.ts` — the discovery command: derives feature/concept boundaries from source layout and writes needs-review scaffolds for an agent to fill in.
- `src/commands/update.ts` — the re-sync command: the three-way merge engine that keeps managed files current across upgrades without clobbering user edits.
- `src/commands/adopt.ts` — the forward-migration command: normalizes an existing registry in place and delegates managed-file work to update.
- `src/commands/benchmark.ts` — the proof command family's entry point: wires the deterministic context and quality benchmarks behind a fenced-off subcommand tree.
