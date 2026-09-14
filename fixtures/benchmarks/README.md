# Codument Benchmark Fixtures

This directory contains package-shipped fixtures for deterministic Codument proof benchmarks.

- `context-routing/` is reserved for the no-agent context benchmark.
- `quality-app/` is reserved for the agent-edited quality benchmark.
- `session-control/` contains matched contract-retrieval, approval-change and interrupted-work tasks.

The [recorded session comparison](session-control/comparison-2026-09-14.json) includes all twelve
independent attempts: six integrated passes, four plain passes, one plain staged-delivery failure
and one plain result unavailable after a protected plan edit. Both conditions handled approval
changes and interrupted work. These small, non-randomized fixture runs do not establish a general
quality gain; elapsed intervals include session interruptions and token counts were unavailable.

Fixture data must stay small, deterministic, and suitable for npm package distribution.
