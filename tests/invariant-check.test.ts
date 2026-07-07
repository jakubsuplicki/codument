import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  checkInvariants,
  type DocInvariants,
  gatherDocInvariants,
  type InvariantProbes,
  parseInvariants,
  runInvariantCheck,
} from "../src/lib/invariant-check.js";
import { normalizeRegistry } from "../src/lib/registry.js";
import type { TestOutcome } from "../src/lib/review-confirm.js";

// A fake probe set: `outcomes` maps a test file to its run result; a file absent
// from `outcomes` does not "exist". Counts runs so dedup is observable.
function fakeProbes(outcomes: Record<string, TestOutcome>): InvariantProbes & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    exists: (ref) => ref in outcomes,
    run: (ref) => {
      runs.push(ref);
      return { outcome: outcomes[ref] ?? "unrunnable" };
    },
  };
}

// Build a one-doc invariant set from raw markdown for the run tests.
function doc(md: string, path = "docs/features/x.md"): DocInvariants[] {
  return [{ doc: path, invariants: parseInvariants(md) }];
}

describe("parseInvariants — pointer parsing over a doc's invariants section", () => {
  const DOC = [
    "# Feature X",
    "",
    "## In plain terms",
    "- this bullet is NOT in the invariants section and must be ignored *(test: ignore.test.ts)*",
    "",
    "## Invariants & boundaries",
    "",
    "- **A is enforced.** The claim holds. *(test: a.test.ts — the happy path)*",
    "- **B spans files.** *(tests: `b1.test.ts` one case; b2.test.ts#namedCase another)*",
    "- **C is unenforced.** *(untested)*",
    "- **D is a boundary.** *(honest ceiling — undecidable in general)*",
    "- **E cites nothing parseable.** *(test: see the suite somewhere)*",
    "- **F has no marker at all.** Just prose.",
    "",
    "## Decisions",
    "- some decision *(test: decisions-are-not-invariants.test.ts)*",
  ].join("\n");

  const invs = parseInvariants(DOC);

  it("reads only the invariants section (not other sections)", () => {
    assert.equal(invs.length, 6, "A..F, and neither In-plain-terms nor Decisions bullets");
    assert.ok(invs.every((i) => !/ignore|decisions-are-not/.test(JSON.stringify(i.annotation))));
  });

  it("parses a single pinned pointer", () => {
    const a = invs[0];
    assert.equal(a.summary, "A is enforced.");
    assert.deepStrictEqual(a.annotation, { kind: "pinned", pointers: [{ file: "a.test.ts" }] });
  });

  it("parses multiple files and a #name in one marker (back-ticks stripped)", () => {
    const b = invs[1].annotation;
    assert.equal(b.kind, "pinned");
    assert.deepStrictEqual(b.kind === "pinned" && b.pointers, [
      { file: "b1.test.ts" },
      { file: "b2.test.ts", name: "namedCase" },
    ]);
  });

  it("classifies untested and honest markers", () => {
    assert.deepStrictEqual(invs[2].annotation, { kind: "untested" });
    assert.equal(invs[3].annotation.kind, "honest");
  });

  it("surfaces a malformed test marker (names no test file) rather than skipping it", () => {
    assert.equal(invs[4].annotation.kind, "malformed");
  });

  it("marks an unannotated invariant as none", () => {
    assert.equal(invs[5].annotation.kind, "none");
    assert.equal(invs[5].summary, "F has no marker at all.");
  });

  it("reports the doc line of each invariant bullet", () => {
    // "A is enforced" is on line 8 (1-based) of DOC.
    assert.equal(invs[0].line, 8);
  });
});

describe("parseInvariants — edge cases", () => {
  it("returns [] for a doc with no invariants section", () => {
    assert.deepStrictEqual(parseInvariants("# X\n\n## Design approach\n- nothing here\n"), []);
  });

  it("matches the heading case-insensitively and stops at the next level-2 heading", () => {
    const doc = "## invariants & boundaries\n- **only this.** *(untested)*\n## Key files\n- a.ts\n";
    const invs = parseInvariants(doc);
    assert.equal(invs.length, 1);
    assert.equal(invs[0].annotation.kind, "untested");
  });

  it("keeps a multi-line bullet's trailing marker attached to it", () => {
    const doc = [
      "## Invariants & boundaries",
      "- **wrapped claim** that keeps going",
      "  onto a second line and only then",
      "  cites its test *(test: wrapped.test.ts)*",
      "- **next one** *(untested)*",
    ].join("\n");
    const invs = parseInvariants(doc);
    assert.equal(invs.length, 2);
    assert.deepStrictEqual(invs[0].annotation, {
      kind: "pinned",
      pointers: [{ file: "wrapped.test.ts" }],
    });
  });

  it("takes the LAST parenthetical as the annotation (an earlier aside is not it)", () => {
    const src =
      "## Invariants & boundaries\n- **claim** with an *(aside)* mid-sentence *(test: real.test.ts)*\n";
    const invs = parseInvariants(src);
    assert.deepStrictEqual(invs[0].annotation, {
      kind: "pinned",
      pointers: [{ file: "real.test.ts" }],
    });
  });
});

describe("checkInvariants — running the pointers and classifying", () => {
  const MD = [
    "## Invariants & boundaries",
    "- **green.** *(test: g.test.ts)*",
    "- **broken.** *(test: r.test.ts)*",
    "- **unpinned.** *(test: gone.test.ts)*",
    "- **malformed.** *(test: no file here)*",
    "- **untested.** *(untested)*",
    "- **boundary.** *(honest ceiling — undecidable)*",
    "- **toolchain.** *(test: t.test.ts)*",
  ].join("\n");

  const probes = fakeProbes({
    "g.test.ts": "passed",
    "r.test.ts": "failed",
    "t.test.ts": "unrunnable",
    // gone.test.ts intentionally absent → does not exist → unpinned
  });
  const report = checkInvariants(doc(MD), probes);
  const verdict = (summary: string) =>
    report.results.find((r) => r.summary.startsWith(summary))?.verdict;

  it("maps every annotation kind to its verdict", () => {
    assert.equal(verdict("green"), "green");
    assert.equal(verdict("broken"), "invariant-broken");
    assert.equal(verdict("unpinned"), "invariant-unpinned");
    assert.equal(verdict("malformed"), "invariant-unpinned");
    assert.equal(verdict("untested"), "untested");
    assert.equal(verdict("boundary"), "honest");
    assert.equal(verdict("toolchain"), "unrunnable");
  });

  it("warns only on broken + unpinned (what --strict fails on)", () => {
    assert.deepStrictEqual(
      report.warnings.map((w) => w.verdict).sort(),
      ["invariant-broken", "invariant-unpinned", "invariant-unpinned"],
    );
  });

  it("scores the honesty ratio (green / green+broken+unpinned+untested; excludes unrunnable + honest)", () => {
    assert.equal(report.enforced, 1, "one green");
    // scored = green + broken + unpinned + malformed-as-unpinned + untested = 5
    assert.equal(report.scored, 5);
  });

  it("a red test surfaces the failing file in the detail", () => {
    const b = report.results.find((r) => r.verdict === "invariant-broken");
    assert.match(b?.detail ?? "", /r\.test\.ts/);
  });
});

describe("checkInvariants — dedup and precedence", () => {
  it("runs a shared test file only once across invariants", () => {
    const md = [
      "## Invariants & boundaries",
      "- **one.** *(test: shared.test.ts)*",
      "- **two.** *(test: shared.test.ts)*",
      "- **three.** *(tests: shared.test.ts other prose)*",
    ].join("\n");
    const probes = fakeProbes({ "shared.test.ts": "passed" });
    const report = checkInvariants(doc(md), probes);
    assert.deepStrictEqual(probes.runs, ["shared.test.ts"], "ran exactly once");
    assert.equal(report.enforced, 3, "all three read the cached green");
  });

  it("a broken cited test outranks a missing one on the same invariant", () => {
    const md = "## Invariants & boundaries\n- **multi.** *(tests: red.test.ts and missing.test.ts)*\n";
    const probes = fakeProbes({ "red.test.ts": "failed" }); // missing.test.ts absent
    const report = checkInvariants(doc(md), probes);
    assert.equal(report.results[0].verdict, "invariant-broken");
  });
});

describe("runInvariantCheck — end-to-end over a fixture repo (real runner)", () => {
  let tmp: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-inv-e2e-"));
    await mkdir(join(tmp, "docs/features"), { recursive: true });
    await writeFile(
      join(tmp, "docs/.registry.json"),
      JSON.stringify({
        features: { f: { doc: "docs/features/f.md", type: "feature", primary_sources: [], status: "current" } },
      }),
    );
    await writeFile(
      join(tmp, "docs/features/f.md"),
      [
        "# F",
        "## Invariants & boundaries",
        "- **the enforced one.** *(test: pass.test.js)*",
        "- **the violated one.** *(test: fail.test.js)*",
        "- **the missing one.** *(test: gone.test.js)*",
        "- **the honest one.** *(untested)*",
        "",
      ].join("\n"),
    );
    // Plain node:test files so the runner needs only `node --test` (no tsx in /tmp).
    await writeFile(join(tmp, "pass.test.js"), 'import{test}from"node:test";test("ok",()=>{});\n');
    await writeFile(
      join(tmp, "fail.test.js"),
      'import{test}from"node:test";import a from"node:assert";test("bad",()=>a.equal(1,2));\n',
    );
  });
  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("gathers invariants from the registered doc", () => {
    const reg = normalizeRegistry(JSON.parse('{"features":{"f":{"doc":"docs/features/f.md"}}}'));
    const gathered = gatherDocInvariants(tmp, reg);
    assert.equal(gathered.length, 1);
    assert.equal(gathered[0].invariants.length, 4);
  });

  it("classifies a passing, a failing, and a missing cited test end-to-end", () => {
    const reg = normalizeRegistry(JSON.parse('{"features":{"f":{"doc":"docs/features/f.md"}}}'));
    const report = runInvariantCheck(tmp, reg, ["node", "--test", "{file}"]);
    const v = (needle: string) =>
      report.results.find((r) => r.summary.includes(needle))?.verdict;
    assert.equal(v("enforced"), "green", "pass.test.js ran green");
    assert.equal(v("violated"), "invariant-broken", "fail.test.js ran red");
    assert.equal(v("missing"), "invariant-unpinned", "gone.test.js does not resolve");
    assert.equal(v("honest"), "untested");
    assert.equal(report.enforced, 1);
    assert.equal(report.warnings.length, 2, "broken + unpinned");
  });
});
