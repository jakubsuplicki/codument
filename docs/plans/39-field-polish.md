---
status: approved
---

# Plan 39: field polish — generated-artifact intent, Windows invocation, one-line findings, verdict last

Six small verified findings from the 2026-08-07 Expo-app field report and its follow-up
interrogation. None touches gate semantics; together they are the difference between "the CLI
didn't survive PowerShell" and it surviving.

1. **Generated artifacts governed by luck.** 240 generated locale JSON files went ungoverned only
   because `.json` is not a source extension — the correct outcome, reached without recorded
   intent ("It happened to be fine because unregistered JSON isn't treated as source, but that's
   luck"). The recording mechanism shipped in plan 27 — the `exclude` block in
   `.codument-meta.json`, which `scan` already signposts for swept build output
   (`src/commands/scan.ts`) — but no skill tells an agent whose step *generates* artifacts to
   declare them.
2. **Windows argument mangling.** `bunx codument ack --reason "..."` mangled its quoted
   arguments, forcing direct `node node_modules/codument/dist/cli.js` invocation for the entire
   session. The follow-up pinned it precisely: bunx (bun 1.2.19, Windows 11) splits a quoted
   value into words before argv — `--reason "one two three"` fails with "Expected 1 argument
   but got 3", arity tracking the word count — identically from PowerShell and Git Bash, while
   byte-identical direct `node` invocation works. Purely bunx argument marshalling; commander
   never sees it. Filable upstream against bun as-is (one package, one flag, three words) —
   filing it is part of this plan's step; nothing in the emitted guidance or docs warns
   meanwhile.
3. **Single-anchor render noise.** Under ADR 014 a component/config file has one precise
   `default.` anchor, so every edit prints a file-level change *and* a `default (changed)` line
   that "never told me anything the file-level change list hadn't." The anchor's precision is
   load-bearing (token invariance, body/signature split, the ack route); the rendering repeating
   itself is not.
4. **Verdict readability.** The report's author read gate results by grepping piped output rather
   than trusting the exit code, and calls the habit fragile. The CLI can meet it halfway: make
   the last stdout line always be the verdict, so `| tail -1` reads truth.
5. **Two-register docs.** When the gate forced a line into a legacy doc written wall-to-wall in
   mechanism voice (hex colours, call sequences), the agent had to choose between the doc's voice
   and the standard, picked the standard, and the doc now reads in two registers. The full
   rewrite of a legacy doc belongs to the repo that owns it (the prose-altitude lint already
   names the offending sections); what codument can fix is the skill leaving the choice implicit.
6. **Dead acks accumulate.** The field session ended with 342 acks, 52 auto-invalidated (15%) —
   each flagged in `ack --list` with a per-ack `--remove` hint, which nothing in the workflow
   ever runs. Auto-invalidation working as designed (ADR 006) produces dead weight nothing
   sweeps; the honest cost of "ack a file, then edit it again next step" should be one prune,
   not 52 manual removals.

## Why

Each is a paper cut from the same session, individually too small for a plan, collectively the
practical-notes section of the report. Grouped because none changes what fires or exits.

## Scope

- `src/commands/review.ts` — single-anchor render collapse; final verdict line
- `src/commands/ack.ts` — `--prune` flag + `--list` footer
- `src/lib/scaffold.ts` `buildManagedSection()` — one Windows-invocation line — plus regenerated
  in-repo managed blocks
- `skills/work-step/SKILL.md` + installed `.agents/skills/` copy — generated-artifact exclude rule
- `skills/update-docs/SKILL.md` + installed copy — touched-section rule for legacy docs
- `docs/getting-started.md`, `README.md` — Windows note
- Tests: `tests/review.test.ts` (render + last-line pins), scaffold test (managed-line pin)
- `CHANGELOG.md`, `docs/.registry.json`

## Non-goals

- **No registry glob support.** The report notes the registry lacks the globs the feature-map
  syntax has — but registered sources are the per-symbol ownership substrate, and generated files
  belong in the declared `exclude`, never the registry. Hand-registering 240 generated files was
  never the intended state; the feature map's globs already expand at materialize time for real
  source. Rejected, not deferred.
- **No argv workaround for bunx.** The mangling happens before the CLI runs; parsing tricks
  cannot un-mangle it. Guidance is the honest fix.
- **No change to exit codes, verdict computation, or `--json`/SARIF shapes.** Rendering and
  guidance only.

## Decisions (settled)

- **`work-step` gains the generated-artifact rule**: a step that generates artifacts declares the
  output path in `.codument-meta.json`'s `exclude` block in the same step — recorded intent, not
  luck — mirroring the signpost `scan` already prints for swept build output.
- **One conditional Windows line** in the managed section and `docs/getting-started.md`: if a
  codument command's quoted arguments arrive mangled (observed with bunx on Windows), invoke the
  CLI via `npx codument` or `node node_modules/codument/dist/cli.js`. One line, stated as a
  symptom-keyed fallback, not platform ceremony.
- **Single-anchor collapse in human output**: a precise file whose anchor changes are exactly one
  `default.` anchor renders as one line — the file plus what moved (body vs signature) — instead
  of a file line and a symbol line saying the same thing. Multi-anchor files, `--json`, SARIF,
  and the bundle are untouched.
- **Verdict-last contract**: every human-output mode of `review` ends stdout with a single
  verdict line (clean, or the blocking-finding count); exit codes unchanged; a test pins
  "last line is the verdict" so hint text can never drift below it again.
- **`update-docs` gains the touched-section rule**: when a gate-owed edit lands in a section
  written at mechanism altitude, rewrite that section to the standard rather than matching its
  voice or appending a second register — and leave the rest of the doc alone. A whole-doc rewrite
  is its own decision for the owning repo, not a side effect of clearing a wake. Same skill, one
  more line: registry `status` is authored metadata nothing maintains automatically (the field
  repo's i18n entry still said `needs-review` after its doc was rewritten and its gate driven
  green) — when resolving a feature's docs brings them current, update a stale `status` in the
  same step.
- **`ack --prune`** removes every auto-invalidated ack in one command (validity recomputed the
  same way `--list` already does), prints what it removed, and touches nothing covering or
  indeterminate. `ack --list` suggests it in one footer line when any invalidated ack exists.
  Removal events go through the existing `emitAckRemove` audit path.

## Delivery Plan

- [x] **Step 1 — Review rendering.** Single-anchor collapse + verdict-last line; tests pin both
      (golden single-anchor output; last-line assertion across clean and red runs).
- [ ] **Step 2 — Windows guidance.** Managed-section line via `buildManagedSection()` (regenerate
      in-repo blocks, pin in scaffold test); getting-started + README note; file the upstream
      bun issue with the minimal repro and link it from the note.
- [ ] **Step 3 — `ack --prune`.** The flag, the `--list` footer, audit events; tests: prunes only
      invalidated, idempotent on a clean set, indeterminate untouched.
- [ ] **Step 4 — Skill rules.** The exclude rule into `work-step` and the touched-section rule
      into `update-docs` (mirror installed copies); CHANGELOG; registry checked for touched
      sources.

## Acceptance criteria

- Field replay: an edit to a single-default-export `.tsx` prints one finding line, not two;
  `codument review --strict | tail -1` is the verdict on both clean and red runs.
- The managed block and getting-started carry the Windows fallback line after `codument update`.
- `work-step` names the exclude declaration wherever a step generates artifacts.
- `npm run typecheck`, `npm run build`, `npm test` green; `codument review --strict` green at
  every commit.

## Verification strategy

- Unit: golden render for the single-anchor collapse (and a two-anchor file proving no collapse);
  last-line pins; managed-section line pin.
- The skill and docs lines are prose-reviewed; no behavior to test.
