---
title: Piece report
status: current
type: feature
last_reviewed: 2026-10-04
---

# Piece report

## In plain terms

The local command prints the requested piece count. Invalid input returns a useful diagnostic.

## Design approach

Parsing and presentation stay synchronous and local. One feature owns both existing sources.

## Invariants & boundaries

- Input contains only ASCII decimal digits and represents a number from 1 through 20, inclusive. Leading zeroes are permitted. Signs, whitespace, fractions, exponent notation, trailing junk and missing input fail. *(test: `tests/report.test.ts`; the initial smoke test does not cover invalid input)*
- Successful output is exactly `Pieces: N` and a newline with exit status zero and no error output. Invalid input has no standard output, exit status one, and the diagnostic `Count must contain only decimal digits and be between 1 and 20.` plus a newline. *(test: `tests/report.test.ts`; initial CLI coverage is absent)*

## Decisions

- Keep the command dependency-free; use the already available TypeScript compiler for emission.

## Key files

- `src/count.ts` — count validation.
- `src/report.ts` — command presentation and entry.
