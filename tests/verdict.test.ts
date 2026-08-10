import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVerdict,
  costProvenance,
  formatCost,
  isTestFile,
  SEVERITY_RANK,
  type CostModel,
} from "../src/lib/verdict.js";
import type { ChangeState } from "../src/lib/change-state.js";

/** A clean ChangeState; tests override only the fields under test. */
function mkState(p: Partial<ChangeState> = {}): ChangeState {
  return {
    changedSources: [],
    changedDocs: [],
    byFeature: [],
    unmapped: [],
    otherChanged: [],
    excludedChanged: [],
    staleDocs: [],
    docsChangedWithoutSource: [],
    highFanout: [],
    riskTouches: [],
    dependents: [],
    dependentsSummary: [],
    outOfPlan: [],
    planScoped: false,
    ownershipLints: [],
    unevaluable: [],
    deletedSources: [],
    ungatedRegistered: [],
    registryPointers: [],
    docPointers: [],
    governedRegistered: [],
    governedDeleted: [],
    ...p,
  };
}

const OPTS = { totalFeatures: 64 };

describe("classifyVerdict — severity", () => {
  it("clean when nothing changed", () => {
    const v = classifyVerdict(mkState(), OPTS);
    assert.equal(v.status, "clean");
    assert.equal(v.gloss, "working tree clean");
    assert.deepEqual(v.blast, { touched: 0, total: 64, touchedFiles: 0, totalFiles: 0 });
  });

  it("clean with safe changes, noting in-plan only when plan-scoped", () => {
    const base = mkState({
      byFeature: [
        { feature: "recipe-list", files: ["src/a.ts"] },
        { feature: "recipe-edit", files: ["src/b.ts"] },
      ],
    });
    assert.equal(classifyVerdict(base, OPTS).status, "clean");
    assert.equal(classifyVerdict(base, OPTS).gloss, "2 features touched · docs current");
    const scoped = classifyVerdict(mkState({ ...base, planScoped: true }), OPTS);
    assert.equal(scoped.gloss, "2 features touched · docs current · in plan");
    assert.deepEqual(classifyVerdict(base, OPTS).blast, {
      touched: 2,
      total: 64,
      touchedFiles: 0,
      totalFiles: 0,
    });
  });

  it("computes file-grain blast from changed sources and the in-scope count", () => {
    const state = mkState({
      changedSources: ["src/a.ts", "src/b.ts"],
      byFeature: [{ feature: "app", files: ["src/a.ts", "src/b.ts"] }],
    });
    const v = classifyVerdict(state, { totalFeatures: 1, inScopeSourceCount: 10 });
    // At one feature the feature ratio is "1 of 1"; file-grain resolves it to 2 of 10.
    assert.deepEqual(v.blast, { touched: 1, total: 1, touchedFiles: 2, totalFiles: 10 });
  });

  it("a doc-only change is clean but not 'working tree clean'", () => {
    const v = classifyVerdict(mkState({ changedDocs: ["docs/features/a.md"] }), OPTS);
    assert.equal(v.status, "clean");
    assert.equal(v.gloss, "1 doc updated · no source changes");
  });

  it("config/asset changes never read as 'working tree clean' (the false-clean)", () => {
    // app.json + an asset: neither source nor docs, so nothing codument governs
    // changed — but the tree is NOT empty, and the gloss must say so.
    const v = classifyVerdict(mkState({ otherChanged: ["app.json", "assets/icon.png"] }), OPTS);
    assert.equal(v.status, "clean");
    assert.equal(v.gloss, "2 files changed · not source or docs");
    assert.notEqual(v.gloss, "working tree clean");
  });

  it("notes other files alongside a clean source touch", () => {
    const v = classifyVerdict(
      mkState({
        byFeature: [{ feature: "recipe-list", files: ["src/a.ts"] }],
        otherChanged: ["app.json"],
      }),
      OPTS,
    );
    assert.equal(v.status, "clean");
    assert.equal(v.gloss, "1 feature touched · docs current · +1 other file");
  });

  it("drifting when a feature's source changed but its doc did not", () => {
    const v = classifyVerdict(
      mkState({
        byFeature: [{ feature: "recipe-list", files: ["src/a.ts"] }],
        staleDocs: [
          {
            feature: "recipe-list",
            doc: "docs/features/recipe-list.md",
            changedSources: ["src/a.ts"],
          },
          {
            feature: "recipe-extraction",
            doc: "docs/features/recipe-extraction.md",
            changedSources: ["src/b.ts"],
          },
        ],
      }),
      OPTS,
    );
    assert.equal(v.status, "drifting");
    assert.equal(v.gloss, "2 docs now behind code");
    assert.equal(v.drift.length, 2);
    assert.equal(v.drift[0].doc, "docs/features/recipe-list.md");
  });

  it("at-risk when a risk-tagged feature is touched; 'no test' only when no test changed", () => {
    const state = mkState({
      byFeature: [{ feature: "paywall", files: ["src/pay.ts"] }],
      riskTouches: [{ feature: "paywall", risk: ["payments"], files: ["src/pay.ts"] }],
    });
    const noTest = classifyVerdict(state, { ...OPTS, testsTouched: false });
    assert.equal(noTest.status, "at-risk");
    assert.equal(noTest.gloss, "payments touched with no test");
    assert.equal(noTest.risk[0].noTest, true);

    // A tested risk touch still fires — just without the aggravator.
    const tested = classifyVerdict(state, { ...OPTS, testsTouched: true });
    assert.equal(tested.status, "at-risk");
    assert.equal(tested.gloss, "payments touched");
    assert.equal(tested.risk[0].noTest, false);
  });

  it("escalates a shared file to risk only above the fanout threshold (>5)", () => {
    const at5 = classifyVerdict(
      mkState({ highFanout: [{ file: "src/util.ts", features: ["a", "b", "c", "d", "e"] }] }),
      OPTS,
    );
    assert.equal(at5.status, "clean", "exactly 5 owners is not yet a risk");

    const at6 = classifyVerdict(
      mkState({ highFanout: [{ file: "src/util.ts", features: ["a", "b", "c", "d", "e", "f"] }] }),
      OPTS,
    );
    assert.equal(at6.status, "at-risk");
    assert.equal(at6.risk[0].kind, "shared-infra");
    assert.equal(at6.gloss, "shared code touched (6 features)");
  });

  it("degrades a risk finding with no tags to a generic subject", () => {
    const v = classifyVerdict(
      mkState({ riskTouches: [{ feature: "x", risk: [], files: ["f.ts"] }] }),
      { ...OPTS, testsTouched: true },
    );
    assert.equal(v.status, "at-risk");
    assert.equal(v.gloss, "risk code touched");
  });

  it("summarizes multiple shared-infra findings by the worst fanout", () => {
    const v = classifyVerdict(
      mkState({
        highFanout: [
          { file: "src/util.ts", features: ["a", "b", "c", "d", "e", "f"] },
          { file: "src/core.ts", features: ["a", "b", "c", "d", "e", "f", "g", "h"] },
        ],
      }),
      OPTS,
    );
    assert.equal(v.status, "at-risk");
    assert.equal(v.risk.length, 2);
    assert.equal(v.gloss, "shared code touched (8 features)");
  });

  it("combines risk-tag and shared-infra in the risk gloss", () => {
    const v = classifyVerdict(
      mkState({
        riskTouches: [{ feature: "paywall", risk: ["payments"], files: ["src/p.ts"] }],
        highFanout: [{ file: "src/util.ts", features: ["a", "b", "c", "d", "e", "f"] }],
      }),
      OPTS,
    );
    assert.equal(v.status, "at-risk");
    assert.equal(v.gloss, "payments touched with no test · shared code touched (6 features)");
  });

  it("off-plan when changed sources fall outside an approved plan scope", () => {
    const v = classifyVerdict(
      mkState({ planScoped: true, outOfPlan: ["src/util/currency.ts", "src/lib/proration.ts"] }),
      OPTS,
    );
    assert.equal(v.status, "off-plan");
    assert.equal(v.gloss, "2 files off-plan");
    assert.equal(v.offPlan?.files.length, 2);
  });

  it("ignores out-of-plan files when no plan scope is active", () => {
    // planScoped false → outOfPlan is meaningless, never an off-plan verdict.
    const v = classifyVerdict(mkState({ planScoped: false, outOfPlan: ["src/x.ts"] }), OPTS);
    assert.equal(v.status, "clean");
    assert.equal(v.offPlan, null);
  });
});

describe("classifyVerdict — headline is the highest severity, gloss enumerates all", () => {
  it("risk wins the headline and leads the gloss; drift and off-plan still enumerated", () => {
    const v = classifyVerdict(
      mkState({
        planScoped: true,
        outOfPlan: ["src/util/currency.ts", "src/lib/proration.ts"],
        staleDocs: [
          {
            feature: "recipe-list",
            doc: "docs/features/recipe-list.md",
            changedSources: ["src/a.ts"],
          },
          {
            feature: "recipe-extraction",
            doc: "docs/features/recipe-extraction.md",
            changedSources: ["src/b.ts"],
          },
        ],
        riskTouches: [
          {
            feature: "paywall",
            risk: ["payments"],
            files: ["src/p1.ts", "src/p2.ts", "src/p3.ts"],
          },
        ],
      }),
      OPTS,
    );
    assert.equal(v.status, "at-risk");
    assert.equal(
      v.gloss,
      "payments touched with no test · 2 files off-plan · 2 docs now behind code",
    );
  });

  it("off-plan outranks drifting when no risk is present", () => {
    const v = classifyVerdict(
      mkState({
        planScoped: true,
        outOfPlan: ["src/x.ts"],
        staleDocs: [{ feature: "f", doc: "docs/features/f.md", changedSources: ["src/y.ts"] }],
      }),
      OPTS,
    );
    assert.equal(v.status, "off-plan");
    assert.equal(v.gloss, "1 file off-plan · 1 doc now behind code");
  });

  it("ranks severities clean < drifting < off-plan < at-risk", () => {
    assert.ok(
      SEVERITY_RANK.clean < SEVERITY_RANK.drifting &&
        SEVERITY_RANK.drifting < SEVERITY_RANK["off-plan"] &&
        SEVERITY_RANK["off-plan"] < SEVERITY_RANK["at-risk"],
    );
  });

  it("surfaces unmapped count as context without changing a clean verdict", () => {
    const v = classifyVerdict(mkState({ unmapped: ["src/new1.ts", "src/new2.ts"] }), OPTS);
    assert.equal(v.status, "clean");
    assert.equal(v.unmapped, 2);
    // Honest: a clean verdict must not read "working tree clean" while
    // undocumented new files exist.
    assert.equal(v.gloss, "2 unmapped files");
  });

  // Plan 41 remediation: a dangling registry pointer became a third `--strict`
  // input and reached no other surface, so `watch` announced a tidy change over a
  // tree the gate refused — the one way the live view and a snapshot can
  // contradict each other. It rides every gloss for the same reason `unmapped`
  // does, and grades severity for the same reason it does not: the ladder is about
  // whether the DOCS are behind the code.
  const pointer = [{ file: "src/gone.ts", features: ["i18n"], kind: "deleted" as const }];

  it("a registry pointer is named in the gloss without moving the severity ladder", () => {
    const v = classifyVerdict(mkState({ registryPointers: pointer }), OPTS);
    assert.equal(v.status, "clean", "a false pointer is not the docs falling behind");
    assert.equal(v.registryPointers, 1);
    assert.equal(v.gloss, "1 stale registry pointer", "…but it is never unsaid");
  });

  it("it survives every clean branch, including the one with nothing else to report", () => {
    // The state it actually turns up in: a deletion whose owning doc WAS updated.
    // Nothing else is left to narrate, so this is exactly where a dropped finding
    // reads as an all-clear.
    const docOnly = classifyVerdict(
      mkState({ changedDocs: ["docs/features/i18n.md"], registryPointers: pointer }),
      OPTS,
    );
    assert.equal(docOnly.gloss, "1 doc updated · no source changes · 1 stale registry pointer");

    const other = classifyVerdict(
      mkState({ otherChanged: ["app.json"], registryPointers: pointer }),
      OPTS,
    );
    assert.match(other.gloss, /1 stale registry pointer$/);

    // And on a non-clean verdict it is enumerated beside the findings that did
    // move the ladder, rather than being crowded out by them.
    const drifting = classifyVerdict(
      mkState({
        staleDocs: [{ feature: "f", doc: "docs/features/f.md", changedSources: ["src/y.ts"] }],
        registryPointers: pointer,
      }),
      OPTS,
    );
    assert.equal(drifting.status, "drifting");
    assert.equal(drifting.gloss, "1 doc now behind code · 1 stale registry pointer");
  });
});

describe("costProvenance + formatCost", () => {
  const base: CostModel = {
    total: 1857.55,
    sessions: 4,
    hours: 164,
    thisSession: 42,
    byFeature: [],
    complete: true,
    capturedSessions: 4,
    knownSessions: 4,
  };

  it("scales the unit to the span: minutes, hours, or days", () => {
    assert.equal(costProvenance(base), "4 sessions  ·  7d"); // 164h reads better as days
    assert.equal(costProvenance({ ...base, hours: 30 }), "4 sessions  ·  30h");
    assert.equal(costProvenance({ ...base, hours: 0.5 }), "4 sessions  ·  30m");
    assert.equal(costProvenance({ ...base, sessions: 1, hours: null }), "1 session");
  });

  it("degrades to an explicit captured-of-total label when incomplete", () => {
    assert.equal(
      costProvenance({ ...base, complete: false, capturedSessions: 3, knownSessions: 4 }),
      "captured · 3 of 4 sessions",
    );
  });

  it("formats dollars with separators and cents, locale-free", () => {
    assert.equal(formatCost(1857.55), "$1,857.55");
    assert.equal(formatCost(599.97), "$599.97");
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(1234567.8), "$1,234,567.80");
    assert.equal(formatCost(42), "$42.00");
    assert.equal(formatCost(-42), "-$42.00");
    assert.equal(formatCost(-1234.5), "-$1,234.50");
    assert.equal(formatCost(-0.001), "$0.00"); // rounds to zero → no spurious minus
    assert.equal(formatCost(-0), "$0.00");
  });
});

describe("isTestFile", () => {
  it("matches conventional test paths and filenames", () => {
    for (const p of [
      "tests/foo.test.ts",
      "src/__tests__/a.ts",
      "spec/b.ts",
      "src/x.test.tsx",
      "pkg/y_test.go",
      "auth.spec.ts",
    ]) {
      assert.equal(isTestFile(p), true, p);
    }
  });
  it("does not match ordinary sources", () => {
    for (const p of [
      "src/auth/login.ts",
      "src/contest.ts",
      "src/latest.ts",
      "src/manifest.ts",
      "docs/features/a.md",
    ]) {
      assert.equal(isTestFile(p), false, p);
    }
  });
});

// Plan 44: the same false-clean this branch already guards against, one bucket
// further out. A step that edited only its tests has a working tree that is not
// clean, and saying so is the whole job of a live verdict line.
describe("a change of only excluded files is not a clean tree (plan 44)", () => {
  it("names it rather than claiming the tree is clean", () => {
    const v = classifyVerdict(mkState({ excludedChanged: ["tests/a.test.ts"] }), OPTS);
    assert.equal(v.status, "clean");
    assert.equal(v.gloss, "1 excluded file changed · nothing codument governs");
  });

  it("an empty tree still reads clean", () => {
    assert.equal(classifyVerdict(mkState(), OPTS).gloss, "working tree clean");
  });
});
