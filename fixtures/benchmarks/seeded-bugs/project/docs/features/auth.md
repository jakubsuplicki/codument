---
title: Auth
status: current
type: feature
primary_sources:
  - src/auth/authorize.js
  - src/auth/session.js
related_sources: []
docs: []
depends_on: []
risk:
  - security
last_reviewed: 2026-06-29
---

# Auth

## In plain terms

Issues short-lived sessions and decides whether a request is still allowed to act on one.

## Invariants & boundaries

- An expired session must never authorize: every `authorize` call re-checks expiry against the current time, it is not trusted from issue time alone.
- Sessions expire one hour after issue.
