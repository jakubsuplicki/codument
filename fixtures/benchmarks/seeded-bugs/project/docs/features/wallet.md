---
title: Wallet
status: current
type: feature
primary_sources:
  - src/wallet/account.js
related_sources: []
docs: []
depends_on: []
risk: []
last_reviewed: 2026-06-29
---

# Wallet

## In plain terms

A tiny in-memory account with deposit and withdraw operations.

## Invariants & boundaries

- Every amount must be a positive number; a non-positive amount is rejected, never silently applied.
- A withdrawal may not overdraw the balance.
