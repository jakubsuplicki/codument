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
  - registry-health-and-change-control
last_reviewed: 2026-06-18
---

## Summary

Tracks the agent's token spend and attributes an estimated dollar cost per feature, step, and model — surfaced live in `codument watch` and summarizable from the event log.

codument never calls an LLM, so it cannot meter tokens itself. Usage counts arrive one of two ways: an agent reports them explicitly via `codument emit tokens`, or `codument feed` auto-tails the agent's own session transcript (Claude Code today) and normalizes per-turn usage into the log for you. Either way a `type: "tokens"` event lands in `.codument/events.jsonl`. Cost is **derived at read time** from a rate table and is never persisted — so the figure is always an estimate, never a bill, and old logs never carry a stale dollar amount when rates change.

Rates are **user-configurable with built-in defaults**: codument ships accurate Claude rates and merges an optional project `.codument/rates.json` over them (`loadRates`), so any other model (Codex/GPT, Gemini, a fine-tune) can be priced without a codument release. This keeps the feature agent-neutral, matching codument's neutrality everywhere else.

## How it works

1. **Producers** — two ways usage enters the log:
   - `codument emit tokens --model opus-4.8 --input N --output N --cache-read N --cache-create N [--feature F] [--step S]` records one explicit event. `emitTokens()` writes all four token buckets unconditionally (even when 0) and omits `feature`/`step` entirely when absent. Counts only — no cost field is stored.
   - `codument feed` (`claude-feed.ts`) tails Claude Code's append-only session transcript under `~/.claude/projects/<slug>/<session>.jsonl`, reads each assistant turn's exact per-turn usage, attributes it to a feature via the registry's file→feature map, and appends the same `type: "tokens"` events. Zero extra token cost (it reads telemetry that already exists), idempotent (safe alongside `watch`), and best-effort/defensive against the internal transcript format changing. `watch` auto-runs it unless `--no-feed`.
   - `codument feed --reset` (`resetFeed`) rebuilds the feed-sourced events from the transcript(s) under the *current* normalization — the cure for stale events left by an older `normalizeModelId` (e.g. a model id that used to read `unpriced`). It re-pumps every session the cursor has touched plus the active one (not just the newest, so a multi-session history isn't undercounted), **preserves manual `emit`s and `review` notes**, and keeps any feed event whose transcript is gone verbatim rather than dropping it (so a rebuild can never silently lose cost data it can't re-derive). The new log is assembled in memory and written **once, atomically** — no backup, but also no destroy-before-rebuild window. Feed events are identified by an unconditional `source: "feed"` marker (legacy `session`/`uuid` stamps are still honored for older logs).
2. **Pricing** — `costOf(usage, model, rates)` prices the four buckets independently from the resolved rate table (USD per million tokens; defaults to built-in `MODEL_RATES`). `loadRates(root)` resolves the table by merging `.codument/rates.json` over the defaults via the pure `mergeRates`; per-bucket override for known models, absent buckets default to `$0` for new ones, malformed/negative values and prototype-polluting keys are rejected. The buckets have very different prices: cache reads are ~0.1× input (10× cheaper) and dominate token counts in agentic coding, while cache creation is ~1.25× input and output is ~5× input. Model lookup is exact-key only; an unknown id yields an all-zero breakdown flagged `unpriced: true` rather than a plausible-but-wrong bill.
3. **Reducer** — `summarizeTokens(events)` folds the (untrusted) event log into totals plus per-feature / per-step / per-model rollups, defensively coercing every field (a numeric string like `"5000"` coerces to `0`, never `5000`). Token counts include every attributable event; cost prices only the known-model portion.
4. **Live view** — `renderFrame` in `watch.ts` adds an "estimated" token-cost block: session total tokens, estimated dollar cost, and the top three features by cost, with an "unpriced models" note when an unknown model appears. The block sits below the not-a-git-repo early return and is hidden until at least one token event exists.

## Key files

- `src/lib/token-cost.ts` — cost math + rates: `TokenUsage`, `MODEL_RATES`, `RateTable`, `costOf()`, the pure `mergeRates()`, and `loadRates()` (the only I/O — reads `.codument/rates.json`).
- `src/lib/token-report.ts` — `summarizeTokens()` reducer + the canonical `isTokenEvent()` guard and `TokenEventData`/`TokenRollup`/`TokenSummary` types.
- `src/lib/emit-producer.ts` — `emitTokens()` producer; re-exports `isTokenEvent` (single source of truth).
- `src/commands/emit.ts` — `codument emit tokens` CLI action (count parsing + attribution flags).
- `src/lib/claude-feed.ts` — Claude Code session-transcript adapter: discovers the active session log, normalizes per-turn usage + tool activity into events, idempotent tailing, and the `--reset` rebuild (`resolveSessionLog`, `pumpFeed`, `resetFeed`, `featureForFile`, `normalizeModelId`).
- `src/commands/feed.ts` — `codument feed` CLI: one-shot (`--once`), continuous tail, or `--reset` rebuild of the session log into `.codument/events.jsonl`.
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
- **Auto-tail is Claude-specific and best-effort.** `codument feed` reads Claude Code's *internal* transcript format, so it parses defensively — a format change degrades to fewer events, never a crash. The vendor-neutral seam stays `emit` + the events log; other agents report via `codument emit tokens` (or their own adapter). Model ids from the transcript (`claude-opus-4-8`) are normalized to the rate-table keys (`opus-4.8`) by `normalizeModelId`.
- **Stale events survive a normalization change — `feed --reset` re-prices them.** The tailer's byte-offset cursor means events already written under an *older* `normalizeModelId` (so they read `unpriced`) aren't re-touched by ordinary pumps. `codument feed --reset` rebuilds them at the current normalization. It's selective by design: feed marks every event with `source: "feed"`, so reset rebuilds exactly those and leaves manual `emit`s and `review` notes (which carry no marker) intact. Events whose transcript no longer exists are kept verbatim rather than dropped — reset never loses cost data it can't re-derive (`preserved` in the result; the CLI prints a yellow warning). Re-pumped events are appended after the kept/preserved ones, so the log isn't globally re-sorted by timestamp — totals are exact, but the activity-tape ordering is approximate after a reset.
- **`feed --reset` re-derives at the *current* registry + active session.** Two consequences: (1) feature attribution is recomputed from today's `docs/.registry.json`, so a since-renamed/removed file may attribute differently than when first fed — attribution is an allocation, not a ledger; (2) reset includes the *active* session even if it was never fed before, so the total can legitimately *rise* (it reflects the full picture feed can currently see). `feed` only ever tails the active session, so sessions that were never tailed are not retroactively discovered by reset.
