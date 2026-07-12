---
paths: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.mts", "src/**/*.cts", "src/**/*.js", "src/**/*.jsx", "src/**/*.mjs", "src/**/*.cjs", "**/*.py", "**/*.pyi", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.go"]
description: Enforces automatic documentation when source files are created or modified
---

## Automatic documentation — no manual step required

When you create or modify ANY source file, documentation MUST be handled as part of the same task. Do not ask the user whether to document — just do it. Do not defer to a skill or separate step.

### For every source file you touch:

1. Read `docs/.registry.json`
2. Find the file path in any feature's `primary_sources` / `related_sources`

**If the file IS in the registry:**
- Read the corresponding doc file.
- Make the two-way call on what changed:
  - **A documented contract or behavior changed** → update the matching section at **intent altitude** — the contract, the why, the shape callers depend on. Never mirror the code or restate symbol names (a doc that just renames functions as sentences, like "readRegistry reads the registry", is the rubbish this gate exists to prevent).
  - **A pure-internal refactor changed no documented contract** → do NOT edit prose to clear the gate. Record it: `codument ack <path>::<symbol> --reason "<the invariant that stayed constant>"`. Default to updating the doc; ack only when you can name in one clause what stayed constant.
- If your change affects the public interface (exported functions, types, or behavior), flag dependent features via `depends_on`.

**If the file is NOT in the registry** and contains significant logic (not just types, configs, or one-line re-exports):

- **First, route via the approved plan's Feature Map.** If the active plan carries a `feature-map` block, run `codument map materialize <file>` — it creates or extends the *owning* feature's registry entry + doc scaffold for you. Do not hand-pick a feature name when a Map exists.
- **An unmapped file with a Map present is a flag, not a lump.** If `codument map materialize` reports the file unmapped or ambiguous, STOP and add/fix a Map row (the file's owner is a decomposition decision) — never fold it into an existing umbrella feature.
- **Only when there is no Feature Map** (an out-of-loop, ad-hoc edit) fall back to naming the feature from the file's purpose (kebab-case), create `docs/features/{feature-name}.md` following the documentation standard's layers (In plain terms, Design approach, Invariants & boundaries, Decisions, Key files), and add an entry to `docs/.registry.json`:
  ```json
  "feature-name": {
    "doc": "docs/features/feature-name.md",
    "type": "feature",
    "primary_sources": ["src/path/to/file.ts"],
    "related_sources": [],
    "docs": [],
    "depends_on": [],
    "risk": [],
    "status": "current"
  }
  ```
- Populate `depends_on` based on imports from other registered features

**If the registry has entries with `status: "needs-review"`**, fill them in when you encounter them.

### Plan → Implement → Document is ONE action

When you plan a feature (create an ADR, design doc, or implementation plan) and the user asks you to implement it, the implementation is not done until:
1. Code is written and works
2. New source files are registered in `docs/.registry.json`
3. Feature docs are created or updated

Do not stop after writing code and ask whether to document. The documentation is part of writing the code.
