# Changelog

All notable changes to Codument are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while it
remains pre-1.0.

## [Unreleased]

## [0.9.0] - 2026-07-12

### Added
- JVM support, per symbol: `.java`, `.kt`, and `.kts` files are governed
  through two bundled tree-sitter grammars under one anchor model, so a mixed
  Java/Kotlin repo gates coherently instead of half-covered. Types anchor as
  contract frames and methods, fields, and properties anchor individually
  under nested chains, mirroring C#. Visibility follows each language's own
  rule: Java anchors `public`/`protected` while a bare package-private default
  joins the closure pool, whereas Kotlin's default is public so every
  non-`private` declaration anchors and `internal` counts as public within
  the repo. Annotations are contract (framework wiring like `@GetMapping`
  refuses the ack path when added), a Kotlin data class's primary-constructor
  parameters are contract, enums anchor whole, and overloads fold per name.
  Canonical `src/test` source sets and `*Test`/`*Spec` files stay out of
  scope; `audit` names drifted Java members and Kotlin functions over history.
  A pathologically compact single-line Kotlin body classifies unevaluable
  (fail-loud) rather than mis-anchoring — realistic multi-line code is precise.
- The language-support matrix, mechanically unable to lie: a `LANGUAGE_MATRIX`
  manifest exported from the adapter registry is the one source of truth the
  README table renders from and `doctor` prints as a "gate languages" info
  line. A parity test asserts the README table is byte-equal to the manifest
  rendering and that the manifest and the registered precise adapters are the
  same set — a shipped-but-unlisted or listed-but-unshipped language is a red
  test, not a stale claim. The manifest is part of the public API so external
  surfaces (like a website) can render against the installed release.
- C# support, per member: `.cs` files are governed through a bundled
  tree-sitter grammar. `public`/`protected` anchor and `internal` counts as
  public within the repo (internal surface is what the repo's own docs
  describe). Types anchor as contract frames — attributes, modifiers,
  generics, bases, and record positional parameters — while members anchor
  individually under nested chains (`Outer#Inner#Method().`); partial-class
  fragments in one file fold into one identity; a property's accessor list
  is contract (`set` to `init` refuses the ack path) while accessor bodies
  and initializers are ackable body; operators and indexers fold into
  bounded per-type identities; and a top-level-statements Program.cs still
  gates at residual grain. `audit` names drifted C# members over history.
- Rust support, per symbol: `.rs` files are governed through a bundled
  tree-sitter grammar with the visibility literal as the law — any `pub`
  form anchors, `pub(crate)` included, because crate-internal surface is
  load-bearing for the repo's own docs. Inherent-impl members anchor as
  `Type#method().`, trait-impl members as `Type#Trait::method().` so a
  trait-impl swap is its own identity; attributes and derives are contract;
  a pub struct field is contract while a private field is ackable body;
  enum variants are all contract; a const/static value is ackable body.
  Macros are bounded honestly: a `macro_rules!` definition is one
  all-signature anchor (a macro IS contract), item-position invocations and
  inline `mod` blocks ride the module residual — expansion without rustc is
  fiction, so it is not pretended at.
- Go support, per symbol: `.go` files are governed through a bundled
  tree-sitter grammar with Go's own visibility law — exported means
  capitalized, no convention-hedging. Methods anchor under their receiver
  type (`Server#Handle().`) with pointer and value receivers sharing one
  identity (receiver kind is signature, not identity); grouped const/var
  blocks anchor per spec, so editing one constant moves only it — except an
  iota-style block, which anchors whole because inserting a member silently
  shifts every later constant's value (a contract move, never silence); a
  struct's exported fields and their tags are contract (wire shape) while
  unexported fields are ackable body; a const/var value is ackable body.
  `init` funcs and package side effects ride the module residual, and the
  cgo preamble comment before `import "C"` is treated as the compiled
  content it is instead of folding away as trivia. `_test.go` files stay
  out of scope; `// Code generated … DO NOT EDIT.` classifies coarse via
  the shared banner rule; `audit` names drifted Go symbols over history.
- Vue/Svelte/Astro support, per part: single-file components are governed by
  the same gate. Script blocks delegate to the TypeScript engine keyed on the
  component path (`Hero.vue::area().` is a normal per-symbol anchor with the
  full signature/body split and helper closure); `<script setup>`, Svelte
  instance scripts, and Astro frontmatter treat every top-level declaration
  as the component's public surface, since the template binds the top level.
  Template and style are named body-grain anchors with markup/CSS trivia
  folding — a real edit is one ackable finding, a comment or reformat is
  silence, never a whole-file wake. Block extraction is a small deterministic
  scanner (no third-party SFC grammar); a file it cannot segment is surfaced
  as unevaluable, never guessed. The "Registered but ungated" notice retires
  itself for these extensions now that judgment arrived — its design intent.
- Python support, per symbol: `.py`/`.pyi` files are governed by the same
  staleness gate as TypeScript, through a bundled tree-sitter grammar (no
  interpreter, no ambient toolchain — the parse is a pure function of the
  package version). A static `__all__` is honored as the public surface and
  its edit is a contract move; otherwise the underscore convention decides.
  Signature/body calibration matches how Python is actually written: a def's
  decorators, parameters (defaults included), and return annotation are
  contract while the suite — docstrings included — is ackable body; classes
  split per member; a module assignment's VALUE is ackable body while its
  target and annotation are contract, so a `settings.py` flip is one named
  ackable finding and a rename is not. Public symbols close transitively
  over referenced module-private helpers. pytest conventions and environment
  trees (`venv`, `__pycache__`) stay out of scope; a dynamic `__all__` or a
  parse error is gated whole-file or surfaced, never guessed at. `audit`
  names drifted Python symbols over committed history, and SARIF/acks/drift
  output are shape-identical across languages. Existing repos with Python
  files will see new findings on upgrade — that is the gate seeing files it
  previously ignored.
- Language-adapter substrate: the parsing foundation for per-symbol precision
  beyond TypeScript. Grammars are tree-sitter binaries compiled to WASM,
  shipped inside the package and loaded through the exact-pinned
  `web-tree-sitter` runtime, so a parse is a pure function of content bytes
  and package version — never of an ambient toolchain (ADR 015). Loading is
  lazy (a TS-only repo never initializes WASM) and fail-loud (a missing or
  corrupt grammar raises instead of silently coarsening). No language ships
  yet; each arrives with its adapter.
- Adapter conformance battery: the eight behaviors that define "precise"
  (format invariance, ackable body vs never-ackable signature, helper
  closure, module residual, unevaluable parse errors, order independence,
  byte determinism, SCIP descriptor discipline) are now one parameterized
  suite every adapter must pass. The bundled TypeScript adapter passes it;
  a seeded mutant proves the battery rejects a broken adapter.
- The determinism stamp (`algoStamp`) digests the bundled grammar set once
  any adapter ships one, making a grammar upgrade an algo-visible event
  exactly like a TypeScript version bump. While no grammar is bundled the
  stamp is unchanged, so existing installs cross no invalidation boundary.
- Config-file grain: `export default <expr>` / `export = <expr>` (the
  `defineNuxtConfig({...})` shape) now produces a precise `default.` anchor
  instead of silently classifying the whole file coarse. A comment or
  formatting edit fires nothing; an edit inside the config payload is one
  named, body-only, ackable finding; swapping the producing callee is a
  signature move that refuses the ack path (ADR 014). This kills the single
  largest mirror-edit pressure measured in dogfooding: config files waking
  their doc on every byte.
- Coarse-file ack signposts: a stale doc caused by a file-grain (coarse)
  source now prints BOTH honest routes inline — update the doc at intent
  altitude, or the pasteable file-grain `codument ack <path>` — and the
  `--strict` failure epilogue names the acknowledgment path beside
  materialize/doc-update. The HTML report carries the same hint.
- Registered-but-ungated surface: a changed file the registry names as a
  source but no adapter gates (`.vue`, `.css`, `.json`, …) is now named with
  its owning doc(s) in an info-only review section and an additive `--json`
  field, instead of changing in silence while the registry claims it
  load-bearing. Never a strict verdict input.

### Changed
- The source-extension spec now covers the module-flavored JS/TS family:
  `.mts`/`.cts` are gated per-symbol (they always were parseable, never
  reachable), `.mjs`/`.cjs` are gated at file grain like `.js`, and declaration
  artifacts of any flavor (`.d.ts`/`.d.mts`/`.d.cts`) stay outside governance.
  Upgrading repos with such files (a `next.config.mjs`, an `.mts` loader) may
  see new unmapped-source or stale-doc findings — that is the gate seeing files
  it previously ignored, not a regression. The whole advisory layer follows the
  same spec: the editor nudge hook, the scaffolded always-document rule, project
  detection, and the barrel heuristic all read the broadened family. A
  registered-but-excluded file (a hand-written `.d.ts` named in the registry)
  now rides the "Registered but ungated" surface instead of changing in silence.
- `ALGO_VERSION` 3 → 4 (anchor extraction changed). Per-symbol acknowledgments
  recorded under the previous algorithm auto-invalidate (their fingerprints no
  longer match any current transition — the binding working as designed);
  file-grain acknowledgments bind the coarse content hash and survive.
- `codument hooks install|status|uninstall`: git pre-commit enforcement of the
  strict gate. Install writes a marker-delimited managed block (an existing
  shell hook is appended to, never rewritten; a non-shell hook is refused with
  manual wiring instructions; `core.hooksPath` and linked worktrees are honored
  by asking git). A red gate blocks the commit and names both escapes
  (`--no-verify`, `CODUMENT_SKIP_GATE=1`) so skipping is a stated act; a missing
  binary warns loudly and lets the commit pass instead of bricking commits.
  `init --hooks` installs the same arm during setup. Born from a dogfood
  measurement: a compliant agent still landed 1 commit in 44 through a
  momentarily red advisory gate.
- `codument hooks install --ci`: scaffolds `.github/workflows/codument.yml`, a
  PR workflow running `review --strict --base` against the merge base — pair it
  with branch protection to make the gate a required check. Marker-first
  ownership: the file refreshes on reinstall while its managed marker is
  present; delete the marker and codument refuses to overwrite your edits.
  This repo's own CI now runs the same gate on every PR.

## [0.8.0] - 2026-07-10

### Added
- `doctor --verify-invariants`: an opt-in mode that RUNS the test each registered
  doc's `## Invariants & boundaries` marker cites (not just checks the pointer
  exists), through the project's own hardened runner, and classifies each invariant
  as green, broken (a cited test went red), unpinned (a cited test is missing or the
  marker names no test file), unrunnable, untested, or an honest non-testable
  boundary. Broken and unpinned are warnings that `--strict` fails on, with an
  honesty ratio over the enforced share. It is off by default and environment-
  touching, so bare `doctor` (and its `--json`) stays byte-identical and
  deterministic — the invariants block appears only when the mode runs. Pair with
  `--test-command` for a non-`node:test` runner.
- `codument audit <range>`: score documentation drift retroactively across any
  commit range, before adopting the workflow. It drives the same deterministic
  change-state analyzer the live gate uses, so audit and gate cannot disagree on
  what counts as drift. Informational by contract — findings never change the exit
  code; only a could-not-run (bad range, unreachable ref, broken git) exits
  nonzero, so "could not look" never reads as "no drift". `--json` is
  version-tagged and byte-identical for the same repo state. Runs on a repo that
  adopted nothing (`codument scan && codument audit <range>`).
- `codument context`: a pull-based context pack — given a `--feature`, `--file`,
  or `--plan`, project the minimal grounded working set from the registry and
  committed docs (the owning doc's orientation and invariant lines with their test
  pointers, the primary sources to read, and one-hop dependency pointers). It adds
  no source of truth and no ranking — every field is read verbatim. `--budget`
  trims tail-first (risk → related → deps → primary), never the selected head, and
  reports every dropped tier; `--json` is version-tagged.
- `ack --list --json`: the recorded acknowledgments as a versioned machine
  contract — each ack's anchor, transition, signer, reason, and a validity
  recomputed against the working tree (`covering` / `invalidated` / `indeterminate`,
  never trusted from disk) — so the ack-rate the trust model rests on is inspectable
  rather than asserted, and a dead ack is visible to remove.
- An "Acknowledgments in this change" card in `review` and the shareable HTML
  report: every covering ack (per-symbol and file-grain) on one line with its
  signer, badged **self** vs **independent** of the change's commit author, whenever
  the change carries any — so an all-self-adjudicated change is loud rather than a
  quiet green. Independence is judged from commit authorship (pure repo state),
  never the ambient git identity of whoever runs review.
- `review --require-independent-ack` (ADR 006 strict mode): only an ack whose signer
  is independent of the change author clears a finding; a self-signed ack is not
  honored and its stale-doc finding stays open under `--strict`, exactly as if
  unacked. It fails **closed** — independence is provable only against committed
  authorship, so a self-ack on an uncommitted change can never launder past the flag
  by naming an unrelated prior commit's author. Off by default the verdict is
  byte-identical.
- `report --json`: the report's two machine sections — the cumulative impact ledger
  and the acks card — as a versioned, timestamp-free contract, byte-identical across
  runs so CI can diff it, and discriminated fail-closed (`gate: "unavailable"`)
  whenever the gate cannot run — a non-git tree or a wrong root — like the other
  `--json` surfaces. The same fix closes a fail-open hole on the HTML report: a
  non-git tree no longer produces a green all-zeros report; both surfaces refuse and
  exit nonzero.
- `review --format sarif`: emit the gate verdict as SARIF 2.1.0 so a pull request gets
  inline "this doc went stale because this symbol moved" annotations through
  infrastructure teams already run (GitHub code-scanning upload or reviewdog) — no bot,
  no hosted service, no new network calls. Stale docs (enriched with the moved symbol
  and its fingerprint transition), unmapped sources, out-of-plan changes, ownership
  lints, and unparseable files each become a result, so a parse error is never a silent
  CI green; a gate that could not run marks the invocation unsuccessful AND exits
  nonzero, so a CI gating on exit code alone never reads it as clean. Deterministic and
  timestamp-free (byte-identical for identical repo state); a usage error to combine
  with `--json`, `--bundle`, or `--record`; stdout-only, so the pass/fail exit still
  comes from `--strict` and one step both annotates and fails the check. The README
  carries the two-step Actions recipe.
- `doctor` prose-altitude lint: three deterministic, no-NLP lexical heuristics
  (`symbol-mirror`, `line-anchor`, `path-enumeration`) that score every registered doc
  for prose restating mechanism the code owns — a symbol name used as a sentence
  subject, a `file.ts:42` line anchor, or a prose section re-enumerating a feature's
  file list. It is the machine reading of the documentation standard's no-mechanism
  invariant: info-only in doctor's Notes channel, excluded from the `--strict` verdict,
  and it never fails a build. Promotion of any one smell to a warning is a separate
  decision gated on that smell's own false-fire soak, like the change-control gate's
  info→blocking flip.

### Changed
- The change-control gate now splits each precise symbol anchor into a
  **signature** hash (the contract: modifiers, name, type parameters, parameter
  list, return type, overload signatures) and a **body** hash (the
  implementation). A signature move is a contract change and is ineligible for any
  acknowledgment — per-symbol or file-grain — so a changed public contract can no
  longer be laundered past the gate by an ack; the owning doc must be updated. An
  implementation-only body move keeps the cheap `codument ack` path. `review` marks
  a signature move `[signature changed]` and never prints an ack command for it,
  and the `watch` soak line splits its fire volume into `N contract · M body` so
  the calibration signal separates unavoidable contract work from the churn the ack
  path absorbs.
- Precise symbol anchors are now **canonicalized** before hashing: a name bound
  within a declaration (a parameter, a block `let`/`const`, a destructured or catch
  binding, a generic type parameter) is rewritten to a positional index, so a
  meaning-preserving local rename no longer moves the fingerprint and no longer
  needs an ack. The pass is sound — a free/imported/global reference, a type change,
  or a contract-relevant name (a property key, an object shorthand, a constructor
  parameter property) still fires — and block scoping is respected so an inner
  binding never leaks to an outer use.

### Migration
- The fingerprint algorithm version was bumped (v1 → v3) across this unreleased
  window (v2 = the signature/body split, v3 = local-identifier canonicalization),
  so upgrading crosses one fingerprint-universe shift, not two. Existing
  **per-symbol** acknowledgments recorded against a pre-v3 fingerprint
  auto-invalidate and must be re-recorded; file-grain (`ack <path>`) and
  module-residual acknowledgments are unaffected. No action is needed beyond
  re-acking any genuinely contract-neutral moves the next `review` re-flags.

### Fixed
- The adversarial review gate (`review --require-review`) and `doctor
  --verify-invariants` now spawn each test child in a **verdict-pure environment** —
  stripping ambient `NODE_OPTIONS` and coverage hooks alongside `NODE_TEST_CONTEXT`.
  An IDE debugger's auto-attach injection (VS Code's *Auto Attach* sets
  `NODE_OPTIONS=--require <js-debug bootloader>`) otherwise leaked into the spawned
  `node --test`, crashing it before it emitted any TAP so a genuinely red test read as
  `unrunnable` — the editor silently deciding the gate's verdict. The verdict is now a
  pure function of the code, not the terminal it runs from. This also surfaced through
  the `prepublishOnly` gate, where the same injection made `npm publish` fail from a
  VS Code integrated terminal while passing headless.

## [0.7.0] - 2026-07-01

### Added
- Symbol-grained change control: the stale-doc gate now tracks the individual
  exported symbol a doc describes, not the whole file, so a one-symbol edit wakes
  only its owning doc and a shared file no longer cascades onto every doc that
  references it. The verdict is deterministic and reproducible — per-symbol
  token-stream fingerprints compared across two git refs with one pinned parser,
  derived-first ownership, a `<module>` residual backstop, and parse-error files
  gated file-grain rather than read as fresh.
- `codument ack`: record a fingerprint-bound, auto-invalidating acknowledgment
  that a change owes no doc update — `<path>::<symbol>` for a contract-neutral
  symbol move, or a bare `<path>` (file-grain) for the additive / concept / coarse
  residue a symbol ack cannot reach. A file-grain ack never masks a moved symbol,
  and over-acking stays visible in the resolution summary and the soak telemetry.
- Two adversarial gates, both human-adjudicated. The **plan adversary**: after
  grilling, an independent pass contests the written plan against its committed
  grounding (invariants, ADRs, dependency edges, risk tags, surfaced by
  `map check --plan --json`) and returns grounded objections for you to decide —
  it never blocks, and "No material objections" is the expected clean result. The
  opt-in **review gate** (`review --require-review`, with `--bundle`/`--record`):
  an independent review whose findings block a commit only when a named test,
  re-run on the spot, actually goes red — it verifies, it does not trust the
  reviewer's prose.
- `review --strict`: a step-sync gate that exits nonzero while a step left a new
  source unmapped or a mapped doc stale, so a CI step (or autopilot) can hold the
  registry and docs in sync per change.
- Catch-rate seeded-bug benchmark: `benchmark init --seeded` ships a diff with
  planted bugs over a committed baseline, and `benchmark score --mode loop|no-loop`
  scores how many the review loop catches before commit (ADR 008).
- `doctor`: an opt-in `--strict` flag, plus thin-doc and link-rot integrity checks.
- A domain-skill layer (senior backend / frontend / architect, frontend-design,
  motion-craft, code-reviewer) consulted advisorily from the intent router.
- Implementation-discipline guidance (write the least code that solves the
  problem; fix bugs at the root, not the symptom) in the agent contract.
- `plan-with-docs` prints the plan's Outcome at the approval gate.
- A Biome linter with a tuned, style-matched config, and a GitHub Actions matrix
  (lint, typecheck, build, test on Node 18 / 20 / 22).

### Changed
- The documentation standard: every doc follows fixed audience layers (In plain
  terms → Design approach → Invariants & boundaries → Decisions → Key files), a
  plan's delivery scaffolding is transient and compacts out when the work ships,
  and the features/concepts were rewritten to it (the 525-line flagship split into
  altitude docs plus ADRs).
- Freshness resolution is verdict-derived, never symbol-name or co-movement
  matching; co-movement is kept as info-only soak telemetry, never a gate input
  (ADR 010).
- `doctor` exempts depended-upon foundations from dependency coverage and the
  empty-depends-on lint, so a genuine leaf or a shared base no longer false-fires.
- README and CONTRIBUTING reframed around running from source, with em dashes
  removed from user-facing copy.

### Fixed
- `review`: closed a `<module>`-residual false-negative and hardened the gate.
- `analyze`: exclude fixture trees from source analysis.
- Test and CI determinism: force `NO_COLOR`, use `os.tmpdir()` over a hardcoded
  path, strip ANSI in render assertions, and make the benchmark NODE_OPTIONS-strip
  test robust across the Node matrix.

## [0.6.0] - 2026-06-22

### Added
- Feature decomposition: a machine-readable Feature Map block in the plan plus
  a deterministic `codument map` consumer (`route`, `check`, `materialize`), so
  a greenfield build no longer collapses into a single feature.
- `plan-with-docs` requires a Feature Map and approves the cut at the gate;
  `work-step` requires `codument map materialize` for each landed file.
- Multi-session cost capture: the feed ingests every matching transcript (with
  `feed --backfill`), a verdict-led `watch` frame, and a `codument cost`
  per-feature, per-model, per-step ledger.
- `review` records resolved findings to an impact ledger.
- A project charter gate that runs before the first grill.
- Cross-platform motion-craft skill and designer handoffs.
- `init` defaults to the Claude profile.

### Changed
- Under and over-decomposition signals are info-only with a registry
  `cohesive` mute, so the size nudge never false-fires on a clean repo.
- Autopilot shows the plan checklist inline at every step, not only at the
  approval gate.
- `watch` reports file-grain blast radius and per-file drift when a single
  feature is touched.

### Fixed
- `hooks`: read the check-docs payload from stdin and resolve the repo root
  from the file path.
- `watch`: the header shows HH:MM, repaints are skipped when the rendered
  frame is unchanged, and the working-tree scan is shared across review and the
  activity tape.

## [0.5.0] - 2026-06-18

### Added
- Change-control pivot: a v2 registry ownership model (primary, related, docs,
  depends_on, risk) with one-shot migration from the legacy registry.
- A shared deterministic analyzer for coverage and change state.
- `doctor` (documentation coverage and lint), `review` (diff safety), and
  `watch` (live view) with an events flow log.
- A shareable HTML review report.
- Click-through and live demo on a packaged fixture.
- Token-cost tracking, session feed, plan-step mirroring, and a redesigned
  live `watch`.
- Opt-in approved-plan autopilot and an assumption gate for source edits.
- Commit guidance that forbids AI co-author attribution.

### Fixed
- Documentation-coverage scope excludes gitignored files.
- The coverage percentage stays visible in the report gauge.

## [0.4.0] - 2026-05-29

### Added
- Agent-neutral delivery workflow and proof benchmarks.

## [0.3.0] - 2026-03-31

The 0.1.0 (2026-03-29) through 0.3.0 releases were the project's early
documentation-coverage CLI, before the 0.5.0 change-control pivot. Detailed
release notes were not kept at the time.
