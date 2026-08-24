---
title: Project Charter
seriousness: serious
last_reviewed: 2026-08-24
---

# Project Charter

## Seriousness

Serious. Codument is a published developer tool intended to be maintained, versioned, and trusted
in real delivery workflows.

## What we're building

Codument is a local-first change-control layer for AI-assisted engineering. It helps coding agents
deliver work against durable project knowledge while keeping local and CI verdicts reproducible and
actionable for the people maintaining the repository.

## Tech decisions

| Area | Choice | Why (plain language) | Trade-off accepted | ADR |
| --- | --- | --- | --- | --- |
| Architecture | Git-native Node.js ESM CLI in TypeScript | The product runs where the work and its history already live, without a hosted control plane | Repository state and Git capabilities bound what Codument can know | — |
| Datastore | Repository files, Git history, and JSON artifacts | Decisions remain reviewable, portable, and versioned with the project | No central database can coordinate separate worktrees or repositories | — |
| Auth | None; caller permissions apply | A local tool should not introduce an identity system beside the repository's own access controls | Attribution is only as strong as committed Git identity and recorded signer data | — |
| Hosting | npm distribution with GitHub Actions verification | Consumers install a normal development dependency and reuse their existing CI | Release correctness depends on the package and CI workflow staying aligned | — |
| Scale | Consumer repositories across the supported language matrix | The same model must remain useful from small projects through large dirty worktrees | Analysis stays deterministic and repository-scoped rather than relying on a remote service | — |
| Testing | `node:test` through `tsx`, plus lint, typecheck, build, fixtures, and CLI regression suites | The shipped command surface is exercised in repository-shaped scenarios before release | The Windows-heavy CLI suite is slower and more environment-sensitive than pure unit tests | — |

Every choice above was derived from the shipping code at charter adoption.

## To revisit later

None currently. A future change to these foundations is a migration and should be planned as such.
