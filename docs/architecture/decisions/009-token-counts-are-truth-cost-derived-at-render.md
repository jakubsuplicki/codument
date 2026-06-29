---
status: accepted
date: 2026-06-29
---

# 009 — token counts are the source of truth, cost is derived at render time

## Context

Codument never calls an LLM, so it cannot meter tokens itself; it can only record the usage an agent reports. The tempting design is to compute a dollar cost when the usage arrives and store it. But rates change, vendors differ, and a persisted dollar figure goes stale the moment a rate moves. Worse, storing cost invites treating Codument as a metering or billing tool whose numbers are authoritative spend, which they can never be.

## Decision

Producers record only **raw token counts** (per bucket) in the event log. The dollar figure is **derived at render time** from a rate table, never persisted. Counts are the source of truth; cost is a pure, re-derivable view, and is always labelled an estimate.

Pricing is per-bucket: fresh input, output, cache read, and cache create are priced separately, because cache reads are roughly ten times cheaper than fresh input yet dominate agentic coding, so a single blended rate massively over-bills. Built-in rates cover Claude; any other model is priced from a user-supplied rate file merged over the defaults, so a new vendor or fine-tune prices without a Codument release. Model lookup is exact-match: an unknown or mistyped id surfaces as "unpriced" rather than as a plausible-but-wrong bill.

## Consequences

**Good:** re-pricing when rates change is free (just re-render); no log can carry a stale dollar amount because no log carries a dollar amount at all; a new model prices via a rate file with no release; mispricing is loud (unpriced), never silent.

**Bad / accepted:** cost is always an estimate, never authoritative spend, and an unknown model needs a rate-file entry before it prices.

**Rejected alternatives:** persisting a computed cost (stale on any rate change); a single blended rate (over-bills cache-heavy agentic usage); fuzzy model-id matching (silent mispricing); Codument calling a model or vendor API to meter usage (network, trust, and it would make Codument a metering tool, which it is not).
