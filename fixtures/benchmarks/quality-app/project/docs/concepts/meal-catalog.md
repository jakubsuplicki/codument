---
title: Meal Catalog
status: current
type: concept
sources:
  - src/domain/menu.js
depends_on: []
last_reviewed: 2026-05-29
---

## Summary

The meal catalog defines the fixed meal slots used by weekly plans.

## Rules

- Slot IDs are stable API values.
- Labels are display text only.
- Default meals are used when a plan has no override for a slot.
- Meal names are normalized by trimming whitespace, collapsing repeated spaces, and lowercasing.
