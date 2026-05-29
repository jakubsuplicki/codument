---
title: Telemetry
status: current
type: concept
sources:
  - src/lib/telemetry.ts
depends_on: []
last_reviewed: 2026-05-29
---

## Summary

Telemetry records low-volume product events for analytics. It is deliberately irrelevant to the meal-plan task and exists to make the naive context larger than the registry-guided context.

## How it works

Events are buffered with a name, timestamp, and JSON payload. The buffer is flushed by the caller in production code, but this fixture only models the local event shape.

## Key files

- `src/lib/telemetry.ts`
