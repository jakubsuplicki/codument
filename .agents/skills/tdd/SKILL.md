---
name: tdd
description: Implement a planned Codument work step with a feedback-first, red-green-refactor loop where practical.
---

# Test-Driven Development

Use this when implementing a planned step or fixing a bug. The principle is feedback first: build the fastest reliable loop that proves the behavior.

## Workflow

1. Read the approved plan step and its mapped docs.
2. Identify the public interface or user-observable behavior to verify.
3. Choose the strongest practical feedback loop:
   - Unit test for pure logic
   - Integration test for module boundaries
   - CLI invocation for command behavior
   - Browser or UI harness for interface behavior
   - Repro script for a bug when a proper test seam does not exist yet
4. Prefer red-green-refactor:
   - Red: write one failing behavior test
   - Green: add the smallest code change that passes it
   - Refactor: improve structure only while tests are green
5. Repeat one behavior at a time.
6. Update docs and registry when behavior or source ownership changes.

## Test Quality

Good tests verify behavior through public interfaces. They should survive internal refactors.

Avoid tests that:
- Assert private implementation details
- Mock internal collaborators when a real boundary is cheap enough
- Encode imagined future behavior before the current slice teaches you what matters
- Pass while the user-visible behavior is broken

## Rules

- Do not write all tests first and then all implementation.
- Do not refactor while red.
- Do not add speculative behavior for later steps.
- If no correct test seam exists, document that finding and use the best available feedback loop.
