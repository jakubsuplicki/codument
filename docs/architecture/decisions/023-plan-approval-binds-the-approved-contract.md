---
title: Approval binds the approved contract
status: accepted
type: adr
last_reviewed: 2026-09-10
---

# Approval binds the approved contract

An editable approval status cannot distinguish approved work from scope changed after approval.
Codument therefore records a stable plan identity and the approved contract in tracked repository
data. The approval check compares that contract with the selected plan in the same Git snapshot.

The contract includes intended work and its acceptance boundaries. Progress fields are excluded
only where the shared parser also excludes them from authorization and execution. A resume note
cannot expand scope while being omitted from revision checks. Durable knowledge outside an embedded
plan can evolve without reopening its approval.

New projects require recorded approval for governed work; existing projects retain an explicit
legacy mode until adoption. A previously bound document never silently downgrades to legacy status.
Recording is explicit, conflict-detecting and idempotent. Invalid records require repair.

This remains a local change-control tool. Attribution is self-reported and no identity service,
signature authority or stronger filesystem boundary is introduced. Retaining the approved contract
also supports final delivery after plan compaction; the final-delivery binding is implemented with
the delivery-state integration, rather than treating an archived approval as permission for new work.
