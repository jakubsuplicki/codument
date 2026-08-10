import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, readRecentEvents } from "../src/lib/events.js";
import {
  renderFrame as renderFrameRaw,
  sessionStats,
  animDelayFor,
  ANIM_FAST_MS,
  ANIM_IDLE_MS,
  clockLabel,
} from "../src/commands/watch.js";
import { MODEL_RATES, mergeRates } from "../src/lib/token-cost.js";
import type { CodumentEvent } from "../src/lib/events.js";

// These tests assert on the frame's textual content, not its color. The color
// environment is not stable across machines (GitHub Actions sets FORCE_COLOR,
// which makes picocolors emit ANSI), so strip ANSI and route every renderFrame
// call through the wrapper — the assertions stay deterministic regardless of env.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const renderFrame = (...args: Parameters<typeof renderFrameRaw>): string =>
  stripAnsi(renderFrameRaw(...args));

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-watch-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("sessionStats — calendar span, not summed session time", () => {
  const tok = (session: string, ts: string): CodumentEvent =>
    ({
      type: "tokens",
      ts,
      data: { session, model: "opus-4.8", input: 1, output: 0, cacheRead: 0, cacheCreate: 0 },
    }) as CodumentEvent;

  it("reports wall-clock elapsed across sessions, never the sum of overlapping spans", () => {
    // A spans 00:00–02:00 (2h), B spans 01:00–04:00 (3h); they overlap.
    const events = [
      tok("A", "2026-06-01T00:00:00.000Z"),
      tok("A", "2026-06-01T02:00:00.000Z"),
      tok("B", "2026-06-01T01:00:00.000Z"),
      tok("B", "2026-06-01T04:00:00.000Z"),
    ];
    const { sessions, hours } = sessionStats(events);
    assert.equal(sessions, 2);
    // calendar span 00:00 → 04:00 = 4h. Summed per-session would be 2h + 3h = 5h.
    assert.equal(hours, 4);
  });

  it("skips events with no session id or an unparseable timestamp", () => {
    const events = [
      tok("A", "2026-06-01T00:00:00.000Z"),
      tok("A", "not-a-date"),
      {
        type: "tokens",
        ts: "2026-06-01T09:00:00.000Z",
        data: { model: "opus-4.8" },
      } as CodumentEvent,
    ];
    const { sessions, hours } = sessionStats(events);
    assert.equal(sessions, 1); // only "A"; the session-less event is ignored
    assert.equal(hours, 0); // A has a single valid timestamp → no span
  });
});

describe("clockLabel — header wall-clock", () => {
  it("renders zero-padded HH:MM with no seconds", () => {
    const label = clockLabel(new Date(2026, 5, 21, 9, 5, 43));
    assert.equal(label, "09:05");
    assert.doesNotMatch(label, /:\d\d:/); // no seconds component
  });
});

describe("animDelayFor — mood-adaptive animation cadence", () => {
  it("ticks fast only while working, slow otherwise", () => {
    assert.equal(animDelayFor("working"), ANIM_FAST_MS);
    assert.equal(animDelayFor("idle"), ANIM_IDLE_MS);
    assert.equal(animDelayFor("clean"), ANIM_IDLE_MS);
    assert.equal(animDelayFor("alert"), ANIM_IDLE_MS);
  });

  it("keeps the working cadence genuinely faster than idle (so the loop barely wakes when quiet)", () => {
    assert.ok(ANIM_FAST_MS < ANIM_IDLE_MS);
  });
});

describe("events log", () => {
  it("appends and reads back recent events oldest→newest", () => {
    appendEvent(tmp, { type: "review", message: "first", ts: "2026-06-16T10:00:00.000Z" });
    appendEvent(tmp, { type: "step", message: "second", ts: "2026-06-16T10:01:00.000Z" });
    const events = readRecentEvents(tmp, 10);
    assert.equal(events.length, 2);
    assert.equal(events[0].message, "first");
    assert.equal(events[1].type, "step");
  });

  it("caps to the most recent N", () => {
    for (let i = 0; i < 30; i++) {
      appendEvent(tmp, { type: "note", message: `n${i}`, ts: "2026-06-16T10:00:00.000Z" });
    }
    const events = readRecentEvents(tmp, 5);
    assert.equal(events.length, 5);
    assert.equal(events[4].message, "n29");
  });

  it("returns empty when no log exists", () => {
    assert.deepStrictEqual(readRecentEvents(tmp), []);
  });
});

describe("renderFrame", () => {
  it("renders coverage and a not-a-git-repo notice", () => {
    const review = {
      version: 1 as const,
      isGitRepo: false,
      changedFileCount: 0,
      plan: null,
      state: {} as never,
    };
    const coverage = { coverage: { percent: 80 } } as never;
    const frame = renderFrame(review, coverage, [], "2026-06-16 10:00:00");
    assert.match(frame, /codument watch/);
    assert.match(frame, /docs coverage: 80%/);
    assert.match(frame, /not a git repo/);
  });
});

describe("renderFrame token block", () => {
  type Review = Parameters<typeof renderFrame>[0];
  const gitReview = (): Review =>
    ({
      version: 1,
      isGitRepo: true,
      changedFileCount: 0,
      plan: null,
      state: {
        changedSources: [],
        changedDocs: [],
        byFeature: [],
        staleDocs: [],
        riskTouches: [],
        unmapped: [],
        otherChanged: [],
        excludedChanged: [],
        outOfPlan: [],
        highFanout: [],
        dependents: [],
        dependentsSummary: [],
        planScoped: false,
        registryPointers: [],
        docPointers: [],
      },
    }) as unknown as Review;
  const coverage = { coverage: { percent: 80 } } as never;
  const tok = (data: Record<string, unknown>, ts = "2026-06-16T10:00:00.000Z") => ({
    type: "tokens",
    ts,
    data,
  });
  const ev = (type: string, message: string) => ({ type, ts: "2026-06-16T10:00:00.000Z", message });
  const NOW = "2026-06-16 10:00:00";

  it("hides the block when there are no token events", () => {
    const frame = renderFrame(gitReview(), coverage, [], NOW);
    assert.doesNotMatch(frame, /tokens/i);
    assert.doesNotMatch(frame, /estimated/i);
    assert.doesNotMatch(frame, /\$\d/);
    assert.match(frame, /docs coverage: 80%/);
    assert.match(frame, /Ctrl-C to stop/);
  });

  it("hides the block when events exist but none are token events", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [ev("review", "diff clean"), ev("step", "step 1 done")],
      NOW,
    );
    assert.doesNotMatch(frame, /estimated/i);
    assert.doesNotMatch(frame, /\$\d/);
    // non-token events show in the activity tape (no dedicated "recent events" header now)
    assert.match(frame, /step 1 done/);
  });

  it("renders a labelled, grouped total and cost for one event", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        tok({
          model: "opus-4.8",
          input: 12000,
          output: 3000,
          cacheRead: 480000,
          cacheCreate: 20000,
          feature: "auth",
        }),
      ],
      NOW,
    );
    assert.match(frame, /\bcost\b/i);
    assert.match(frame, /est\./i);
    assert.match(frame, /\$0\.50/);
    // cost-first, with "new" (input+output+cacheCreate) split from cache-read
    assert.match(frame, /35\.0K new/);
    assert.match(frame, /480\.0K cache-read/);
    assert.doesNotMatch(frame, /\$0\.5\b/);
  });

  it("aggregates and lists features highest-cost-first", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 1000000,
          cacheCreate: 0,
          feature: "auth",
        }),
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 600000,
          cacheCreate: 0,
          feature: "auth",
        }),
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 400000,
          cacheCreate: 0,
          feature: "billing",
        }),
      ],
      NOW,
    );
    assert.match(frame, /2\.0M cache-read/);
    assert.match(frame, /\$1\.00/);
    assert.match(frame, /auth/);
    assert.match(frame, /billing/);
    assert.ok(frame.indexOf("auth") < frame.indexOf("billing"));
    assert.match(frame, /\$0\.80/);
    assert.match(frame, /\$0\.20/);
  });

  it("caps the feature list at the top 3 by cost but counts all in the total", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 1000000,
          cacheCreate: 0,
          feature: "f-big",
        }),
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 600000,
          cacheCreate: 0,
          feature: "f-mid",
        }),
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 200000,
          cacheCreate: 0,
          feature: "f-small",
        }),
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 20000,
          cacheCreate: 0,
          feature: "f-tiny",
        }),
      ],
      NOW,
    );
    assert.ok(frame.indexOf("f-big") < frame.indexOf("f-mid"));
    assert.ok(frame.indexOf("f-mid") < frame.indexOf("f-small"));
    assert.doesNotMatch(frame, /f-tiny/);
    assert.match(frame, /\$0\.91/);
    assert.match(frame, /1\.8M cache-read/);
  });

  it("leads cost with the all-sessions total and its session provenance", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 1000000,
          cacheCreate: 0,
          feature: "a",
          session: "s1",
        }),
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 1000000,
          cacheCreate: 0,
          feature: "b",
          session: "s2",
        }),
        tok({
          model: "opus-4.8",
          input: 0,
          output: 0,
          cacheRead: 1000000,
          cacheCreate: 0,
          feature: "c",
          session: "s3",
        }),
      ],
      NOW,
    );
    assert.match(frame, /\$1\.50/); // all three sessions summed (3 × 1M cache-read × $0.5/M)
    assert.match(frame, /3 sessions/);
  });

  it("shows a 'this session' delta for cost accrued since the watch started", () => {
    const before = tok(
      {
        model: "opus-4.8",
        input: 0,
        output: 0,
        cacheRead: 1000000,
        cacheCreate: 0,
        feature: "a",
        session: "s1",
      },
      "2026-06-16T09:00:00.000Z",
    );
    const after = tok(
      {
        model: "opus-4.8",
        input: 0,
        output: 0,
        cacheRead: 1000000,
        cacheCreate: 0,
        feature: "a",
        session: "s1",
      },
      "2026-06-16T11:00:00.000Z",
    );
    const frame = renderFrame(gitReview(), coverage, [before, after], NOW, {
      sinceTs: "2026-06-16T10:00:00.000Z",
    });
    assert.match(frame, /\$1\.00/); // total across both
    assert.match(frame, /\+\$0\.50 this session/); // only the turn after the watch started
  });

  it("omits the 'this session' delta when nothing accrued since the watch started", () => {
    const old = tok(
      {
        model: "opus-4.8",
        input: 0,
        output: 0,
        cacheRead: 1000000,
        cacheCreate: 0,
        feature: "a",
        session: "s1",
      },
      "2026-06-16T09:00:00.000Z",
    );
    const frame = renderFrame(gitReview(), coverage, [old], NOW, {
      sinceTs: "2026-06-16T10:00:00.000Z",
    });
    assert.doesNotMatch(frame, /this session/);
  });

  it("counts unpriced-model tokens in the total but flags them and charges $0", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        tok({
          model: "opus-4.8",
          input: 12000,
          output: 3000,
          cacheRead: 480000,
          cacheCreate: 20000,
          feature: "auth",
        }),
        tok({
          model: "gpt-9-ultra",
          input: 50000,
          output: 10000,
          cacheRead: 0,
          cacheCreate: 0,
          feature: "auth",
        }),
      ],
      NOW,
    );
    // unpriced tokens still counted in "new"; only the priced model contributes cost
    assert.match(frame, /95\.0K new/);
    assert.match(frame, /480\.0K cache-read/);
    assert.match(frame, /\$0\.50/);
    assert.match(frame, /unpriced/i);
  });

  it("keeps the block below the not-a-git-repo early return", () => {
    const review = {
      version: 1 as const,
      isGitRepo: false,
      changedFileCount: 0,
      plan: null,
      state: {} as never,
    } as unknown as Review;
    const frame = renderFrame(
      review,
      coverage,
      [
        tok({
          model: "opus-4.8",
          input: 12000,
          output: 3000,
          cacheRead: 480000,
          cacheCreate: 20000,
          feature: "auth",
        }),
      ],
      NOW,
    );
    assert.match(frame, /docs coverage: 80%/);
    assert.match(frame, /not a git repo/);
    assert.doesNotMatch(frame, /estimated/i);
    assert.doesNotMatch(frame, /\$\d/);
    assert.doesNotMatch(frame, /515,000/);
  });

  it("frames cost as an estimate, never as authoritative spend", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        tok({
          model: "sonnet-4.6",
          input: 10000,
          output: 2000,
          cacheRead: 500000,
          cacheCreate: 16000,
          feature: "docs",
        }),
      ],
      NOW,
    );
    assert.match(frame, /est(\.|imated)/i);
    assert.match(frame, /\$0\.27/);
    assert.doesNotMatch(frame, /actual cost|billed|invoice/i);
  });

  it("is a pure function of its inputs", () => {
    const events = [
      tok({
        model: "opus-4.8",
        input: 12000,
        output: 3000,
        cacheRead: 480000,
        cacheCreate: 20000,
        feature: "auth",
      }),
    ];
    const a = renderFrame(gitReview(), coverage, events, NOW);
    const b = renderFrame(gitReview(), coverage, events, NOW);
    assert.equal(a, b);
    assert.match(a, /2026-06-16 10:00:00/);
  });

  it("never throws or prints NaN on malformed / out-of-order token events", () => {
    let frame!: string;
    assert.doesNotThrow(() => {
      frame = renderFrame(
        gitReview(),
        coverage,
        [
          tok(
            {
              model: "opus-4.8",
              input: 12000,
              output: 3000,
              cacheRead: 480000,
              cacheCreate: 20000,
              feature: "auth",
            },
            "2026-06-16T10:05:00.000Z",
          ),
          tok(
            { model: "opus-4.8", input: "oops", output: null, cacheRead: undefined },
            "2026-06-16T10:01:00.000Z",
          ),
          { type: "tokens", ts: "2026-06-16T10:02:00.000Z" } as never,
          tok({ input: 5, output: 5 }, "2026-06-16T10:03:00.000Z"),
        ],
        NOW,
      );
    });
    assert.doesNotMatch(frame, /NaN/);
    assert.match(frame, /\$0\.50/);
    assert.match(frame, /\bcost\b/i);
    assert.match(frame, /480\.0K cache-read/);
  });

  it("prices a non-Claude model when a custom rate table is supplied", () => {
    const rates = mergeRates(MODEL_RATES, { "codex-1": { input: 2 } });
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        tok({
          model: "codex-1",
          input: 1_000_000,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          feature: "auth",
        }),
      ],
      NOW,
      { rates },
    );
    assert.match(frame, /\$2\.00/);
    assert.doesNotMatch(frame, /unpriced/i);
  });

  it("flags the same model as unpriced without the custom table (built-ins only)", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        tok({
          model: "codex-1",
          input: 1_000_000,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          feature: "auth",
        }),
      ],
      NOW,
    );
    assert.match(frame, /unpriced/i);
  });
});

describe("renderFrame caught section (impact ledger)", () => {
  type Review = Parameters<typeof renderFrame>[0];
  const gitReview = (): Review =>
    ({
      version: 1,
      isGitRepo: true,
      changedFileCount: 0,
      plan: null,
      state: {
        changedSources: [],
        changedDocs: [],
        byFeature: [],
        staleDocs: [],
        riskTouches: [],
        unmapped: [],
        otherChanged: [],
        excludedChanged: [],
        outOfPlan: [],
        highFanout: [],
        dependents: [],
        dependentsSummary: [],
        planScoped: false,
        registryPointers: [],
        docPointers: [],
      },
    }) as unknown as Review;
  const coverage = { coverage: { percent: 80 } } as never;
  const NOW = "2026-06-16 10:00:00";
  const caught = (data: Record<string, unknown>) =>
    ({
      type: "caught",
      ts: "2026-06-16T10:00:00.000Z",
      data: { commit: null, staleDocs: [], riskTouches: [], offPlan: [], ...data },
    }) as unknown as CodumentEvent;
  const review = (tier: string, resolution: string) =>
    ({
      type: "review",
      ts: "2026-06-16T10:00:00.000Z",
      data: { tier, resolution },
    }) as unknown as CodumentEvent;

  it("hides the section when there are no caught/review events", () => {
    const frame = renderFrame(gitReview(), coverage, [], NOW);
    assert.doesNotMatch(frame, /caught \(all sessions\)/);
  });

  it("leads with the provable line, counting distinct catches across snapshots", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        caught({ staleDocs: ["docs/a.md", "docs/b.md"], riskTouches: ["auth"] }),
        caught({ staleDocs: ["docs/a.md"], offPlan: ["src/x.ts"] }), // docs/a.md repeats → not double-counted
      ],
      NOW,
    );
    assert.match(frame, /caught \(all sessions\)/);
    assert.match(frame, /provable/);
    assert.match(frame, /2 stale docs flagged/);
    assert.match(frame, /1 high-risk touch\b/);
    assert.match(frame, /1 off-plan change\b/);
    assert.doesNotMatch(frame, /reported/); // no self-reported events
  });

  it("shows only the reported line (correctness fixed) labeled self-reported, minor out of headline", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        review("correctness", "fixed"),
        review("correctness", "fixed"),
        review("minor", "fixed"),
        review("minor", "deferred"),
      ],
      NOW,
    );
    assert.match(frame, /caught \(all sessions\)/);
    assert.match(frame, /reported/);
    assert.match(frame, /2 review issues fixed before commit/); // correctness only
    assert.match(frame, /agent self-reported/);
    assert.match(frame, /\+1 minor/);
    assert.doesNotMatch(frame, /provable/); // no caught snapshots
  });

  it("hides the section when caught snapshots found nothing (clean ship-moments)", () => {
    const frame = renderFrame(gitReview(), coverage, [caught({}), caught({})], NOW);
    assert.doesNotMatch(frame, /caught \(all sessions\)/);
  });

  it("the soak line splits the fire volume into contract vs body churn", () => {
    const frame = renderFrame(
      gitReview(),
      coverage,
      [
        caught({
          drift: {
            flagged: 3,
            sigMoved: 1,
            bodyMoved: 2,
            docUpdated: 1,
            fileAcked: 0,
            acknowledged: 1,
            coMoved: 0,
            proseUnchanged: 0,
            notReferenced: 0,
          },
        }),
      ],
      NOW,
    );
    assert.match(frame, /soak/);
    assert.match(frame, /3 symbol move\(s\)/);
    assert.match(frame, /1 contract · 2 body/);
  });
});

describe("codument watch --once (CLI, temp git repo)", () => {
  function gitInit(root: string): void {
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    run(["init"]);
    run(["config", "user.email", "t@e.com"]);
    run(["config", "user.name", "T"]);
    run(["add", "-A"]);
    run(["commit", "-m", "baseline"]);
  }

  it("renders one frame with coverage and a change summary", async () => {
    await mkdir(join(tmp, "src", "auth"), { recursive: true });
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await writeFile(
      join(tmp, "docs", ".registry.json"),
      JSON.stringify({
        features: {
          auth: {
            doc: "docs/features/auth.md",
            type: "feature",
            primary_sources: ["src/auth/login.ts"],
            related_sources: [],
            docs: [],
            depends_on: [],
            risk: ["auth"],
            last_updated: "2026-06-16",
            status: "current",
          },
        },
      }),
    );
    await writeFile(join(tmp, "docs", "features", "auth.md"), "# auth\n");
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 1;\n");
    gitInit(tmp);
    // make a change so the frame has something to show
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 2;\n");

    const out = execFileSync("node", [CLI, "watch", "--once"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.match(out, /codument watch/);
    assert.match(out, /docs coverage/);
    // the changed risk-tagged auth source (doc not updated) → an AT RISK verdict
    assert.match(out, /AT RISK/i);
  });

  it("watches a repo given by --dir from a different cwd (no cd needed)", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "docs"), { recursive: true });
    await writeFile(join(tmp, "docs", ".registry.json"), JSON.stringify({ features: {} }));
    await writeFile(join(tmp, "src", "a.ts"), "export const a = 1;\n");
    gitInit(tmp);

    // run from `here` (the tests dir), targeting tmp via --dir
    const out = execFileSync("node", [CLI, "watch", "--once", "--dir", tmp], {
      cwd: here,
      encoding: "utf-8",
    });
    assert.match(out, /codument watch/);
    assert.match(out, /docs coverage/);
  });

  it("errors loudly from a subdirectory of a repo — even under --once", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src", "a.ts"), "export const a = 1;\n");
    gitInit(tmp);

    // A subdir frame would be WRONG (everything unmapped), not just empty.
    let status = 0;
    let stdout = "";
    try {
      execFileSync("node", [CLI, "watch", "--once"], {
        cwd: join(tmp, "src"),
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    assert.equal(status, 1);
    assert.match(stdout, /subdirectory/);
    assert.match(stdout, /gate could not run/);
  });
});
