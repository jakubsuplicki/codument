---
title: {{title}}
status: needs-review
type: feature
last_reviewed: {{date}}
---

# {{title}}

## In plain terms

{{summary}}

<!-- What this is and whether a reader cares for their task. A few sentences, no jargon. -->

## Design approach

{{description}}

<!-- Why it is shaped this way: the forces and the chosen-vs-rejected approach, at role level.
     No identifiers, counts, or call order — that is mechanism and it lives in the code.
     Test: would this sentence survive a refactor that renamed every symbol and reordered every line? -->

## Invariants & boundaries

<!-- What must always hold or is forbidden — the landmines a reader cannot see in the local code.
     Link each to the test that enforces it, or mark it "untested". This is what makes the doc
     load-bearing for certainty. -->

## Decisions

<!-- Pointers to ADRs (docs/architecture/decisions/). The durable why; reference, never restate. -->

## Key files

- `{{source}}` — {{file_description}}

<!-- One line of narrative ROLE per file (orchestrator / analyzer / seam).
     The registry holds the exact file list — do not restate it. -->
