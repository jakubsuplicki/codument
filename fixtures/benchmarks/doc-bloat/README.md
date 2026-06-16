# doc-bloat fixture

A small, Peelmeal-shaped fixture used to **calibrate `codument doctor`'s bloat lint** thresholds. Peelmeal's real failure mode was docs that grew into hundreds or thousands of lines, oversized sections, and never-compacted completed-step logs. This fixture reproduces each of those signals in isolation so the conservative default thresholds can be verified deterministically.

## What each doc isolates

- `docs/features/huge.md` — **whole-doc size** only: 427 lines split into many short sections, so it trips the line threshold (default 400) without any single oversized section.
- `docs/features/bigsection.md` — **oversized section** only: ~187 lines total (under the whole-doc threshold) with one ~172-line section (over the 150 default).
- `docs/features/logheavy.md` — **completed-log accumulation** only: 25 inline `[x]` items (over the default 15), otherwise small.
- `docs/features/clean.md` — a compact, healthy doc that trips **nothing**.

Bloat is measured by these three independent signals, never a single line count, and is reported as a `bloated-doc` lint warning — never folded into the coverage score.

## Defaults calibrated here

| Signal | Default threshold |
| --- | --- |
| whole-doc lines | 400 |
| per-section lines | 150 |
| completed-log `[x]` items | 15 |

All three are CLI-overridable (`--max-doc-lines`, `--max-section-lines`, `--max-completed-log`) so projects can tune noise without editing code.
