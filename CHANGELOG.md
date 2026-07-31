# Changelog

All notable changes to Codument are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while it
remains pre-1.0.

## [Unreleased]

Nothing in the generated contract capped what the agent said in an ordinary
turn. Its brevity instructions were about *docs*, or about the summary autopilot
owes on pause and completion — none about the reply to a question. And
`grill-with-docs` pushed the other way, telling the agent to "include your
recommended answer and why" and to "stress-test answers with concrete
scenarios, failure modes, and edge cases". Read literally, that is an
instruction to print the analysis rather than perform it. The reply that
prompted this answered one question with a comparison table, a numbered
rationale, a "before you answer" section, and a two-part closing question. The
agent was not drifting; it was obeying.

### Added
- A `### Response altitude` rule in the generated contract, between
  implementation discipline and intent routing — so the three read *do the work
  well*, *write the least code*, *say the least words*. It has two halves
  because short and to-the-point are different failures: supporting detail is
  offered rather than delivered, one answer and one question per turn; and no
  runway — no pleasantries, no restating the question, no narrating the file
  about to be read. The enforceable part is a deletion test: if a sentence could
  be cut without changing what the reader now knows or does, cut it.
- Two guards on that rule, because the obvious way to obey it is worse than
  ignoring it. Grounding is narrated less but never performed less — brevity
  bought by reading less is the one failure it must not cause. And nothing is
  exempt: a mandated format (the approval summary, a review finding, a charter
  recommendation) keeps every required part and compresses inside it, a line
  each rather than a paragraph each. Structure is what makes those formats
  usable; length never was.

### Fixed
- `grill-with-docs` no longer asks for the output it was blamed for. The
  stress-test survives and only its recital stops: it runs before the agent
  writes, and surfaces a finding only when that finding would change the user's
  decision. The recommendation survives too — the assumption gate depends on it
  — capped to the one reason that decides the call. The rules line now names the
  actual failure shape, which "do not dump a questionnaire" never covered: a
  table plus a rationale list plus a "before you answer" section, all to ask one
  question, is the same failure as five questions at once. It just looks more
  diligent.

### Notes
- Not adopted: a compression register (dropping articles, abbreviating,
  substituting symbols) and an opt-in brevity mode. The defect was surface area,
  not spelling — and a toggle still requires asking for brevity, which is the
  friction being removed. Invented abbreviations and symbol substitutions are
  explicitly banned by the rule: they measure as no cheaper under the tokenizer
  while costing the reader a decode step.
- The effect is measured rather than asserted. `feed` and `cost` already capture
  per-turn output tokens, so the plan recorded a before baseline (582 turns,
  median 739 output tokens, mean 943) and the delta lands post-ship. The number
  is a proxy: a turn that got shorter by reading less would score as a win, so it
  is read alongside whether the answers stayed right.

## [0.12.0] - 2026-07-31

A tool whose own loop authors what its own lint rejects teaches the user that
the lint is noise. A throwaway project built end to end by an agent following
codument's scaffolded loop produced a registry `doctor` rejected on seven
counts — every finding correct. The exclusion spec governed every path that
*reads* the registry and none that *writes* one, and `empty-depends-on` asked
for a graph the import layer could already resolve.

### Added
- `empty-depends-on` names the edges codument can derive from the entry's
  imports instead of sending you to find them by hand. They ride the existing
  finding — same id, same severity, same firing conditions — so nothing about
  the exit code moves and an entry with nothing derivable keeps its original
  wording and gains no JSON key at all. The edges are stated as a **floor**,
  never as the entry's dependencies: import resolution sees only the coupling
  expressible as an import, so runtime wiring or a shared data shape produces a
  real edge with no import to read. Nothing is written to the registry.

### Fixed
- Authoring a registry entry now refuses a generated, build, or test file
  instead of accepting one and letting `doctor` report it afterwards. The
  exclusion contract was already settled and additive-only — there is no case
  where a test file belongs in an entry — but nothing on the write path
  enforced it. Reading stays deliberately tolerant, so `doctor` can still
  report a registry that is already wrong, and only a *newly introduced* path
  is refused, so an entry that already names a test file can still be extended
  or repaired.
- `codument map materialize` refuses an out-of-scope path and names the rule
  that fired. A project's own `exclude` declaration and a built-in heuristic
  call for opposite responses — "un-map it, or narrow what you declared" is not
  "codument's guess may be wrong about your file" — and one generic refusal
  sent both to the same dead end. Routing also resolves the project's declared
  scope rather than only the built-in defaults, closing a gap where a path the
  project itself put out of scope stayed authorable on the one path that writes.
- A refused `map materialize` no longer strands a scaffold doc for a feature
  that never came to exist: the entry is authored before anything reaches disk.
- The authoring rule shipped to every project (`rules/documentation.md`) states
  the scope contract at the point where entries are hand-authored, and points
  invariant-to-test links at doc prose, which needs no registry mapping.
- Opus 5 and Sonnet 5 are priced from the built-in rate table. Both families
  moved to a single-segment model id (`claude-opus-5`), a shape the transcript
  normalizer only recognized for Fable and Mythos, so a current-generation
  session was counted in tokens and then left unpriced. The dated-snapshot
  suffix is now stripped before the version is read, so a date can no longer be
  absorbed as a minor version (`claude-opus-5-20260101` resolves to `opus-5`,
  not `opus-5.20260101`). Sonnet 5 carries its standard rate, not the
  introductory one that lapses 2026-08-31 — an estimate that silently starts
  under-reporting on an untracked date is worse than one that is briefly
  conservative. Events captured before this fix keep the model id they were
  ingested under; `codument feed --reset` re-prices them.

## [0.11.0] - 2026-07-26

A long-lived feature doc does not hold one plan. It accumulates a dated
`## Delivery plan — … (YYYY-MM-DD)` section per shipped effort, and every parser
that read those docs took the first match — so the tool acted on a plan that had
shipped weeks earlier, or reported no checklist at all. Both failures were
silent, and the second is the worse one: a plan with genuinely unfinished work
simply vanished from discovery.

### Fixed
- `codument steps` reads the plan section the work is actually in — the first
  with an unchecked step, falling back to the last once every plan is complete.
  This is the same "has unfinished work" predicate plan discovery already used
  to select docs, so a single doc and a directory of docs can no longer disagree
  about which plan is active.
- A plan section is now scoped by heading depth: it runs to the next heading at
  the same or a shallower level. Ending it at any heading at all meant a plan
  that files its checklist under a subheading — `### As-built`, `### Plan
  delivery steps` — read as having no checklist, which hid its unfinished steps
  from `findActivePlans` entirely. A sibling section's checkboxes still never
  count, and step ordinals run continuously across a section's subheadings.
  Checked against 179 real plan and feature docs across four projects: 177 parse
  identically, 2 recover a checklist that was previously invisible, none change
  otherwise.
- `codument map` routes against the newest `feature-map` block rather than the
  first. Routing a newly landed file against a shipped effort's map reported a
  file the current plan genuinely declares as unmapped, which the routing rule
  treats as a hard stop.

## [0.10.0] - 2026-07-22

Field-report release. A run on a real monorepo — no repository at the root, two
nested member repositories — surfaced a class of defect where the scope codument
reasoned over was not the scope it had verified, and every divergence was
silent. The worst of them was a gate returning green over a tree it could not
see. This release closes that class and gives the coverage denominator its
user-maintained half.

### Added
- Monorepos of nested repositories, and submodule super-repos, are first-class layouts. Run
  codument at the workspace root — the directory containing the member repositories, which need not
  be a repository itself — and every git-backed surface (coverage, the gate, `scan`, warm) reasons
  over the aggregated union of the members' own git views. `review` prints each member's base HEAD,
  so a workspace verdict is reproducible from the tuple of member heads the way a single repo's is
  from one sha. What a single ref cannot honestly name across several repositories is refused rather
  than guessed: `review --base` (and the CI workflow `hooks install --ci` scaffolds around it), `audit <range>`, and `hooks install` at a workspace root
  fail with a `wrong-topology` diagnostic pointing at the member to run inside. For a nested-member
  monorepo, CI enforcement is `doctor` plus the worktree gate, not the two-ref PR gate. See ADR-016.
- Projects can declare their own exclusions in `.codument-meta.json`. The
  exclusion spec was a fully-plumbed parameter with exactly one value that ever
  existed, so build output landing somewhere unguessable (a `tsc` `outDir` of
  `out/`, a deploy tree, generated-but-committed files) could not be scoped out
  at all — and the "just edit the file" workaround was actively deleted by the
  next `codument adopt`. That left two wrong states and no third: a coverage
  score inflated by build artifacts, or hundreds of spurious `unmapped-source`
  findings from de-listing them by hand.

  ```json
  { "exclude": { "dirs": ["out", "public-preprod"], "globs": ["**/*.gen.ts"] } }
  ```

  Both keys are optional and **additive** — they widen the built-in spec and can
  never remove a built-in exclusion, so no project can quietly re-admit its test
  files into a coverage number. `dirs` takes bare directory names matched at any
  depth; a path there is rejected in favor of `globs`. The extension list stays
  unconfigurable: it is the language matrix's truth, and extending it would let
  codument claim support it does not have. There is no `--exclude` flag on
  purpose — scope is a repository artifact a reviewer sees in the diff, not an
  invocation choice that would let two runs of one commit disagree.

  Every consumer reads the same resolution: coverage, the lint net, the
  change-control gate, history audit, `scan` discovery, language detection, and
  the editor nudge. Declaring nothing is byte-identical to having no declaration.
  `doctor` and `scan` print what is in effect, and `doctor --json` carries
  `scope.configuredExclusions` **additively** (`version` unchanged).

  A malformed declaration fails by name rather than silently no-opping — a typo
  that quietly excludes nothing is indistinguishable from a working setting, and
  is the failure class this exists to close. An unreadable metadata file is a
  different failure and gets a different answer: it degrades to the built-in
  spec and *says so* on the same scope verdict the git half uses, because a file
  that does not parse says nothing about whether a declaration exists. `scan` is
  the exception that refuses outright, since the registry entries it writes are
  durable.
- `doctor` discloses when coverage was scored over a scope it could not verify.
  When the ignore rules cannot be determined, the denominator silently widened to
  the static exclusion spec alone and admitted build output as first-party
  source; because mapped build output lifts numerator and denominator together,
  the percentage read *better* than the truth. A monorepo with no repository at
  its root reported full coverage over a tree that was 37% compiled output. The
  caveat now prints beside the coverage headline, and `--json` carries
  `scope: { gitIgnore, reason? }` **additively** — `version` is unchanged and a
  consumer that ignores the field reads exactly what it read before. It is
  disclosure, never a finding: it does not affect the lint count or the exit
  code. `scan` prints the same caveat and records `lastScan.scopeUnverified`,
  because the registry a scan writes outlives the note that qualified it.

### Fixed
- The gate no longer returns a false green over a nested member repository. A monorepo whose
  packages are each their own git repository (and a super-repo with submodules) is opaque to the
  outer git: an owned source changed inside a member surfaced as `M child` — a gitlink with no
  extension — which the source-file test rejected into "other changed", so the stale-doc verdict
  never fired while `review --strict` exited 0. The git seam now resolves the member repositories,
  aggregates each one's own view prefixed back to workspace-relative paths, and routes a blob read
  to the owning member so `HEAD` means that member's HEAD. A nested verdict is byte-identical to a
  flat-repo control; a plain single repo is unaffected.
- `doctor` no longer crashes on a registry-mapped source whose language grammar
  git could not reveal. The adapter warm set was derived from git's view
  (`ls-files` plus working-tree status) while the analyzers walk the registry,
  and git's view is not a superset of it: a nested member repository reports as
  a single gitlink rather than its contents, a root git cannot read reports
  nothing, and a git-ignored file is never reported at all. Any such mapped file
  reached a synchronous parser cold and aborted the whole command with
  `TreeSitterError: <language> grammar not loaded`. The warm set is now the union
  of both views. Affects every bundled language, not only Python.
- `scan` now honors `.gitignore`. Its private walker shared the exclusion spec
  with the health analyzer but had dropped the ignore predicate, so it proposed
  build output the analyzer would never have counted — in **any** repository, not
  only the monorepo that surfaced it. Because a registry entry is durable, a
  single scan of a project with an unlisted build directory (a `tsc` `outDir` of
  `out/`, a deployed `public-preprod/`) wrote those artifacts in as first-party
  sources and every later run inherited them. Discovery now runs through the
  analyzer's own walker. **Behavior change:** scan proposes fewer files on repos
  with git-ignored source-extension output; it also no longer proposes symlinked
  source files (matching the analyzer, which never counted them), returns sorted
  rather than traversal-ordered results. It no longer skips an unreadable
  subdirectory silently — adopting the shared walker inherited that, and it was
  logged as owed rather than absorbed; see the discovery entry below.
- `generated-leakage` now fires on a git-ignored file listed as a source. The
  predicate was computed for the coverage denominator and never passed to the
  lint, so the one check that could have caught a registry full of build
  artifacts reported nothing. **Upgrade note:** a registry that already maps an
  untracked, git-ignored path will newly fail `doctor --strict`, with no code
  change on your part. Resolve it by un-mapping the file or by tracking it — the
  rule deliberately has no config escape hatch, since silencing leakage
  invisibly is the failure it exists to prevent. Only *untracked* ignored files
  are flagged, so a file you deliberately committed is never called build
  output however broad the pattern matching it.
- No directory walk skips an unreadable directory in silence any more. Source
  discovery swallowed the permissions error and returned a shorter file list,
  which shrinks the coverage denominator — and a smaller denominator makes the
  percentage read *higher* than the truth, the same most-confident-where-most-wrong
  inversion an undeterminable ignore set produced. The docs-tree walk had the same
  hole with a worse consequence: a doc under an unreadable directory is invisible
  to link-rot, a `warn` that gates `--strict`, so an actionable finding was
  suppressed with no trace. The workspace member walk had it too, where a hidden
  member repository takes its ignore rules down with it. All three now report, and
  the results merge into one list — the question is "what could codument not
  read?", not which internal walk tripped. `doctor` and `scan` name them,
  `doctor --json` carries `scope.unreadableDirs` additively, and the scan record
  keeps it because the entries outlive the console. Absent is not unreadable: a
  directory that does not exist contributes nothing and is never disclosed.
  **Breaking (library API):** `discoverSourceFiles` returns
  `{ paths, unreadable }` rather than a bare array — deliberately, so a
  programmatic consumer cannot keep reading a partial answer as a complete one.
- `path-enumeration` no longer penalizes a doc for doing what the documentation
  standard requires. The standard asks every invariant to link the test that enforces
  it; the finding counted each path MENTION, and any `src/**` path including a test
  file, so a doc's count rose as its invariants gained test links — observed in the
  field going 1 to 3 across a single documentation-improvement pass, every newly
  flagged path a test file. A metric that climbs as a project complies is backwards,
  and it trains agents and humans alike to strip test links to quiet `doctor`. The
  count is now over DISTINCT paths (three invariants pinned by one spec file are one
  file cited three times) and exempts test-convention paths everywhere in prose. A
  test path stays fully visible to `line-anchor` — the standard says cite the test,
  not the line. Genuine enumeration still fires at the same threshold.
- The prose path matcher captured multi-dot filenames only up to their first
  extension, so `x.service.ts` and `x.service.spec.ts` were the same string: two
  distinct files counted as one, and a test-path check could not see the `.spec.`.

### Changed
- `adopt` (and `update`) preserve every `.codument-meta.json` key they do not
  own. `adopt` rebuilt the file from a literal, so anything not on its keep-list
  was deleted with no message — which is why hand-editing the file was never a
  workable answer to a project-specific exclusion. The existing file is now
  carried forward and only the keys `adopt` owns are overwritten, so the next
  setting added to the metadata survives without anyone extending a list.
- `watch` names a failure that cannot recover instead of freezing on a stale
  frame. Its per-tick catch was written for a transient git failure; a state or
  config file the user just broke never self-heals, so the monitor would have
  rendered an aging frame indefinitely with no explanation.
- Git path enumerations (`listIgnoredPaths`, `listTrackedFiles`) report either an
  answer or a reason they have none, instead of returning an empty list for both.
  Internal API; no CLI surface changes. This is ADR-003's rule — "the gate could
  not run" must be distinguishable from "the gate ran and passed" — applied to
  scope resolution rather than to the verdict.

### Migration
- **`discoverSourceFiles` returns `{ paths, unreadable }` instead of a bare
  array.** Library API only; no CLI surface changes. Deliberately breaking rather
  than additive, so a programmatic consumer cannot keep reading a partial answer
  as a complete one. Update a call site by taking `.paths`, and read `.unreadable`
  if you want to know the walk was incomplete.
- **`doctor --strict` may newly fail on a registry you did not change.** A
  registry that maps an untracked, git-ignored path now raises
  `generated-leakage`. Resolve it by un-mapping the file or by tracking it. Only
  *untracked* ignored files are flagged, so a file you deliberately committed is
  never called build output however broad the pattern matching it.
- **`scan` proposes fewer files** on repositories with git-ignored,
  source-extension build output — it now honors `.gitignore`. If a previous scan
  wrote such artifacts into `primary_sources`, they remain until you re-run
  `scan` or remove them; `doctor` will name them as `generated-leakage` in the
  meantime.

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
