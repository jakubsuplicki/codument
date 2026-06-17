import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDeliveryPlan,
  activeStep,
  extractStatus,
  isApproved,
  todoStatus,
  loadPlan,
  findActivePlans,
  emitActiveStep,
  type ActivePlan,
} from "../src/lib/plan-steps.js";
import { readRecentEvents } from "../src/lib/events.js";
import { renderFrame } from "../src/commands/watch.js";

const PLAN = `---
status: approved
---

# Feed tail

## Delivery Plan
Status: **approved**

- [x] Step 1: Define the feed event schema
- [x] Step 2: Tail the session log with a persisted byte offset
- [ ] Step 3: Wire \`codument feed --once\` + live tail into watch
- [ ] Step 4: Tests for idempotency and carry-forward

## Open Questions
- [ ] should this be a checkbox the parser ignores? (outside the plan section)
`;

describe("parseDeliveryPlan", () => {
  it("extracts ordered steps with done flags from the Delivery Plan section", () => {
    const steps = parseDeliveryPlan(PLAN);
    assert.equal(steps.length, 4);
    assert.deepEqual(
      steps.map((s) => [s.n, s.done]),
      [
        [1, true],
        [2, true],
        [3, false],
        [4, false],
      ],
    );
    assert.match(steps[2].text, /^Step 3: Wire/);
  });

  it("ignores checkboxes outside the chosen section", () => {
    const steps = parseDeliveryPlan(PLAN);
    assert.ok(!steps.some((s) => /should this be a checkbox/.test(s.text)));
  });

  it("falls back to Definition of Done when there is no Delivery Plan", () => {
    const md = "## Definition of Done\n- [x] a\n- [ ] b\n";
    const steps = parseDeliveryPlan(md);
    assert.deepEqual(steps.map((s) => s.text), ["a", "b"]);
  });

  it("prefers Delivery Plan over Definition of Done when both exist", () => {
    const md =
      "## Definition of Done\n- [ ] dod-only\n\n## Delivery Plan\n- [ ] real-step\n";
    const steps = parseDeliveryPlan(md);
    assert.deepEqual(steps.map((s) => s.text), ["real-step"]);
  });

  it("accepts `*` bullets and capital [X]", () => {
    const md = "## Delivery Plan\n* [X] done one\n* [ ] open two\n";
    const steps = parseDeliveryPlan(md);
    assert.deepEqual(
      steps.map((s) => [s.text, s.done]),
      [
        ["done one", true],
        ["open two", false],
      ],
    );
  });

  it("returns [] when there is no checklist section", () => {
    assert.deepEqual(parseDeliveryPlan("# nothing here\njust prose\n"), []);
  });
});

describe("activeStep / todoStatus", () => {
  it("returns the first unchecked step", () => {
    const steps = parseDeliveryPlan(PLAN);
    assert.equal(activeStep(steps)?.n, 3);
  });

  it("returns null when every step is done", () => {
    assert.equal(activeStep(parseDeliveryPlan("## Delivery Plan\n- [x] a\n")), null);
  });

  it("maps done/active/pending to native to-do statuses", () => {
    const steps = parseDeliveryPlan(PLAN);
    const plan = { active: activeStep(steps) } as ActivePlan;
    assert.equal(todoStatus(plan, steps[0]), "completed"); // step 1, done
    assert.equal(todoStatus(plan, steps[2]), "in_progress"); // step 3, active
    assert.equal(todoStatus(plan, steps[3]), "pending"); // step 4
  });
});

describe("extractStatus / isApproved", () => {
  it("reads a bold body Status line", () => {
    assert.equal(extractStatus("Status: **approved**\n"), "approved");
  });
  it("reads frontmatter status", () => {
    assert.equal(extractStatus("---\nstatus: draft\n---\n"), "draft");
  });
  it("treats `approved` as approved but `awaiting approval` as not", () => {
    assert.equal(isApproved("approved"), true);
    assert.equal(isApproved("awaiting approval"), false);
    assert.equal(isApproved(null), false);
  });
});

describe("findActivePlans / loadPlan (fs discovery)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-plan-"));
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await mkdir(join(tmp, "docs", "concepts"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("finds the single approved plan that still has an unchecked step", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    // a draft plan and a fully-complete plan are both excluded
    await writeFile(
      join(tmp, "docs", "features", "draft.md"),
      "## Delivery Plan\nStatus: draft\n- [ ] not approved yet\n",
    );
    await writeFile(
      join(tmp, "docs", "features", "done.md"),
      "## Delivery Plan\nStatus: approved\n- [x] all complete\n",
    );
    const plans = findActivePlans(tmp);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].path, "docs/features/feed.md");
    assert.equal(plans[0].planName, "feed");
    assert.equal(plans[0].active?.n, 3);
  });

  it("returns all approved-with-active plans when there is more than one", async () => {
    await writeFile(join(tmp, "docs", "features", "a.md"), PLAN);
    await writeFile(join(tmp, "docs", "concepts", "b.md"), PLAN);
    const plans = findActivePlans(tmp);
    assert.deepEqual(plans.map((p) => p.path), [
      "docs/concepts/b.md",
      "docs/features/a.md",
    ]);
  });

  it("loadPlan reads a specific doc by repo-relative path", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    const plan = loadPlan(tmp, "docs/features/feed.md");
    assert.equal(plan?.steps.length, 4);
    assert.equal(plan?.approved, true);
  });

  it("loadPlan returns null for a missing doc", () => {
    assert.equal(loadPlan(tmp, "docs/features/nope.md"), null);
  });
});

describe("emitActiveStep (idempotent step events)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-step-"));
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const planAt = (rel: string): ActivePlan => loadPlan(tmp, rel)!;

  it("appends a step event for the active step, then is a no-op on repeat", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    const plan = planAt("docs/features/feed.md");

    const first = emitActiveStep(tmp, plan);
    assert.equal(first.emitted, true);
    assert.equal(first.step?.n, 3);

    const second = emitActiveStep(tmp, plan); // same active step
    assert.equal(second.emitted, false);

    const events = readRecentEvents(tmp, 20).filter((e) => e.type === "step");
    assert.equal(events.length, 1);
    assert.match(events[0].message ?? "", /▶ Step 3:/);
    assert.equal((events[0].data as Record<string, unknown>).plan, "docs/features/feed.md");
    assert.equal((events[0].data as Record<string, unknown>).n, 3);
    assert.equal((events[0].data as Record<string, unknown>).total, 4);
  });

  it("emits the next step once the plan advances", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    emitActiveStep(tmp, planAt("docs/features/feed.md")); // logs step 3

    // mark step 3 done → step 4 becomes active
    await writeFile(
      join(tmp, "docs", "features", "feed.md"),
      PLAN.replace("- [ ] Step 3:", "- [x] Step 3:"),
    );
    const advanced = emitActiveStep(tmp, planAt("docs/features/feed.md"));
    assert.equal(advanced.emitted, true);
    assert.equal(advanced.step?.n, 4);

    const steps = readRecentEvents(tmp, 20).filter((e) => e.type === "step");
    assert.deepEqual(
      steps.map((e) => (e.data as Record<string, unknown>).n),
      [3, 4],
    );
  });

  it("does nothing when the plan has no active step", async () => {
    await writeFile(
      join(tmp, "docs", "features", "done.md"),
      "## Delivery Plan\nStatus: approved\n- [x] all done\n",
    );
    const res = emitActiveStep(tmp, planAt("docs/features/done.md"));
    assert.equal(res.emitted, false);
    assert.equal(readRecentEvents(tmp, 20).filter((e) => e.type === "step").length, 0);
  });
});

describe("watch tape integration", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-stepwatch-"));
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // The mechanism that makes the plan checklist visible in `codument watch`:
  // emitActiveStep writes a `step` event, and renderFrame surfaces it in the tape.
  it("the emitted step event renders in the watch activity tape", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    emitActiveStep(tmp, loadPlan(tmp, "docs/features/feed.md")!);

    const gitReview = {
      version: 1,
      isGitRepo: true,
      changedFileCount: 0,
      plan: null,
      state: {
        changedSources: [],
        changedDocs: [],
        staleDocs: [],
        riskTouches: [],
        unmapped: [],
        outOfPlan: [],
        highFanout: [],
        dependents: [],
      },
    } as unknown as Parameters<typeof renderFrame>[0];
    const coverage = { coverage: { percent: 94 } } as never;

    const frame = renderFrame(
      gitReview,
      coverage,
      readRecentEvents(tmp, 50),
      "2026-06-17 10:00:00",
    );
    assert.match(frame, /step/); // the tape's kind column
    assert.match(frame, /▶ Step 3: Wire/); // the step label
  });
});
