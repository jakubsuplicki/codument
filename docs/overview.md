---
title: Project Overview
---

## What this project is

Codument is an npm package that installs a docs-backed delivery workflow for AI coding agents. It gives projects a durable control plane made from `AGENTS.md`, workflow skills, feature docs, concept docs, ADRs, and a source-to-doc registry.

The core loop is: grill the request, plan in docs, wait for approval, implement one step, verify, update docs, review, commit, and repeat.

## Architecture

The CLI has five commands:

- `init` creates the docs structure and installs selected agent profiles.
- `scan` maps existing source files into feature/concept docs and marks new docs as `needs-review`.
- `adopt` migrates existing Codument projects, including legacy source-to-doc `mappings`, into the current registry/profile model.
- `update` refreshes managed files for the profiles recorded in `.codument-meta.json`.
- `benchmark` runs package-native proof benchmarks for context routing and deterministic quality scoring.

Agent profiles map the same neutral workflow into concrete agent files. The Codex/generic profile writes `AGENTS.md` and `.agents/skills`; the Claude profile also writes `.claude` rules, skills, subagents, settings hooks, and `CLAUDE.md`.

## Key technologies

- Node.js ESM CLI
- TypeScript
- Commander
- tsup
- Node's built-in test runner with `tsx`
