---
name: tdd
description: Implement a planned Codument work step with a feedback-first, red-green-refactor loop where practical.
---

# Test-Driven Development

Use this when implementing a planned step or fixing a bug. The principle is feedback first: build the fastest reliable loop that proves the behavior.

## Workflow

1. Read the approved plan step and its mapped docs.
2. Identify the plan's promised outcome and the public interface or user-observable boundary that supplies evidence for it.
3. Choose the cheapest reliable feedback loop that exercises that boundary; use a small representative experiment before building expensive supporting infrastructure:
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

## Evidence boundary

Record what was exercised, what was observed, and what remains untested. A mock, fake, or local executor supports only its exercised contract; it does not prove an external provider's behavior, downstream checks, or an end-to-end effect. Use the real integration when the approved acceptance criteria require it and it is available within the authorized scope. If it is unavailable, keep that criterion open, record the blocker, and bring any change to acceptance back to the user. A green local suite cannot silently replace required integration evidence.

An expected failure during the red phase is feedback, not a final verification failure. Once the relevant checks pass, broaden them only for required checks or a concrete unresolved concern; do not build a new harness for a reversible edit that an existing check can verify.

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
