import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeChangeState,
  detectApprovedPlanScope,
} from "../src/lib/change-state.js";
import { readRegistry } from "../src/lib/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  here,
  "..",
  "fixtures",
  "benchmarks",
  "change-control",
  "project",
);

// The "messy AI change" the change-control fixture's changes/ overlay represents.
const CHANGED = [
  "src/auth/login.ts",
  "src/lib/db.ts",
  "src/lib/cache.ts",
  "src/lib/ratelimit.ts",
  "src/tasks/tasks.ts",
  "docs/features/tasks.md",
];
// Approved plan: docs/plans/add-rate-limiting.md
const PLAN_SCOPE = ["src/lib/ratelimit.ts", "src/auth/login.ts"];

async function state(extra: { planScope?: string[] } = {}) {
  const registry = await readRegistry(join(FIXTURE, "docs", ".registry.json"));
  return computeChangeState({ registry, changedFiles: CHANGED, ...extra });
}

describe("computeChangeState (change-control fixture diff)", () => {
  it("groups changed sources by owning feature", async () => {
    const s = await state();
    const byFeature = Object.fromEntries(s.byFeature.map((g) => [g.feature, g.files]));
    assert.deepStrictEqual(byFeature["auth"], ["src/auth/login.ts", "src/lib/db.ts"]);
    assert.ok(byFeature["db"].includes("src/lib/db.ts"));
    assert.ok(byFeature["tasks"].includes("src/tasks/tasks.ts"));
  });

  it("flags stale-auth and stale-db, but tasks is clean (positive control)", async () => {
    const s = await state();
    const stale = s.staleDocs.map((d) => d.feature).sort();
    assert.ok(stale.includes("auth"), "stale-auth");
    assert.ok(stale.includes("db"), "stale-db");
    assert.ok(!stale.includes("tasks"), "tasks changed with its doc → not stale");
  });

  it("flags unmapped changes (cache + ratelimit have no owner)", async () => {
    const s = await state();
    assert.deepStrictEqual(s.unmapped, [
      "src/lib/cache.ts",
      "src/lib/ratelimit.ts",
    ]);
  });

  it("buckets config/asset changes into otherChanged, but drops excluded paths", async () => {
    const registry = await readRegistry(join(FIXTURE, "docs", ".registry.json"));
    const s = computeChangeState({
      registry,
      changedFiles: [
        "src/lib/db.ts", // source
        "docs/features/tasks.md", // doc
        "app.json", // other (config)
        "assets/logo.png", // other (asset)
        "dist/bundle.js", // excluded build output → dropped everywhere
      ],
    });
    assert.deepStrictEqual(s.otherChanged, ["app.json", "assets/logo.png"]);
    // Excluded build output is not source, not docs, and not "other" — consistent
    // with how unmapped/coverage treat it (so it can't inflate the verdict count).
    assert.ok(!s.otherChanged.includes("dist/bundle.js"), "excluded path not in otherChanged");
    assert.ok(!s.changedSources.includes("app.json"), "app.json is not source");
    // The four non-excluded inputs partition cleanly into source/docs/other.
    assert.equal(s.changedSources.length + s.changedDocs.length + s.otherChanged.length, 4);
  });

  it("flags the high-risk touch (auth) and the high-fanout file (db)", async () => {
    const s = await state();
    const riskFeatures = s.riskTouches.map((r) => r.feature).sort();
    assert.ok(riskFeatures.includes("auth"));
    assert.ok(riskFeatures.includes("db"));

    const fanout = s.highFanout.find((f) => f.file === "src/lib/db.ts");
    assert.ok(fanout);
    assert.deepStrictEqual(fanout?.features, ["auth", "db", "tasks"]);
  });

  it("flags dependents of the changed db feature (auth, tasks)", async () => {
    const s = await state();
    const deps = s.dependents
      .filter((d) => d.dependsOn === "db")
      .map((d) => d.feature)
      .sort();
    assert.deepStrictEqual(deps, ["auth", "tasks"]);
  });

  it("flags out-of-plan changes when a plan scope is provided", async () => {
    const s = await state({ planScope: PLAN_SCOPE });
    assert.equal(s.planScoped, true);
    // db.ts, cache.ts, tasks.ts are outside the rate-limiting plan scope
    assert.deepStrictEqual(s.outOfPlan, [
      "src/lib/cache.ts",
      "src/lib/db.ts",
      "src/tasks/tasks.ts",
    ]);
  });

  it("is deterministic", async () => {
    assert.deepStrictEqual(await state({ planScope: PLAN_SCOPE }), await state({ planScope: PLAN_SCOPE }));
  });
});

describe("detectApprovedPlanScope (fixture plan)", () => {
  it("reads scope only from list items, not explanatory prose", () => {
    const plan = detectApprovedPlanScope(FIXTURE);
    assert.ok(plan, "approved plan detected");
    assert.equal(plan?.plan, "docs/plans/add-rate-limiting.md");
    // The Scope prose mentions db.ts/cache.ts/tasks.ts as OUT-of-plan examples;
    // they must not leak into the detected scope.
    assert.deepStrictEqual(plan?.scope, [
      "src/auth/login.ts",
      "src/lib/ratelimit.ts",
    ]);
  });

  it("end-to-end: db.ts is out-of-plan when scope is detected (not injected)", async () => {
    const plan = detectApprovedPlanScope(FIXTURE);
    const s = await state({ planScope: plan?.scope });
    assert.ok(s.outOfPlan.includes("src/lib/db.ts"), "db.ts is out-of-plan");
    assert.ok(s.outOfPlan.includes("src/lib/cache.ts"));
    assert.ok(s.outOfPlan.includes("src/tasks/tasks.ts"));
  });
});
