import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, type LintFinding } from "../src/lib/analyze.js";
import { readRegistry } from "../src/lib/registry.js";
import { detectApprovedPlanScope } from "../src/lib/change-state.js";
import { parseInvariants } from "../src/lib/invariant-check.js";
import { extractDocSection } from "../src/lib/review-bundle.js";

// Every markdown parser must read a CRLF checkout exactly as it reads an LF one.
//
// The class this pins: splitting on "\n" leaves a trailing "\r" on every line,
// which is invisible to an unanchored regex and fatal to a `$`-anchored one —
// JavaScript's `.` never matches a carriage return, so `/^#{1,6}\s+(.*)$/` fails
// on every heading a Windows checkout produces. The bloat lint therefore saw no
// headings at all and reported whole documents as one untitled section, on one
// platform only, which is why a green suite and a field repo disagreed for
// several releases. Asserting "a finding fired" cannot catch it: the finding did
// fire, naming the wrong thing. So each case asserts PARITY between the two
// encodings, and the bloat case additionally asserts the section is named.
const crlf = (s: string): string => s.replace(/\n/g, "\r\n");

const bigSectionDoc = (): string =>
  [
    "---",
    "title: Big Section Doc",
    "status: current",
    "type: feature",
    "---",
    "",
    "# Big Section Doc",
    "",
    "## Overview",
    "",
    "Short.",
    "",
    "## The Big Section",
    "",
    ...Array.from({ length: 160 }, (_, i) => `Line ${i + 1} of the big section.`),
    "",
    "## Wrap Up",
    "",
    "Done.",
    "",
  ].join("\n");

const REGISTRY = JSON.stringify(
  {
    features: {
      bigsection: {
        doc: "docs/features/bigsection.md",
        type: "feature",
        primary_sources: ["src/bigsection.ts"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      },
    },
  },
  null,
  2,
);

async function bloatProject(root: string, encode: (s: string) => string): Promise<void> {
  await mkdir(join(root, "docs", "features"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "docs", ".registry.json"), REGISTRY);
  await writeFile(join(root, "src", "bigsection.ts"), "export const a = 1;\n");
  await writeFile(join(root, "docs", "features", "bigsection.md"), encode(bigSectionDoc()));
}

async function bloatFindings(root: string): Promise<LintFinding[]> {
  const registry = await readRegistry(join(root, "docs", ".registry.json"));
  const { lint } = analyze({ root, registry, srcDir: "src" });
  return lint.filter((f) => f.id === "bloated-doc");
}

const PLAN = [
  "---",
  "status: approved",
  "---",
  "",
  "# A plan",
  "",
  "## Scope",
  "",
  "- `src/lib/one.ts`",
  "- `src/lib/two.ts`",
  "",
  "## Delivery Plan",
  "",
  "- [ ] Step 1: do it",
  "",
].join("\n");

const DOC_WITH_INVARIANTS = [
  "---",
  "title: A doc",
  "---",
  "",
  "# A doc",
  "",
  "## In plain terms",
  "",
  "Orientation.",
  "",
  "## Invariants & boundaries",
  "",
  "- **The first thing holds.** Because it must. *(test: one.test.ts)*",
  "- **The second thing holds too.** Also because it must. *(untested)*",
  // No bold lead and spanning lines: the summary falls back to the opening
  // line, which is the one path where a retained carriage return reaches a
  // rendered string rather than only a failed match.
  "- A plain claim with no bold lead, which continues",
  "  onto a second line before its citation. *(test: two.test.ts)*",
  "",
  "## Decisions",
  "",
  "Nothing.",
  "",
].join("\n");

describe("every markdown parser reads CRLF exactly as it reads LF", () => {
  let base = "";
  let lfRoot = "";
  let crlfRoot = "";
  let planLfRoot = "";
  let planCrlfRoot = "";

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "codument-crlf-"));
    lfRoot = join(base, "lf");
    crlfRoot = join(base, "crlf");
    planLfRoot = join(base, "plan-lf");
    planCrlfRoot = join(base, "plan-crlf");
    await bloatProject(lfRoot, (s) => s);
    await bloatProject(crlfRoot, crlf);
    for (const [root, encode] of [
      [planLfRoot, (s: string) => s],
      [planCrlfRoot, crlf],
    ] as const) {
      await mkdir(join(root, "docs", "plans"), { recursive: true });
      await writeFile(join(root, "docs", "plans", "01-a-plan.md"), encode(PLAN));
    }
  });

  after(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("the bloat lint names the section it flagged, not the whole file", async () => {
    // The regression in one assertion: with a retained `\r` no heading matches,
    // so the largest section is the whole document under the synthetic
    // "(preamble)" title — advice the author cannot act on, about a document
    // that is correctly sectioned.
    for (const [label, root] of [
      ["LF", lfRoot],
      ["CRLF", crlfRoot],
    ] as const) {
      const [finding] = await bloatFindings(root);
      assert.ok(finding, `${label}: the oversized section is flagged`);
      const evidence = finding.evidence?.join(" ") ?? "";
      assert.match(evidence, /section "The Big Section"/, `${label}: names the real heading`);
      assert.doesNotMatch(evidence, /preamble/, `${label}: not reported as a preamble`);
    }
  });

  it("the bloat lint reports identical findings for both encodings", async () => {
    assert.deepStrictEqual(await bloatFindings(crlfRoot), await bloatFindings(lfRoot));
  });

  // The one case here that does NOT bite when the defect is seeded: scope reads
  // backtick spans through unanchored patterns, so a retained carriage return
  // never reaches a captured value. Its normalization removes a landmine rather
  // than fixing a fault, and this asserts the whole approved-plan path — status
  // parse included — works on a CRLF checkout. Said plainly so it is not read as
  // mutation-proven when the four above it are.
  it("plan scope resolves identically for both encodings", () => {
    const lf = detectApprovedPlanScope(planLfRoot);
    const crlfPlan = detectApprovedPlanScope(planCrlfRoot);
    assert.deepStrictEqual(lf?.scope, ["src/lib/one.ts", "src/lib/two.ts"]);
    assert.deepStrictEqual(crlfPlan?.scope, lf?.scope);
  });

  it("invariant parsing is identical for both encodings", () => {
    const lf = parseInvariants(DOC_WITH_INVARIANTS);
    const withCrlf = parseInvariants(crlf(DOC_WITH_INVARIANTS));
    assert.equal(lf.length, 3);
    assert.equal(lf[0].summary, "The first thing holds.");
    assert.equal(lf[2].summary, "A plain claim with no bold lead, which continues");
    assert.deepStrictEqual(withCrlf, lf);
  });

  it("bundle section extraction is identical for both encodings", () => {
    const lf = extractDocSection(DOC_WITH_INVARIANTS, "Invariants & boundaries");
    const withCrlf = extractDocSection(crlf(DOC_WITH_INVARIANTS), "Invariants & boundaries");
    assert.match(lf, /The first thing holds/);
    // Normalized to LF by the split, so the two bodies are byte-identical.
    assert.equal(withCrlf, lf);
  });
});
