---
title: Token cost tracking
status: current
type: feature
last_reviewed: 2026-09-14
---

# Token cost tracking

## In plain terms

This is the answer to "how much is the agent spending, and on what." It attributes token usage to a feature, step, and model, and surfaces it two ways: a glanceable top-of-spend headline in `codument watch`, and the full ledger in `codument cost`. The number is always labelled an *estimate*, never a bill.

The load-bearing design choice: codument never calls an LLM, so it can never meter tokens itself. It records the **raw counts the agent reports**, and the dollar figure is **derived at render time** from a rate table. Cost is never persisted. That has two payoffs that the whole feature is built around: re-pricing when rates change is free (just re-render), and no log can ever carry a stale dollar amount, because no log carries a dollar amount at all.

## Design approach

Capture availability is separate from the cost of captured counts. Status names each host as
available, empty, partial, unavailable or unsupported; an empty ledger alone proves no absence of
agent usage. Readable inputs with no captured token events are empty. Missing directories,
unreadable inputs, unidentified repositories, malformed records and bounded inspection are named.
An unavailable source can still have useful captured history. Status and cost inspection are reads;
they do not ingest sessions or change the ledger.

Usage sharing is explicit. A portable summary contains counts grouped by host, model and opaque run
identity, plus capture limitations. Missing run identity remains unknown; invalid model identifiers
and unsafe counts are disclosed rather than copied as plausible data. Summaries contain no transcript,
source path, feature name, private message or stored price, and have no automatic import path.
Export creates a new file and refuses the live ledger or an existing output, including aliases.

The pipeline is producers, a pricing layer, a reducer, and two views, all riding the append-only event log.

Manual reporting is vendor-neutral. Local Claude and Codex adapters share that event ledger and
read only existing session inputs. Recorded repository identity must match the requested root;
working in a Git worktree does not authorize another worktree's logs. The monitor captures both
hosts by default; explicit Codex file ingestion selects that input alone. Internal session formats
remain best-effort. A documented completed-turn stream needs a local repository/run header before
capture because the stream alone supplies no repository provenance.

Replay protection belongs to captured evidence as well as cursors. Writers share one exclusive local
transaction so simultaneous capture, manual append and reset cannot interleave a ledger replacement.
Claude turns retain replay identity across copies and restarts, and rebuild preserves unrelated hosts
and history whose source is unavailable or visibly incomplete. Codex captures monotonic usage deltas
and refuses a second usage representation of the same run. Cursor reset never resets already captured
usage. A changed or ambiguous stream is partial evidence. Inherited cumulative history has no reliable
boundary separating copied usage from new work, so it contributes no counts and remains explicitly
unavailable. Explicit completed-turn streams avoid that cumulative-history ambiguity. Decreasing
counters never manufacture new usage. Cache is a subdivision of input and
reasoning is a subdivision of output, so normalization keeps buckets disjoint. Missing counts are
reported; missing model/rate data remains unpriced. No transcript text or derived price is persisted.

**Pricing is a pure lookup, agent-neutral.** Cost is derived per bucket from a rate table of USD-per-million-token rates. Anthropic usage splits into four buckets (fresh input, output, cache read, cache create) with very different prices, and the trap the design exists to avoid is summing them at one rate: cache reads are roughly ten times cheaper than fresh input yet dominate the token count in agentic coding, so a single-rate sum massively over-bills. Built-in rates cover Claude and stay accurate; any other model is priced from a user-supplied rate file merged over the defaults, so a new vendor or fine-tune is priced without a codument release. Model lookup is exact-match only: a typo or an unknown id surfaces visibly as "unpriced" rather than as a plausible-but-wrong bill.

**The reducer is defensive and the log is untrusted.** It folds the event stream into totals plus per-feature, per-step, and per-model rollups, coercing every field (a numeric string is not a number) and never throwing. Token counts include every attributable event; cost prices only the known-model portion. Two cost signals are kept deliberately distinct: an all-zero priced breakdown reports zero estimated cost for the captured ledger without establishing capture availability, while a null cost means "events exist but none could be priced." Counts stay exact integers; only the derived cost carries floating-point slack.

**Two views, same captured log.** `watch` leads with a verdict and a cost headline (the all-sessions total plus a since-this-run delta and a where-it-went breakdown) and is a live consumer that auto-runs the feed. `cost` prints the complete ledger that the watch top-N omits, sorted by spend, as a pure read that never tails or mutates the log. Its share-percent column uses largest-remainder rounding so it sums to exactly 100 rather than drifting, and a real-but-tiny row reads under one percent rather than a misleading zero.

## Invariants & boundaries

- Rebuilt activity does not replace captured token evidence when that turn's usage is missing or
  invalid. Reset preserves the valid counts and partial-capture diagnostics without duplication;
  valid zero-usage notices still replace stale synthetic events. *(test: `claude-feed.test.ts`)*

- Codex capture requires recorded repository/run identity, rejects conflicting and unsupported inputs, and reads incrementally without persisting transcripts. Explicit completed-turn input needs matching thread identity. Read-only status exposes malformed usage before ingestion. *(test: `codex-feed.test.ts`)*
- Cumulative and completed-turn usage cannot count the same run twice. Replay, copies, cursor loss, truncation, counter resets and inherited history do not inflate captured usage; ambiguous evidence stays partial. Cache and reasoning subdivisions are never added twice. *(test: `codex-feed.test.ts`)*
- Capture and manual event writers share an exclusive transaction; a busy writer or incomplete ledger is preserved and named. Appending preserves an existing final record without a line terminator. Every Claude cursor replacement preserves evidence of truncated history, so backfill followed by reset cannot drop captured turns. Rebuild cannot drop Codex/manual events or double-count repeated turns. *(tests: `codex-feed.test.ts`, `claude-feed.test.ts`)*

- Capture reports distinguish readable-empty inputs from unavailable or unsupported hosts, and name partial evidence while retaining valid ledger events. Missing usage fields, malformed source records and inspection limits remain visible. *(test: `agent-feed.test.ts`)*
- Session identity comes from an absolute repository path in a complete top-level record, never a directory slug or nested tool input. Discovery and reset share the same inspected identity, including large opening records, and reset also recognizes identities on rebuilt events. They reject foreign input; prior cursors cannot authorize another repository, and existing captured history survives an unavailable source. *(tests: `agent-feed.test.ts`, `claude-feed.test.ts`)*
- Status and ordinary cost reads ingest nothing. Explicit exports contain counts, host/model, opaque or unknown run identity and limitations only; they never overwrite files, target the live ledger or import themselves as events. *(test: `agent-feed.test.ts`)*

- Producers store raw counts only; no derived cost, total, or dollar field is ever written to an event. *(test: `emit-producer.test.ts` "stores token counts only — never a derived cost")*
- All four buckets are written, including zeros, and untrusted counts (NaN, Infinity, negative) are clamped so every emitted event passes the strict guard. *(tests: `emit-producer.test.ts` "preserves zero buckets (no falsy drop)" + "normalizes non-finite or negative usage so the emitted event is always guard-valid")*
- An unknown model id is flagged unpriced with all-zero cost and never throws; lookup is exact-match with no case-fold, trim, or fuzzy match, so a typo can never be silently mispriced. *(tests: `token-cost.test.ts` "marks an unknown model unpriced with all-zero cost and never throws" + "requires an exact key — no case-fold, no trim, no fuzzy match")*
- Each bucket is priced at its own rate, so a cache-heavy mix is not over-billed by a single-rate sum. *(tests: `token-cost.test.ts` "prices each bucket at its own rate (1M of each, opus-4.8)" + "makes cacheRead 10x cheaper than input (the naive-sum over-bill trap)")*
- User rates merge over the built-in defaults per bucket, rejecting negatives, non-numbers, and prototype-polluting keys, and a malformed or missing rate file falls back to the defaults without throwing. *(tests: `token-cost.test.ts` mergeRates "accepts an explicit 0 bucket (free), but rejects negatives and non-numbers" + "ignores prototype-polluting keys"; loadRates "falls back to defaults on invalid JSON without throwing")*
- The reducer treats the log as untrusted: every count field is coerced (a numeric string coerces to 0, not its value) and the fold never throws. *(test: `token-report.test.ts` "coerces wrong-typed buckets to 0 (numeric string '5000' -> 0, not 5000)")*
- An empty log yields all-zero *priced* totals, while a group with events but no priced model yields a *null* cost: the two are kept distinct. *(tests: `token-report.test.ts` "returns all-zero priced totals for an empty log (NOT null cost)" + "counts unknown-model tokens but leaves their cost null and lists them unpriced")*
- Token counts stay exact integers; the reducer is order-independent and associative across partitions. *(tests: `token-report.test.ts` "keeps large token counts exact integers" + "is order-independent" + "is deterministic and associative across partitions")*
- The full ledger is a pure read: an empty project reports nothing-captured and the command never tails or mutates the log. *(test: `cost.test.ts` "reports nothing-captured for an empty project")*
- Share percents sum to exactly 100, and a real-but-tiny row renders as under one percent rather than a false zero. *(tests: `cost.test.ts` sharePercents "rounds to whole percents that sum to exactly 100"; renderCost "shows <1% for a real-but-tiny feature, never a false 0%")*
- The feed tailer is idempotent across restarts and follows every concurrent session, not just the newest, so concurrent windows are fully counted. *(tests: `claude-feed.test.ts` pumpFeed "emits once, resumes without double-emitting, and picks up appended lines" + "pumps every concurrent session, not just the newest")*
- Backfill ingests a never-watched session and is idempotent by turn id, adding nothing on a re-run; reset rebuilds feed-sourced events at the current normalization while preserving manual emits and review notes, and never drops feed events whose transcript is gone. *(tests: `claude-feed.test.ts` backfillFeed "ingests a never-watched session and is idempotent by uuid"; resetFeed "preserves manual emit and review events while rebuilding feed events" + "preserves feed events whose transcript is gone — never silently loses cost data")*
- A zero-usage transcript turn (e.g. a synthetic CLI notice) produces no token event, so it cannot inflate the event count or pollute the unpriced-model signal. *(test: `claude-feed.test.ts` recordToEvents "skips the token event for a zero-usage turn (e.g. a <synthetic> CLI notice)")*
- Claude transcript model ids are canonicalized to rate-table keys, whether the family carries a two-part version or a single one, while an unrecognized id is left untouched so the exact-match typo-safety is preserved. *(tests: `claude-feed.test.ts` normalizeModelId "canonicalizes Claude transcript ids to rate-table keys (and prices them)" + "canonicalizes single-segment families (Fable/Mythos) and prices them" + "canonicalizes single-segment Opus/Sonnet (Opus 5, Sonnet 5) and prices them" + "leaves unrecognized ids untouched (exact-match/typo-safety preserved)")*
- A context-variant suffix and a dated snapshot are both stripped before the version is read, so neither changes which model an id resolves to — and a date can never be mistaken for a version component. *(tests: `claude-feed.test.ts` normalizeModelId "strips a context-variant suffix like [1m] so the 1M model still prices" + "strips a dated suffix without the minor-version group swallowing it")*
- A built-in rate is a model's standard published rate, never a promotional or introductory one: a rate that lapses on a date nobody is tracking would silently turn the estimate into an under-report. *(test: `token-cost.test.ts` MODEL_RATES "has the known models with the documented per-bucket rates")*

## Decisions

- Local capture uses recorded provenance, not directory naming. Bare JSON streams require a local provenance header; competing usage representations are refused because their turn identities cannot be safely reconciled.
- Recorded parent, fork and referenced history are excluded from cumulative usage capture until a reliable new-work boundary exists. These are internal formats with separate lineage fields, confirmed against the [Codex recorder](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs); unknown boundaries remain partial evidence.

- Availability describes observable local inputs, not complete metering. Manual reports remain vendor-neutral, Claude capture remains best-effort, and unsupported hosts are explicit. Sharing requires an explicit summary export; raw transcripts stay local and imported summaries never become live usage. See [[agent-delivery-workflow]] for the approved cross-host work.
- Token counts are the source of truth and cost is derived at render time, never persisted (Codument is not a metering tool): [009-token-counts-are-truth-cost-derived-at-render](../architecture/decisions/009-token-counts-are-truth-cost-derived-at-render.md).

## Key files

- `src/lib/codex-feed.ts` — repository-scoped usage capture and replay diagnostics.

- `src/lib/agent-feed.ts` — host capture availability and limitations.
- `src/lib/token-cost.ts` — the pricing layer: derives an estimated cost from raw counts at render time, and resolves the agent-neutral rate table by merging user overrides over the built-in Claude defaults.
- `src/lib/token-report.ts` — the reducer: folds an untrusted event stream into attributed totals and rollups, and owns the canonical token-event guard the producers share.
- `src/lib/emit-producer.ts` — the vendor-neutral producer: appends a counts-only token event any agent can target.
- `src/lib/claude-feed.ts` — the Claude Code adapter: discovers and tails the agent's own session transcripts and normalizes per-turn usage into the event log, with backfill and reset maintenance modes.
- `src/commands/emit.ts` — the `emit` command surface for reporting token usage (and resolved review findings) from the command line.
- `src/commands/feed.ts` — the `feed` command surface: live tail, one-shot, backfill, and reset.
- `src/commands/cost.ts` — the full-ledger command: a pure render of the captured log into a per-feature, per-model, and per-step breakdown.
- `src/commands/watch.ts` — the live consumer that renders the cost headline and auto-runs the feed (related; owned by [[cli]] / watch).
