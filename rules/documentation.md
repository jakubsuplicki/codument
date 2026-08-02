---
paths: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.mts", "src/**/*.cts", "src/**/*.js", "src/**/*.jsx", "src/**/*.mjs", "src/**/*.cjs", "**/*.py", "**/*.pyi", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.go", "**/*.rs", "**/*.cs"]
description: Enforces automatic documentation when source files are created or modified
---

## Automatic documentation — no manual step required

When you create or modify ANY source file, documentation MUST be handled as part of the same task. Do not ask the user whether to document — just do it. Do not defer to a skill or separate step.

### For every source file you touch:

1. Read `docs/.registry.json`
2. Find the file path in any feature's `primary_sources` / `related_sources`

**Whichever branch you land in, never list a generated, build, or test file as a source.** `primary_sources` and `related_sources` name the code a feature owns — not the code that exercises it, and not the output it emits. Test suites and fixture trees sit outside the documented surface by construction: the exclusion spec filters them from scope even when an entry names them, and the spec is additive-only precisely so that no project can quietly re-admit them. To point a doc at the test that enforces an invariant, link it in that invariant's prose — that is the sanctioned way, and it needs no registry mapping.

**"A test file" means one a language's own convention names** — a `*.test.*` / `*.spec.*` file, pytest's `test_*.py`, Go's `_test.go`, Cargo's crate-root `tests/` and `benches/` trees, the JVM's `*Test` files and `src/test` source sets. A directory name alone does not prove it: `tests`, `test` and `spec` are ordinary words, and a lab, exam or assessment product has real domain code under them. So a first-party module that merely lives beside tests — a shared harness or contract that other code must satisfy — is ordinary source, and belongs in an entry like any other. If your project keeps unconventionally-named test helpers you want out of scope, declare them in the project's own additive `exclude`; do not un-map real source to get there.

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
