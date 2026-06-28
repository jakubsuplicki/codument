---
title: Token Cost Tracking
status: active
type: feature
owner: ""
sources:
  - src/commands/emit.ts
  - src/commands/feed.ts
  - src/lib/claude-feed.ts
  - src/lib/emit-producer.ts
  - src/lib/token-cost.ts
  - src/lib/token-report.ts
related:
  - src/commands/watch.ts
depends_on:
  - cli
  - lib
  - change-control-gate
last_reviewed: 2026-06-19
---

## Summary

Tracks the agent's token spend and attributes an estimated dollar cost per feature, step, and model — surfaced live in `codument watch` (a glanceable top-3 of where it went) and in full via `codument cost` (the complete per-feature/model/step ledger).

codument never calls an LLM, so it cannot meter tokens itself. Usage counts arrive one of two ways: an agent reports them explicitly via `codument emit tokens`, or `codument feed` auto-tails the agent's own session transcript (Claude Code today) and normalizes per-turn usage into the log for you. Either way a `type: "tokens"` event lands in `.codument/events.jsonl`. Cost is **derived at read time** from a rate table and is never persisted — so the figure is always an estimate, never a bill, and old logs never carry a stale dollar amount when rates change.

Rates are **user-configurable with built-in defaults**: codument ships accurate Claude rates and merges an optional project `.codument/rates.json` over them (`loadRates`), so any other model (Codex/GPT, Gemini, a fine-tune) can be priced without a codument release. This keeps the feature agent-neutral, matching codument's neutrality everywhere else.

## How it works

1. **Producers** — two ways usage enters the log:
   - `codument emit tokens --model opus-4.8 --input N --output N --cache-read N --cache-create N [--feature F] [--step S]` records one explicit event. `emitTokens()` writes all four token buckets unconditionally (even when 0) and omits `feature`/`step` entirely when absent. Counts only — no cost field is stored.
   - `codument feed` (`claude-feed.ts`) tails **every** Claude Code session transcript whose recorded `cwd` matches the repo — not just the newest — under `~/.claude/projects/<slug>/<session>.jsonl`, reads each assistant turn's exact per-turn usage, attributes it to a feature via the registry's file→feature map, and appends the same `type: "tokens"` events. Following all matching sessions (via `resolveSessionLogs`, each pumped from its own byte offset) is what keeps concurrent windows from under-counting and stops the live total jumping between them. Zero extra token cost (it reads telemetry that already exists), idempotent (safe alongside `watch`), and best-effort/defensive against the internal transcript format changing. `watch` auto-runs it unless `--no-feed`.
   - `codument feed --backfill` (`backfillFeed`) ingests every matching transcript from offset 0, appending only turns not already captured (idempotent by turn `uuid`) — the retroactive complement to live tailing: a session that was never watched is picked up after the fact, since the agent keeps its transcripts whether or not `watch` ran. Additive and non-destructive (existing feed events, manual `emit`s, and `review` notes are untouched); it advances each session's cursor to end-of-file so the live pump won't re-emit what was backfilled.
   - `codument feed --reset` (`resetFeed`) rebuilds the feed-sourced events from the transcript(s) under the *current* normalization — the cure for stale events left by an older `normalizeModelId` (e.g. a model id that used to read `unpriced`). It rebuilds from **every matching transcript** (all sessions whose `cwd` matches, not just the newest or the cursor-touched — so concurrent history present at reset time is captured), **preserves manual `emit`s and `review` notes**, and keeps any feed event whose transcript is gone verbatim rather than dropping it (so a rebuild can never silently lose cost data it can't re-derive). The new log is assembled in memory and written **once, atomically** — no backup, but also no destroy-before-rebuild window. Feed events are identified by an unconditional `source: "feed"` marker (legacy `session`/`uuid` stamps are still honored for older logs).
2. **Pricing** — `costOf(usage, model, rates)` prices the four buckets independently from the resolved rate table (USD per million tokens; defaults to built-in `MODEL_RATES`). `loadRates(root)` resolves the table by merging `.codument/rates.json` over the defaults via the pure `mergeRates`; per-bucket override for known models, absent buckets default to `$0` for new ones, malformed/negative values and prototype-polluting keys are rejected. The buckets have very different prices: cache reads are ~0.1× input (10× cheaper) and dominate token counts in agentic coding, while cache creation is ~1.25× input and output is ~5× input. Model lookup is exact-key only; an unknown id yields an all-zero breakdown flagged `unpriced: true` rather than a plausible-but-wrong bill.
3. **Reducer** — `summarizeTokens(events)` folds the (untrusted) event log into totals plus per-feature / per-step / per-model rollups, defensively coercing every field (a numeric string like `"5000"` coerces to `0`, never `5000`). Token counts include every attributable event; cost prices only the known-model portion.
4. **Live view** — `renderFrame` in `watch.ts` leads with a plain-words **verdict** (`clean` / `drifting` / `at-risk` / `off-plan`, see `verdict.ts`) over a cost headline: the **all-sessions** estimated total with its provenance (`N sessions · Hh`), a `+$X this session` live delta (cost since the watch run started), and a per-feature "where it went" breakdown — plus an "unpriced models" note when an unknown model appears. The total sums **all** sessions in the log (the feed now captures them all), not just the active one. The block sits below the not-a-git-repo early return and is hidden until a token event exists.
5. **Full ledger** — `codument cost` (`cost.ts`) prints the complete breakdown the `watch` top-3 can't: the all-sessions estimated total, then **every** feature, model, and (when attributed) step sorted by spend, each with its share of the total. It is a pure read of the captured log — it does **not** tail or mutate it (refresh with `feed`/`watch` first) and needs no git repo, just a `.codument/events.jsonl`. `--json` emits the raw `TokenSummary`; unknown models are listed as "unpriced" rather than priced wrong. Share percents use **largest-remainder rounding** (`sharePercents`) so the column sums to exactly 100 rather than drifting from per-row rounding, and a real-but-tiny row reads `<1%` rather than a misleading `0%`.

## Key files

- `src/lib/token-cost.ts` — cost math + rates: `TokenUsage`, `MODEL_RATES`, `RateTable`, `costOf()`, the pure `mergeRates()`, and `loadRates()` (the only I/O — reads `.codument/rates.json`).
- `src/lib/token-report.ts` — `summarizeTokens()` reducer + the canonical `isTokenEvent()` guard and `TokenEventData`/`TokenRollup`/`TokenSummary` types.
- `src/lib/emit-producer.ts` — `emitTokens()` producer; re-exports `isTokenEvent` (single source of truth).
- `src/commands/emit.ts` — `codument emit tokens` CLI action (count parsing + attribution flags).
- `src/lib/claude-feed.ts` — Claude Code session-transcript adapter: discovers **all** `cwd`-matching session logs (`resolveSessionLogs`, with a per-file cwd cache; `resolveSessionLog` remains for the single-newest case), normalizes per-turn usage + tool activity into events, idempotent multi-session tailing (`pumpFeed`), the additive `backfillFeed`, and the `--reset` rebuild (`resetFeed`) — plus `featureForFile`, `normalizeModelId`.
- `src/commands/feed.ts` — `codument feed` CLI: one-shot (`--once`), continuous tail, `--backfill` (retroactive ingest of unwatched sessions), or `--reset` rebuild into `.codument/events.jsonl`.
- `src/commands/cost.ts` — `codument cost` CLI: the full per-feature/model/step ledger from `summarizeTokens` (cost derived at read time via `loadRates`); a pure read (no tail/mutation, no git needed). `--json` emits the raw `TokenSummary`; `--dir`/`--root` target another repo.
- `src/commands/watch.ts` — renders the estimated token-cost block; auto-runs the feed unless `--no-feed` (related).
- `src/lib/events.ts` — the append-only `.codument/events.jsonl` log this rides on; `readAllEvents`/`rewriteEvents`/`atomicWriteFileSync` back the selective, crash-safe `--reset` rebuild (related).

## API / Interface

- `costOf(usage: TokenUsage, model: string, rates?: RateTable): CostBreakdown` — `{input, output, cacheRead, cacheCreate, total, unpriced}`; `rates` defaults to `MODEL_RATES`.
- `mergeRates(base: RateTable, overrides: unknown): RateTable` — pure, defensive merge of user overrides onto a base table.
- `loadRates(root: string): RateTable` — built-in defaults merged with `.codument/rates.json`; tolerant of a missing/malformed file.
- `summarizeTokens(events: CodumentEvent[], rates?: RateTable): TokenSummary` — `{totals, byFeature, byStep, byModel, unpriced}`; each rollup is `{usage, cost, eventCount}`.
- `isTokenEvent(event): event is …` — strict guard (type `tokens`, non-empty string model, four finite buckets).
- `emitTokens(root, usage, {model, feature?, step?, ts?})` — append one token event (clamps usage so the event is always guard-valid).

## Gotchas

- **`cost === null` vs all-zero.** A group with events but no priced (known-model) tokens has `cost: null`. An empty/idle total has an all-zero priced `CostBreakdown`, not null — "$0 because nothing happened" is distinct from "unknown because the model isn't priced".
- **Counts exact, cost is floating-point.** Token counts stay exact integers (no division in the fold); only derived cost carries IEEE-754 slack, so cost comparisons use a tolerance and display uses `toFixed(2)`.
- **Estimate, not a bill.** Built-in `MODEL_RATES` are a snapshot (current as of 2026-06); users keep them current or extend them via `.codument/rates.json`. Re-pricing is retroactive — it answers "what would this usage cost at *today's* rates," not what it cost the day it ran (no per-date rate history). The watch block is explicitly labelled "estimated" and never claims actual/billed spend.
- **Attribution is an allocation.** Per-feature/step numbers depend on what the producer tags; a single agent turn can touch several features, and grilling/planning usage may be unattributed (`"(none)"`).
- **Not the context benchmark.** Distinct from `benchmark-context.ts`, whose `chars/4` figure estimates *context-window* savings, not real metered spend.
- **Zero-usage turns are skipped.** Claude Code writes `<synthetic>` assistant notices (model-selection errors, "No response requested.") with an all-zero usage block. `recordToEvents` drops any turn whose four buckets sum to zero, so these never inflate the event count or pollute the "unpriced models" signal with the non-model id `<synthetic>`. (A turn with even one non-zero bucket is real usage and is kept.)
- **Auto-tail is Claude-specific and best-effort.** `codument feed` reads Claude Code's *internal* transcript format, so it parses defensively — a format change degrades to fewer events, never a crash. The vendor-neutral seam stays `emit` + the events log; other agents report via `codument emit tokens` (or their own adapter). Model ids from the transcript (`claude-opus-4-8`) are normalized to the rate-table keys (`opus-4.8`) by `normalizeModelId`.
- **Stale events survive a normalization change — `feed --reset` re-prices them.** The tailer's byte-offset cursor means events already written under an *older* `normalizeModelId` (so they read `unpriced`) aren't re-touched by ordinary pumps. `codument feed --reset` rebuilds them at the current normalization. It's selective by design: feed marks every event with `source: "feed"`, so reset rebuilds exactly those and leaves manual `emit`s and `review` notes (which carry no marker) intact. Events whose transcript no longer exists are kept verbatim rather than dropped — reset never loses cost data it can't re-derive (`preserved` in the result; the CLI prints a yellow warning). Re-pumped events are appended after the kept/preserved ones, so the log isn't globally re-sorted by timestamp — totals are exact, but the activity-tape ordering is approximate after a reset.
- **`feed --reset` re-derives at the *current* registry across all sessions.** Two consequences: (1) feature attribution is recomputed from today's `docs/.registry.json`, so a since-renamed/removed file may attribute differently than when first fed — attribution is an allocation, not a ledger; (2) reset rebuilds from **all** `cwd`-matching transcripts (not just the active or cursor-touched), so the total can legitimately *rise* to reflect the complete multi-session picture. A session that was never tailed live IS now picked up retroactively — by `--reset` (re-derive everything) or `--backfill` (add only the missing turns). Capture is complete, no longer newest-only.
