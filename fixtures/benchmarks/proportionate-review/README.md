# Proportionate review trial

This bounded trial derives the working count-command example from
`tests/workflow-milestone.test.ts`, with two existing precisely analyzed TypeScript sources
owned by one nonrisk feature. Both released 0.20.1 and the frozen candidate receive the
same source, test, durable contracts, legacy scoped two-step approval and no-commit task.
The first milestone ends at verified staged readiness; final-plan compaction is excluded.

The operator copies `project/` into fresh local Git fixtures, installs each version's Codex
managed assets, binds the same plan approval, and supplies identical compiler/test scripts
using the existing installation. The fixture sources intentionally contain a permissive
numeric-prefix parser and an off-by-one report. No dependency installation is needed.
The protocol is frozen before the four real serial agent attempts. A representative staged
repair must first classify as adversarial on 0.20.1 and focused on the candidate.

An external common CLI wrapper records command output/status/duration for both conditions.
The operator records actual reviewer starts from the collaboration tree. An external grader
compiles and exercises worktree and staged sources, runs the regression tests, checks locked
inputs and source signatures, and requires current ready work with an unchanged HEAD.
Raw observer and grader files stay outside worker fixtures; the compact comparison retains
observations, failures, provenance, timing and unavailable usage explicitly.

This fixture establishes working output and fewer unnecessary adversarial handoffs only
for the observed repair. It establishes no universal speed, token, quality or project-wide
productivity claim. It does not replace protected-case regressions or prove final-plan
completion. Reviewer independence is operator observed, not cryptographically authenticated.

The [recorded comparison](comparison-2026-10-04.json) preserves unmet original two-pair acceptance. Both candidate
attempts and the first baseline reached correct, verified staged readiness. The first pair
observed one baseline independent reviewer and zero candidate reviewers. The second baseline
produced correct working and staged output but timed out at required review after the host
refused fresh reviewer creation; zero reviewers actually started for that attempt. The second
pair therefore establishes neither complete matched readiness nor a handoff reduction.
No failed attempt was retried, completed retroactively or replaced with a scripted result.
The user approved limited release acceptance on 2026-10-05, using the completed first pair and
both successful candidate repetitions, while retaining the incomplete second control. The record
keeps original and approved release acceptance separate; claims stay within that observed boundary.

Readiness timing comes from the common CLI observations. Exact final-turn completion times
and attributable token counts were unavailable. The timeout was detected at a late clock
sample while the controller had been interrupted; its nominal cap and observed stop remain
separate. Supplementary control-character and Unicode output inspection is explicitly
post-attempt evidence, leaving the primary grader and frozen inputs unchanged.

To reproduce the setup, copy `project/` to a fresh local Git fixture, expose an existing
`node_modules` containing TypeScript and tsx, and install Codex assets with the selected
frozen CLI using `init --agents codex --no-scan`. Keep the supplied registry, contracts,
package scripts and two-step plan; set source globs to `src/**/*.ts` and the finding runner
to `node --import tsx --test --test-reporter=tap {file}` in fixture metadata. Append the
protocol to managed AGENTS.md, use a locked common external CLI invocation wrapper, bind
the original scoped fixture approval, select that work, and commit the unchanged inputs.
These are operator initialization actions, never worker authorization to change locked inputs.
