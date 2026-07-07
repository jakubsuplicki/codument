---
title: Project overview
---

# Project overview

## What this project is

Codument is a git-native change-control layer for AI-assisted engineering, shipped as an npm package. One source of truth — the source-to-doc registry (`docs/.registry.json`) — feeds three parts:

1. **Deterministic checks.** Pure functions of repo state, no network and no model: documentation coverage and registry lint (`doctor`), a per-symbol staleness gate over the git diff (`review`), and live views of both (`watch`, `report`). The same repo state always yields the same verdict.
2. **Adversarial gates.** The human decision points the workflow refuses to skip: plans are approved before source edits, every step is reviewed before commit, and a change that owes no doc update is cleared only by a fingerprint-bound, auto-invalidating acknowledgment (`ack`) — never by silence.
3. **Delivery workflow.** The grill → plan → approve → work-step → review → commit loop, installed into the agent's own instruction files (`AGENTS.md`, `CLAUDE.md`, skills) by agent profiles. The CLI installs and audits the workflow; the agent executes it — codument never drives the coding agent (`run` is a signpost, not a runner).

## Command surface

Setup and installation: `init` (scaffold docs + install agent profiles), `scan` (map existing code into `needs-review` scaffolds), `adopt` (migrate a legacy codument project), `update` (refresh managed files after a package upgrade).

Checks and gates: `doctor` (coverage + lint, `--strict` for CI), `review` (diff vs. registry: stale docs, risk touches, unmapped and out-of-plan changes, dependents), `audit` (the same drift verdict over a committed range — history, not the working tree), `ack` (acknowledge a contract-neutral change), `watch` (live working-tree view), `report` (self-contained HTML review report), `steps` (mirror the active plan's checklist), `map` (feature-map routing + materialization).

Observability: `feed` (normalize agent-session token usage into the event log), `cost` (estimated token-cost ledger), `emit` (append a codument event).

Showcase and proof: `demo` (click-through walkthrough on a throwaway repo), `benchmark` (package-native proof benchmarks), `run` (signpost explaining that the plan runs in your agent).

`codument <command> --help` is the authoritative per-command reference; this list is the map, not the manual.

## Key technologies

- Node.js ESM CLI
- TypeScript
- Commander
- tsup
- Node's built-in test runner with `tsx`
