import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveChangeSet } from "../src/lib/change-set.js";
import { forgetWorkspace } from "../src/lib/git.js";
import type { ChangeState } from "../src/lib/change-state.js";
import type { Registry, RegistryEntry } from "../src/lib/registry.js";
import {
  buildReviewBundle,
  buildContractChanges,
  gatherReviewGrounding,
  bundleStamp,
  extractDocSection,
  extractPinnedTests,
  extractTestPointers,
  oracleFingerprint,
} from "../src/lib/review-bundle.js";

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

describe("contract-only review grounding", () => {
  it("reads previous workspace contracts from each member and its selected base", async () => {
    const root = await mkdtemp(join(tmpdir(), "codument-grounding-workspace-"));
    const member = join(root, "api");
    try {
      await mkdir(join(member, "docs"), { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: member, stdio: "pipe" });
      git("init", "-q");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      await writeFile(
        join(member, "docs/alpha.md"),
        "## Invariants & boundaries\n- Preserve records. *(test: alpha.test.ts)*\n",
      );
      git("add", ".");
      git("commit", "-qm", "contract");
      const registry = {
        features: { alpha: entry({ doc: "api/docs/alpha.md", primary_sources: ["api/src/a.ts"] }) },
      };
      await writeFile(join(member, "docs/alpha.md"), "# Alpha\n");
      git("add", "docs/alpha.md");
      const paths = ["api/docs/alpha.md"];
      const local = gatherReviewGrounding(root, "HEAD", registry, paths);
      assert.match(local.changes[0].before!, /Preserve records/);
      assert.deepEqual(local.changes[0].testPointers, ["alpha.test.ts"]);
      const staged = gatherReviewGrounding(
        root,
        "not-a-shared-ref",
        registry,
        paths,
        undefined,
        [],
        [],
        resolveChangeSet(root, { mode: "staged" }),
      );
      assert.match(staged.changes[0].before!, /Preserve records/);
    } finally {
      forgetWorkspace();
      await rm(root, { recursive: true, force: true });
    }
  });
  const docs = {
    features: {
      alpha: entry({
        doc: "docs/features/alpha.md",
        primary_sources: ["src/alpha.ts"],
        docs: ["skills/work-step/SKILL.md"],
      }),
    },
  };
  const path = "docs/features/alpha.md";
  const changes = (before: string, after: string, paths = [path]) =>
    buildContractChanges({
      paths,
      registry: docs,
      previousRegistry: docs,
      before: new Map([[path, before]]),
      after: new Map([[path, after]]),
    });
  it("retains removed invariants and their tests even with accompanying source work", () => {
    const result = changes(
      DOC_A,
      DOC_A.replace(/## Invariants & boundaries[\s\S]*?(?=## Decisions)/, ""),
      [path, "src/alpha.ts"],
    );
    assert.equal(result[0].requiresReview, true);
    assert.match(result[0].before!, /X holds always/);
    assert.ok(result[0].testPointers.includes("a-core.test.ts"));
  });
  it("requires review for doc-only durable changes but preserves ordinary source proportionality", () => {
    const edited = DOC_A.replace("A does the thing.", "A changes the public behavior.");
    assert.equal(changes(DOC_A, edited)[0].requiresReview, true);
    assert.equal(changes(DOC_A, edited, [path, "src/alpha.ts"])[0].requiresReview, false);
  });
  it("ignores formatting, metadata, progress and path-only Key files corrections", () => {
    const before = DOC_A + "\n## Delivery Plan\nStatus: approved\n- [ ] Implement\n";
    const edited = before
      .replace("title: Feature A", "title: Renamed")
      .replace("- [ ]", "- [x]")
      .replace("- src/a.ts", "- src/b.ts");
    // Key-files paths are normally code-formatted; use the standard notation.
    assert.deepEqual(
      changes(
        before.replace("- src/a.ts", "- `src/a.ts`"),
        edited.replace("- src/b.ts", "- `src/b.ts`").replace(/\n/g, "\r\n"),
      ),
      [],
    );
    assert.deepEqual(changes(DOC_A, DOC_A.replace("A does the thing.", "A   does the thing.")), []);
  });
  it("reviews registered instruction changes against both versions and historical ownership", () => {
    const instruction = "skills/work-step/SKILL.md";
    const result = buildContractChanges({
      paths: [instruction],
      registry: { features: {} },
      previousRegistry: docs,
      before: new Map([[instruction, "Wait for human approval."]]),
      after: new Map([[instruction, "Start immediately."]]),
    });
    assert.equal(result[0].kind, "instruction");
    assert.deepEqual(result[0].owners, ["alpha"]);
    assert.equal(result[0].requiresReview, true);
  });
});

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
      b: entry({ doc: "docs/features/b.md", depends_on: ["a"] }),
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

  it("projects a test-only impacted feature without calling the test documentation source", () => {
    const testImpact = {
      changedTests: ["tests/a.test.ts", "tests/unknown.test.ts"],
      attributed: [{ test: "tests/a.test.ts", feature: "a", via: "direct-import" as const }],
      unattributed: ["tests/unknown.test.ts"],
      dependents: [{ feature: "b", dependsOn: "a" }],
      dependentsSummary: [{ feature: "b", dependsOn: ["a"], viaUmbrella: false }],
    };
    const bundle = buildReviewBundle({
      base: "HEAD",
      changeState: cs({ excludedChanged: testImpact.changedTests }),
      registry,
      docContents,
      plan: null,
      testImpact,
    });

    assert.deepEqual(bundle.testImpact, testImpact);
    assert.deepEqual(bundle.changedSources, []);
    assert.deepEqual(bundle.dependents, [{ feature: "b", dependsOn: ["a"], viaUmbrella: false }]);
    assert.equal(bundle.features.length, 1);
    assert.equal(bundle.features[0].feature, "a");
    assert.deepEqual(bundle.features[0].changedSources, []);
    assert.match(bundle.features[0].invariants, /X holds always/);
  });

  it("keeps unchanged tests in delta context instead of the next attack", () => {
    const testImpact = {
      changedTests: ["tests/a.test.ts", "tests/unknown.test.ts"],
      attributed: [{ test: "tests/a.test.ts", feature: "a", via: "direct-import" as const }],
      unattributed: ["tests/unknown.test.ts"],
      dependents: [{ feature: "b", dependsOn: "a" }],
      dependentsSummary: [{ feature: "b", dependsOn: ["a"], viaUmbrella: false }],
    };
    const bundle = buildReviewBundle({
      base: "HEAD",
      changeState: cs({ excludedChanged: testImpact.changedTests }),
      registry,
      docContents,
      plan: null,
      testImpact,
      delta: {
        paths: ["tests/a.test.ts"],
        alreadyReviewed: ["tests/unknown.test.ts"],
        priorFindings: [],
      },
    });

    assert.deepEqual(bundle.testImpact, {
      changedTests: ["tests/a.test.ts"],
      attributed: [{ test: "tests/a.test.ts", feature: "a", via: "direct-import" }],
      unattributed: [],
      dependents: [{ feature: "b", dependsOn: "a" }],
      dependentsSummary: [{ feature: "b", dependsOn: ["a"], viaUmbrella: false }],
    });
    assert.deepEqual(bundle.alreadyReviewed, ["tests/unknown.test.ts"]);
    assert.equal(bundle.features[0].feature, "a", "the full feature oracle remains in context");
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
      [
        "docs/features/c.md",
        "## Invariants & boundaries\n\n- **X holds.** (honestly, covered by c.test.ts)\n",
      ],
      // "(honest boundary" is the real idiom — must flag
      [
        "docs/features/d.md",
        "## Invariants & boundaries\n\n- **Y caps here.** *(honest boundary — the label-noise limit)*\n",
      ],
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
    assert.deepEqual(bundle.features.map((f) => f.feature).sort(), ["a", "b"]);
  });
});

describe("the bundle stamps what it handed over (plan 49)", () => {
  const registry: Registry = {
    features: { a: entry({ doc: "docs/features/a.md", risk: ["auth"] }) },
  };
  const docContents = new Map<string, string>([["docs/features/a.md", DOC_A]]);
  const build = (changed: string[], docs = docContents) =>
    buildReviewBundle({
      base: "HEAD",
      changeState: cs({ changedSources: changed, byFeature: [{ feature: "a", files: changed }] }),
      registry,
      docContents: docs,
      plan: null,
    });

  it("stamps identically for identical content, on every run", () => {
    assert.equal(build(["src/a.ts"]).stamp, build(["src/a.ts"]).stamp);
  });

  it("moves when what was handed over moves", () => {
    // Both halves matter: the files the reviewer was told to attack, and the
    // invariants it was shown. A stamp that only tracked the file list would let a
    // review of an emptied oracle claim the same grounding as a review of a full one.
    assert.notEqual(build(["src/a.ts"]).stamp, build(["src/a.ts", "src/b.ts"]).stamp);
    const emptied = new Map<string, string>([["docs/features/a.md", "# A\n"]]);
    assert.notEqual(build(["src/a.ts"]).stamp, build(["src/a.ts"], emptied).stamp);
  });

  it("is a digest of the bundle's own content, computed over the body it ships", () => {
    // One definition, shared: a checker recomputing it must land on the same value,
    // or a stamp means one thing to the writer and another to the reader.
    const bundle = build(["src/a.ts"]);
    const { stamp, ...body } = bundle;
    assert.equal(stamp, bundleStamp(body));
  });
});

describe("the oracle is bound, and it is the oracle the bundle handed over (plan 49)", () => {
  const registry: Registry = {
    features: { a: entry({ doc: "docs/features/a.md" }), b: entry({ doc: "docs/features/b.md" }) },
  };
  const featuresOf = (docs: Map<string, string>) =>
    buildReviewBundle({
      base: "HEAD",
      changeState: cs({
        changedSources: ["src/a.ts", "src/b.ts"],
        byFeature: [
          { feature: "a", files: ["src/a.ts"] },
          { feature: "b", files: ["src/b.ts"] },
        ],
      }),
      registry,
      docContents: docs,
      plan: null,
    }).features;
  const both = new Map<string, string>([
    ["docs/features/a.md", DOC_A],
    ["docs/features/b.md", DOC_B],
  ]);

  it("moves when an invariant the reviewer was shown is rewritten", () => {
    // The gap: the fingerprint bound the sources and the named tests and stopped
    // there, so the one thing the adversary was told to attack could be rewritten
    // after the review was recorded and the artifact went on covering the diff.
    const rewritten = new Map(both);
    rewritten.set("docs/features/a.md", DOC_A.replace("X holds always", "X holds sometimes"));
    assert.notEqual(oracleFingerprint(featuresOf(both)), oracleFingerprint(featuresOf(rewritten)));
  });

  it("moves when a feature's orientation layer is emptied", () => {
    const gutted = new Map(both);
    gutted.set("docs/features/a.md", DOC_A.replace(/A does the thing[^\n]*/, ""));
    assert.notEqual(oracleFingerprint(featuresOf(both)), oracleFingerprint(featuresOf(gutted)));
  });

  it("is stable across runs and independent of the order features arrive in", () => {
    assert.equal(oracleFingerprint(featuresOf(both)), oracleFingerprint(featuresOf(both)));
    const fs = featuresOf(both);
    assert.equal(oracleFingerprint(fs), oracleFingerprint([...fs].reverse()));
  });
});

describe("extractPinnedTests is structural, never lexical (plan 49)", () => {
  it("reads a pin out of the standard's own marker, in both spellings", () => {
    const section = [
      '- **It holds.** *(test: alpha.test.ts "it holds")*',
      '- **It also holds.** *(tests: `beta.test.tsx` "one"; gamma.test.ts "two")*',
    ].join("\n");
    assert.deepEqual(extractPinnedTests(section), [
      "alpha.test.ts",
      "beta.test.tsx",
      "gamma.test.ts",
    ]);
  });

  it("ignores a test file merely named in prose — the stated limit, not an oversight", () => {
    // Loosening the grammar to any sentence naming a test file turns a citation into
    // a lexical guess, and this feeds a FINDING: it needs a claim the doc made.
    const section = "- **It holds.** Both halves are pinned by nowhere.test.tsx, allegedly.";
    assert.deepEqual(extractPinnedTests(section), []);
    // …while the oracle extractor, which costs a reader nothing when it is generous,
    // still hands it over.
    assert.deepEqual(extractTestPointers(section), ["nowhere.test.tsx"]);
  });

  it("is empty for a section with no pins at all", () => {
    assert.deepEqual(extractPinnedTests("- **Untested on purpose.** *(untested)*"), []);
  });
});
