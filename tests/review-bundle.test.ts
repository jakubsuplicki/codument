import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewBundle,
  extractDocSection,
  extractTestPointers,
} from "../src/lib/review-bundle.js";
import type { ChangeState } from "../src/lib/change-state.js";
import type { Registry, RegistryEntry } from "../src/lib/registry.js";

const DOC_A = `---
title: Feature A
---

# Feature A

## In plain terms

A does the thing. It guards X.

## Design approach

Some design prose, not a contract.

## Invariants & boundaries

- **X holds always.** Detail here. *(test: a-core.test.ts — proves X)*
- **Y is forbidden.** *(test: a-core.test.ts and a-edge.test.ts)*

### A nested note

Still inside invariants. *(test: nested/a-deep.test.tsx)*

## Decisions

- some-adr.md

## Key files

- src/a.ts
`;

const DOC_B = `# Feature B

## In plain terms

B coordinates things.

## Invariants & boundaries

- **B never blocks.** *(planned — step 4)*
- **B is reproducible.** *(untested — deferred hardening)*

## Key files

- src/b.ts
`;

function entry(partial: Partial<RegistryEntry>): RegistryEntry {
  return {
    doc: "",
    type: "feature",
    primary_sources: [],
    related_sources: [],
    docs: [],
    depends_on: [],
    risk: [],
    status: "current",
    ...partial,
  };
}

function cs(partial: Partial<ChangeState>): ChangeState {
  return {
    changedSources: [],
    changedDocs: [],
    byFeature: [],
    unmapped: [],
    otherChanged: [],
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
    governedRegistered: [],
    governedDeleted: [],
    ...partial,
  };
}

describe("extractDocSection", () => {
  it("returns a section body, includes ### subheadings, stops at the next ## heading", () => {
    const body = extractDocSection(DOC_A, "Invariants & boundaries");
    assert.match(body, /X holds always/);
    assert.match(body, /Y is forbidden/);
    // the ### subheading and its content stay inside the section
    assert.match(body, /A nested note/);
    assert.match(body, /Still inside invariants/);
    // the next ## section must NOT bleed in
    assert.doesNotMatch(body, /Decisions/);
    assert.doesNotMatch(body, /Key files/);
    // an earlier ## section must NOT bleed in
    assert.doesNotMatch(body, /Some design prose/);
  });

  it("is case-insensitive on the heading and trims to empty when absent", () => {
    assert.match(extractDocSection(DOC_A, "in plain terms"), /A does the thing/);
    assert.equal(extractDocSection(DOC_A, "Nonexistent").trim(), "");
  });

  it("ignores heading-like lines inside fenced code blocks", () => {
    const doc = [
      "## Invariants & boundaries",
      "",
      "Invariant 1. *(test: foo.test.ts)*",
      "",
      "```",
      "# fenced heading-looking line",
      "## also fenced",
      "```",
      "",
      "Invariant 2. *(test: bar.test.ts)*",
      "",
      "## Decisions",
      "- some-adr.md",
    ].join("\n");
    const body = extractDocSection(doc, "Invariants & boundaries");
    assert.match(body, /Invariant 1/);
    // the fenced fake headings must NOT truncate or corrupt the section
    assert.match(body, /Invariant 2/);
    // the real ## Decisions heading still closes it
    assert.doesNotMatch(body, /some-adr/);
    // both real test pointers survive (would be incomplete if the fence broke it)
    assert.deepEqual(extractTestPointers(body), ["bar.test.ts", "foo.test.ts"]);
  });

  it("matches an ATX-closed heading (## Heading ##) and ignores the closing hashes", () => {
    const doc = "## Invariants & boundaries ##\n\nBody here.\n\n## Decisions\n";
    assert.match(extractDocSection(doc, "Invariants & boundaries"), /Body here/);
  });
});

describe("extractTestPointers", () => {
  it("collects .test.ts/.tsx references, deduped and sorted", () => {
    const section = extractDocSection(DOC_A, "Invariants & boundaries");
    assert.deepEqual(extractTestPointers(section), [
      "a-core.test.ts",
      "a-edge.test.ts",
      "nested/a-deep.test.tsx",
    ]);
  });

  it("returns empty when a section cites no tests", () => {
    assert.deepEqual(extractTestPointers("- **B never blocks.** *(planned)*"), []);
  });
});

describe("buildReviewBundle", () => {
  const registry: Registry = {
    features: {
      a: entry({ doc: "docs/features/a.md", risk: ["auth"] }),
      b: entry({ doc: "docs/features/b.md" }),
    },
  };
  const docContents = new Map<string, string>([
    ["docs/features/a.md", DOC_A],
    ["docs/features/b.md", DOC_B],
  ]);

  it("projects touched features into contracts with invariants + test oracle", () => {
    const bundle = buildReviewBundle({
      base: "HEAD",
      changeState: cs({
        changedSources: ["src/a.ts", "src/b.ts"],
        byFeature: [
          { feature: "a", files: ["src/a.ts"] },
          { feature: "b", files: ["src/b.ts"] },
        ],
      }),
      registry,
      docContents,
      plan: null,
    });

    assert.equal(bundle.features.length, 2);
    const a = bundle.features[0];
    assert.equal(a.feature, "a");
    assert.equal(a.doc, "docs/features/a.md");
    assert.match(a.contract, /A does the thing/);
    assert.match(a.invariants, /X holds always/);
    assert.deepEqual(a.testPointers, [
      "a-core.test.ts",
      "a-edge.test.ts",
      "nested/a-deep.test.tsx",
    ]);
    assert.deepEqual(a.risk, ["auth"]);
    assert.deepEqual(a.changedSources, ["src/a.ts"]);
    assert.equal(a.hasUntestedInvariant, false);
  });

  // ADR 017: a governed registered file can BLOCK a step while carrying no symbol
  // diff, so leaving it out of the oracle would hand the adversary a change set
  // smaller than the one the gate is enforcing.
  it("carries governed registered files — a file that gates must not be missing from the oracle", () => {
    const bundle = buildReviewBundle({
      base: "HEAD",
      changeState: cs({
        changedSources: ["src/a.ts"],
        byFeature: [{ feature: "a", files: ["src/a.ts"] }],
        governedRegistered: ["i18n/locales/en/journal.json"],
      }),
      registry,
      docContents,
      plan: null,
    });
    assert.deepEqual(bundle.governedRegistered, ["i18n/locales/en/journal.json"]);
    // …and it stays out of the structural attack list, which means something else.
    assert.deepEqual(bundle.changedSources, ["src/a.ts"]);
  });

  it("flags a feature whose invariants are marked untested/planned", () => {
    const bundle = buildReviewBundle({
      base: "HEAD",
      changeState: cs({ byFeature: [{ feature: "b", files: ["src/b.ts"] }] }),
      registry,
      docContents,
      plan: null,
    });
    assert.equal(bundle.features[0].hasUntestedInvariant, true);
    assert.deepEqual(bundle.features[0].testPointers, []);
  });

  it("does not misflag ordinary (honest...) prose, but does flag (honest boundary)", () => {
    const reg: Registry = {
      features: {
        c: entry({ doc: "docs/features/c.md" }),
        d: entry({ doc: "docs/features/d.md" }),
      },
    };
    const docs = new Map<string, string>([
      // "(honestly" is prose, not a no-test marker — must NOT flag
      ["docs/features/c.md", "## Invariants & boundaries\n\n- **X holds.** (honestly, covered by c.test.ts)\n"],
      // "(honest boundary" is the real idiom — must flag
      ["docs/features/d.md", "## Invariants & boundaries\n\n- **Y caps here.** *(honest boundary — the label-noise limit)*\n"],
    ]);
    const c = buildReviewBundle({
      base: "HEAD",
      changeState: cs({ byFeature: [{ feature: "c", files: ["src/c.ts"] }] }),
      registry: reg,
      docContents: docs,
      plan: null,
    });
    const d = buildReviewBundle({
      base: "HEAD",
      changeState: cs({ byFeature: [{ feature: "d", files: ["src/d.ts"] }] }),
      registry: reg,
      docContents: docs,
      plan: null,
    });
    assert.equal(c.features[0].hasUntestedInvariant, false);
    assert.equal(d.features[0].hasUntestedInvariant, true);
  });

  it("skips a changed-feature group with no registry entry (no contract invented)", () => {
    const bundle = buildReviewBundle({
      base: "HEAD",
      changeState: cs({
        byFeature: [
          { feature: "a", files: ["src/a.ts"] },
          { feature: "ghost", files: ["src/g.ts"] },
        ],
      }),
      registry,
      docContents,
      plan: null,
    });
    assert.deepEqual(
      bundle.features.map((f) => f.feature),
      ["a"],
    );
  });

  it("passes the deterministic blast facts and plan through unchanged", () => {
    const state = cs({
      changedSources: ["src/a.ts"],
      byFeature: [{ feature: "a", files: ["src/a.ts"] }],
      staleDocs: [{ feature: "a", doc: "docs/features/a.md", changedSources: ["src/a.ts"] }],
      riskTouches: [{ feature: "a", risk: ["auth"], files: ["src/a.ts"] }],
      dependents: [{ feature: "b", dependsOn: "a" }],
      dependentsSummary: [{ feature: "b", dependsOn: ["a"], viaUmbrella: false }],
      outOfPlan: ["src/x.ts"],
      planScoped: true,
    });
    const bundle = buildReviewBundle({
      base: "abc123",
      changeState: state,
      registry,
      docContents,
      plan: { path: "docs/plans/p.md", scope: ["src/a.ts"] },
    });
    assert.equal(bundle.base, "abc123");
    assert.deepEqual(bundle.changedSources, ["src/a.ts"]);
    assert.deepEqual(bundle.staleDocs, state.staleDocs);
    assert.deepEqual(bundle.riskTouches, state.riskTouches);
    // The bundle carries the RANKED SUMMARY, not the raw edge pairs: the oracle's
    // whole job is to be bounded, and unranked pairs are what made it unreadable.
    assert.deepEqual(bundle.dependents, state.dependentsSummary);
    assert.deepEqual(bundle.outOfPlan, ["src/x.ts"]);
    assert.deepEqual(bundle.plan, { path: "docs/plans/p.md", scope: ["src/a.ts"] });
    // Absent delta = the pre-delta behavior, stated rather than implied.
    assert.equal(bundle.scope, "full");
    assert.deepEqual(bundle.alreadyReviewed, []);
    assert.deepEqual(bundle.priorFindings, []);
  });

  it("delta scope narrows what to attack but never the contract block", () => {
    const state = cs({
      changedSources: ["src/a.ts", "src/b.ts"],
      byFeature: [
        { feature: "a", files: ["src/a.ts"] },
        { feature: "b", files: ["src/b.ts"] },
      ],
    });
    const priorFindings = [
      { citation: "src/a.ts:1", detail: "bad", status: "advisory" as const, failingTest: null },
    ];
    const bundle = buildReviewBundle({
      base: "abc123",
      changeState: state,
      registry,
      docContents,
      plan: null,
      delta: { paths: ["src/a.ts"], alreadyReviewed: ["src/b.ts"], priorFindings },
    });
    assert.equal(bundle.scope, "delta");
    assert.deepEqual(bundle.changedSources, ["src/a.ts"]);
    assert.deepEqual(bundle.alreadyReviewed, ["src/b.ts"]);
    assert.deepEqual(bundle.priorFindings, priorFindings);
    // Every touched feature keeps its invariants and test pointers — scoping the
    // oracle is how a narrow review becomes a shallow one.
    assert.deepEqual(
      bundle.features.map((f) => f.feature).sort(),
      ["a", "b"],
    );
  });
});
