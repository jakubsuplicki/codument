---
title: Proof benchmarks
status: current
type: feature
last_reviewed: 2026-09-14
---

# Proof benchmarks

## In plain terms

Package-native fixtures measure whether documentation and workflow guardrails help on bounded tasks. Context routing, final-state quality and planted-bug checks are deterministic. Session comparisons add actual agent attempts at contract retrieval, changed approval and interrupted work, with valid controls that reveal unnecessary stops. Codument initializes and scores these fixtures locally; an external operator supplies the agent attempts. No scorer calls a model or uses a human or AI judge. Results describe the observed fixtures, never universal quality or token savings.

## Design approach

Proof lives in a separate `benchmark` command family: `context`, `init` and `score`. Quality and seeded catch-rate fixtures retain their existing defaults. Explicit session scenarios select a task and either ordinary documentation or Codument workflow integration; both conditions receive the same task, code, contracts, approval history and handoff.

The **context benchmark** runs over a fixed fixture with relevant, adjacent, and irrelevant areas and a registry mapping each task to its docs and sources. For a task it compares a naive context (everything a broad scan would pull) against the registry-guided context (the task feature's docs and sources plus declared dependencies), estimating tokens with a stable local character-count heuristic — the heuristic's exact value matters less than its consistency, since the benchmark compares two strategies over the same fixture. It reports token reduction alongside relevance coverage (required docs found, required sources found, irrelevant files included) and can emit schema-versioned JSON.

The **quality benchmark** ships a dependency-free fixture app with a constrained, realistic task. `init` copies the fixture, installs the agent profile assets, writes the task prompt to disk, and prints it; the agent does the work; `score` evaluates the final directory with deterministic checks — tests pass, typecheck, black-box behavior, the registry still maps touched sources, required docs updated, source boundaries respected, locked fixture files untouched, and forbidden shortcuts absent. The score is a transparent evidence bundle plus a numeric summary; the bundle is the real proof, the number is for a README screenshot.

Scoring never needs a network, model or hosted telemetry. Observed session duration and available usage are reported separately from the grade: a small task may spend more on workflow than it saves. Missing measurements retain their reason.

Session fixtures keep their behavioral detectors outside the worker directory. An external observer retains the initialization binding, then records the actual attempt and its final file binding. Scoring checks immutable task inputs, approved contracts, permitted changes and black-box behavior. It distinguishes failed constraints from failures of an authorized control, including unnecessary permission stops. Different correct implementations can pass. A changed approval blocks only the dependent request; a resumed step must recheck changed work while retaining usable existing work.

The observation records attempt provenance, status, interventions, elapsed time, optional usage and limitations. It binds the original input and observed final files, including saved workflow state and staged content. A commit-ready claim also runs the behavioral checks against staged blobs, and a changed commit violates the fixture's no-commit constraint. Unnecessary approval stops are counted separately from ordinary failed control behavior. Missing, malformed, oversized or mismatched evidence is unavailable, never a comparable zero. A failed attempt remains a failed attempt even if some checks pass; synthetic scorer tests are explicitly separate from agent sessions. These bindings detect changed inputs and outputs, but do not authenticate the observer or independently prove an agent's reported review actions.

Initialize with `benchmark init <dir> --scenario <retrieval|approval-change|interrupted-work> --condition <plain|integrated> --json`. Save that output outside the fixture before starting an agent. After the attempt, `benchmark score <dir> --snapshot` returns its final binding without grading it. Supply `benchmark score <dir> --session-record <observation.json> --json` to grade. The external observation has these required fields:

```json
{
  "version": 1,
  "fixture": "session-control",
  "task": "retrieval",
  "condition": "integrated",
  "runId": "from-initialization",
  "inputDigest": "from-initialization",
  "finalDigest": "from-post-attempt-snapshot",
  "kind": "agent",
  "status": "completed",
  "agent": "actual-agent-description",
  "startedAt": "2026-09-10T00:00:00Z",
  "finishedAt": "2026-09-10T00:01:00Z",
  "usage": null,
  "usageUnavailableReason": "Host did not expose counts for this attempt",
  "interventions": [],
  "limitations": ["One bounded attempt; not a general quality estimate"]
}
```

Status may also be `blocked` or `failed`; unit fixtures use `kind: test`. Available usage supplies nonnegative integer `input` and `output` counts with a null absence reason. Interventions contain a `kind` of `clarification`, `approval` or `environment`, plus a short `detail`. Record observed facts, including failed attempts and missing metrics; initialization or a synthetic handoff does not establish an agent run.

The **catch-rate benchmark** is the ground-truth proof behind the review gate (see [[review-effectiveness-metric]]). It ships a fixed buggy diff — an agent's "completed" feature branch carrying planted, documented bugs — laid as uncommitted working-tree changes over a committed baseline. The user runs their agent two ways: a *no-loop* run commits the diff as-is, a *loop* run reviews the diff and fixes what it catches. Scoring runs one hidden detector per bug (a test that passes iff that bug is fixed) and reports a catch rate plus the loop-vs-no-loop delta. The load-bearing choice is that the diff is *fixed*, not agent-authored: the planted bugs are reliably present and the score is reproducible. The answer key (the bug manifest and the detectors) lives only in the published package, never in the initialized scenario, and the buggy diff carries no markers naming the planted bugs, so the agent must find them by reviewing the diff rather than read them off the page; `init` lays the baseline as a real git commit so `review` has a base to diff against. The honest boundary on this benchmark: a no-loop baseline is ~0% by construction (no review, no catch), so the comparison is "0% vs X%" — proof that review catches X% that would otherwise ship, not a natural-catch-rate baseline; an agent-implements-the-task variant is a possible later iteration. False-positive rate is out of scope until decoy bugs exist, and a single run is not statistically definitive — the harness scores whatever runs happen and the user can repeat.

## Invariants & boundaries

- Session conditions preserve their engineering information and expose real stale approval and paused work state. Integration changes installed workflow guidance, never the task or answer availability. *(test: `benchmark-sessions.test.ts`)*
- Session scores exercise dependent constraints and valid controls, accept alternative correct implementations, and count unauthorized changes and unnecessary stops. Missing or changed observation/input bindings, linked inputs and changed locked contracts are refused. Saved work and staged content participate in the observed final binding. *(test: `benchmark-sessions.test.ts`)*
- Commit-ready work must satisfy behavior, scope and protected-contract checks in the actual index, including staged changes hidden by restored working files; unrequested commits fail. Coding errors in an authorized control remain missed constraints, independently of reported unnecessary stops. *(test: `benchmark-sessions.test.ts`)*
- Agent observations remain distinct from deterministic test fixtures; duration, usage availability and interventions are evidence, not scoring weights. No autonomous agent runner is included. *(test: `benchmark-sessions.test.ts`; independent attempts are recorded separately)*

- Context collection preserves real filename characters when converting native separators; it
  never trims a filename or rewrites a literal POSIX backslash before reading or scoring it. *(test:
  `benchmark.test.ts` "preserves real filename characters while collecting context")*

- `benchmark context` is deterministic and runs with no network and no model: the same package version and fixture always yield the same token and relevance numbers. File identities use registry-relative paths on every platform, so Windows separators cannot turn relevant files into misses. *(tests: `benchmark.test.ts` "runs the deterministic context benchmark", "scores the context fixture deterministically", "estimates tokens with a stable local heuristic")*
- The context benchmark works from packed package contents, not only the source repo, and emits stable schema-versioned JSON. *(tests: `benchmark.test.ts` "runs the context benchmark from a packed package", "declares benchmark fixtures as packaged files", "prints the context benchmark as stable JSON")*
- `benchmark score` exits success only when every required check passes, and tampering with locked benchmark metadata fails the score. *(tests: `benchmark.test.ts` "scores a completed quality benchmark as passing", "scores an incomplete initialized quality benchmark as failed", "fails quality scoring when locked benchmark metadata changes")*
- The quality score is an evidence bundle, not a single opaque number; the benchmark never calls a model or uses a judge. *(boundary — see ADR 008; enforced by the deterministic-scoring tests above)*
- The catch-rate scorer is deterministic given the final file state (no clock, network, or model; detectors run in an isolated env and a non-completing detector errors rather than counting as a miss): the raw buggy diff scores 0%, a fully fixed solution scores 100%, and a partial fix scores the exact fraction. *(tests: `benchmark-seeded.test.ts` "scores the raw buggy diff as 0% caught", "scores a fully fixed solution as 100% caught", "scores a partial fix as the correct fraction", "is deterministic — scoring twice yields the same result", "ignores ambient NODE_OPTIONS when running detectors"; `classifyDetectorRun` unit cases)*
- Neither the bug manifest, the detectors, nor any naming of which bugs are planted is copied into an initialized scenario, so the agent has to find the bugs by reviewing the diff, not by reading an answer key. *(tests: `benchmark-seeded.test.ts` "never copies the answer key into the scenario", "never reveals which bugs are planted inside the scenario")*
- `init --seeded` lays the feature work as an uncommitted diff over a committed baseline; tampering with the locked scenario identity fails the score and records no comparable result. *(tests: `benchmark-seeded.test.ts` "lays a seeded scenario as an uncommitted feature diff", "fails the score when the locked scenario identity is tampered")*
- A loop run compares only against a baseline directory that was already scored; an unscored baseline is a clear error, not a silent zero. *(tests: `benchmark-seeded.test.ts` "compares a loop run against a no-loop baseline", "errors clearly when a baseline directory was never scored")*

## Decisions

- The benchmark proof model: a deterministic, package-native `benchmark` command family that never uses a judge: [008-benchmark-proof-deterministic-not-judge](../architecture/decisions/008-benchmark-proof-deterministic-not-judge.md).
- The [recorded session comparison](../../fixtures/benchmarks/session-control/comparison-2026-09-14.json)
  retains every attempt, including the staged-delivery failure and format-sensitive unavailable
  result. Both conditions handled changed approval and interrupted work. Integrated runs also
  reported finalization friction; a passing fixture score does not prove a smooth workflow.
  The small sample and interrupted timing support no general quality, speed or token-savings claim.

## Key files

- `src/commands/benchmark.ts` — the `benchmark` command family wiring the `context`, `init <dir>`, and `score <dir>` subcommands.
- `src/lib/benchmark-context.ts` — the deterministic context-routing scorer: naive vs registry-guided selection, the token estimator, and relevance coverage.
- `src/lib/benchmark-quality.ts` — the quality-fixture lifecycle: `init` copies the fixture and writes the task; `score` runs the deterministic final-state checks and the evidence bundle. Also owns the shared scaffolding helpers (target guard, agent-asset install, meta) the seeded benchmark reuses.
- `src/lib/benchmark-seeded.ts` — the catch-rate lifecycle: `init --seeded` lays the buggy diff over a committed baseline; `score` runs the hidden per-bug detectors, reports the catch rate and per-bug breakdown, and compares loop vs no-loop runs.
- `src/lib/detector-result.ts` — the dependency-free rule that turns a detector's process result into caught / survived, and refuses to score a run that did not complete.
- `src/lib/benchmark-sessions.ts` — matched session inputs, observation integrity and deterministic constraint/control scoring.
