# codument

Docs-backed delivery workflow for AI coding agents.

Codument installs a small project operating system for agent-led engineering: docs, source-to-doc mappings, planning guidance, workflow skills, review discipline, and commit hygiene. The core loop is:

```text
grill -> plan -> approve -> implement -> verify -> document -> review -> commit -> repeat
```

The docs are not a side quest. They are the durable control plane that lets Claude, Codex, and future agents pick up the next step without relying on chat history.

## Install

```bash
npm install -D codument
```

## New Projects

```bash
npx codument init
```

Use `init` for fresh projects that do not already have Codument docs. By default, Codument installs the Codex/generic profile:

- `AGENTS.md` with the shared delivery workflow
- `.agents/skills/` with the core workflow skills
- `docs/` with feature, concept, guide, and ADR structure
- `docs/.registry.json` mapping source files to docs
- `.codument-meta.json` recording installed agent profiles

Install specific agent profiles with:

```bash
npx codument init --agents codex
npx codument init --agents claude
npx codument init --agents codex,claude
```

The Claude profile also writes `.claude/skills`, `.claude/agents`, `.claude/rules`, `.claude/settings.json`, and `CLAUDE.md`.

## Existing Projects

Use `adopt` when a project already has Codument docs, an older `.codument-meta.json`, or a legacy registry that uses `mappings` instead of canonical `features`.

```bash
npx codument adopt --dry-run --agents codex,claude
npx codument adopt --agents codex,claude
```

`adopt` is the migration/onboarding path. It:

- migrates legacy `docs/.registry.json` mappings into canonical feature entries
- keeps the old registry as `docs/.registry.backup.json`
- refreshes `.codument-meta.json` with current project detection and selected agents
- installs or updates the selected agent profiles using the same managed-file logic as `update`

When developing Codument itself, you can test a local checkout against another project by building the CLI and running it directly:

```bash
cd /path/to/codument
npm run build

cd /path/to/existing-project
node ../codument/dist/cli.js adopt --dry-run --agents codex,claude
```

To test hooks that call `node_modules/codument/...`, install a local packed copy of your checkout:

```bash
cd /path/to/codument
npm --cache /private/tmp/codument-npm-cache pack

cd /path/to/existing-project
npm install -D ../codument/codument-0.4.0.tgz
npx codument adopt --agents codex,claude
```

## Core Skills

Codument installs these delivery-loop skills:

| Skill | Purpose |
| --- | --- |
| `grill-with-docs` | Challenge a request against docs, code, ADRs, terminology, and edge cases before planning |
| `plan-with-docs` | Turn resolved decisions into a compact feature plan with steps and acceptance criteria |
| `tdd` | Implement one behavior slice at a time with the strongest practical feedback loop |
| `work-step` | Execute the next approved plan step without skipping ahead |
| `review-work` | Review the diff against the approved plan, tests, docs, registry, and architecture |
| `commit-work` | Verify, stage, and commit focused work with a conventional commit |
| `update-docs` | Fill scaffold docs or update mapped docs after source changes |

## Daily Workflow

Chat normally. Codument's always-loaded instructions route clear intent into the right delivery skill; slash commands are just explicit overrides when you want to force a phase.

1. Rough ideas and ambiguous feature requests trigger `grill-with-docs`.
2. Settled scope triggers `plan-with-docs`, which writes the durable plan and stops for approval.
3. Approved plans trigger `work-step` for the next unchecked step.
4. Completed implementation steps trigger `review-work` before any commit.
5. Clean or explicitly resolved reviews offer `commit-work` as the next gated action.
6. After commit, the agent offers the next work step, plan review, context compaction, or pause.

Working state should stay compact. Feature docs should capture the durable decisions, current plan, acceptance criteria, verification strategy, gotchas, and key files, not a transcript of every agent turn.

## Scan Existing Code

```bash
npx codument scan
```

`scan` groups source files into feature and concept docs, creates scaffolds, and populates `docs/.registry.json`. New entries are marked `needs-review`; run `/update-docs` to fill them with real content.

## Update Managed Files

```bash
npx codument update
npx codument update --dry-run
```

`update` refreshes the managed files for the agent profiles recorded in `.codument-meta.json`. Override the stored profiles when needed:

```bash
npx codument update --agents codex,claude
```

## Proof Benchmarks

Codument ships self-contained proof benchmarks. They do not call an AI model, require telemetry, or judge work subjectively.

The context benchmark compares two deterministic context-selection strategies over a packaged fixture:

```bash
npx codument benchmark context
npx codument benchmark context --json
```

Current fixture output:

```text
Naive context:    2,932 estimated file-context tokens (16 files)
Codument context: 1,610 estimated file-context tokens (8 files)
Reduction:        45.1%

Relevance:
  Required docs found:       3/3
  Required source files:     4/4
  Irrelevant files included: 0/8
```

These are estimated file-context tokens using `ceil(characters / 4)`. The benchmark proves that the packaged registry can route a known task to a smaller relevant working set. It does not claim every real task will reduce total model tokens; small tasks may spend more on workflow than they save.

The quality benchmark gives any coding agent the same fixture task and scores the final repo deterministically:

```bash
npx codument benchmark init /tmp/codument-bench --agents codex
cd /tmp/codument-bench
# Give BENCHMARK_TASK.md to your agent.
npm test
npx codument benchmark score /tmp/codument-bench
```

`benchmark score` checks the final files for passing tests, required behavior, docs updates, registry coverage, protected fixture metadata, source boundaries, and benchmark-specific shortcuts. It scores the final repo state, not the agent's private reasoning or path to the answer.

Expected scoring shape:

```text
Fresh fixture:     6/9 FAIL
Completed fixture: 9/9 PASS
```

To compare a baseline against Codument, initialize two fixture directories and give both agents the same task. In the baseline run, ask the agent to solve directly without using Codument's installed workflow. In the Codument run, ask it to follow `AGENTS.md` and the skills. Score both directories with the same `benchmark score` command.

## Documentation Structure

```text
docs/
  .registry.json
  overview.md
  getting-started.md
  features/
  concepts/
  architecture/decisions/
  guides/
```

The registry is the source of truth for which docs own which source files. Agents must check it before and after source edits.

## Requirements

- Node.js >= 18
- An AI coding agent that can read repo instructions and markdown skills

## License

MIT
