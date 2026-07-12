import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { LanguageAdapter } from "../src/lib/fingerprint.js";
import { classifyTsFile, tsAdapter } from "../src/lib/ts-adapter.js";
import { type AdapterHarness, checkAdapterConformance } from "./adapter-conformance.js";

// The known-good adapter through the battery: `clamp` is the module-private
// helper folded into `area`'s closure; `registerShapes(...)` is the residual
// side-effect no anchor covers; `perimeter` carries the body/signature edits so
// the helper-closure symbol stays untangled from them.
const BASE = `// Shape helpers for the conformance battery.
function clamp(n: number): number {
  return n < 0 ? 0 : n;
}

export function area(w: number, h: number): number {
  return clamp(w * h);
}

export function perimeter(w: number, h: number): number {
  return 2 * (w + h);
}

registerShapes("area", "perimeter");
`;

const tsHarness: AdapterHarness = {
  adapter: tsAdapter,
  classify: (path, content) => classifyTsFile(path, content).mode,
  fixtures: {
    path: "src/shapes.ts",
    base: BASE,
    formatted: `/* reformatted, same meaning */
function clamp(n: number): number { return n < 0 ? 0 : n; }

export function area(w: number, h: number): number {
  return clamp(w * h); // area, clamped
}


export function perimeter(w: number, h: number): number {
  return 2 * (w + h);
}

registerShapes("area", "perimeter");
`,
    bodyEdit: {
      symbol: "perimeter",
      content: BASE.replace("return 2 * (w + h);", "return (w + h) * 2;"),
    },
    signatureEdit: {
      symbol: "perimeter",
      content: BASE.replace(
        "perimeter(w: number, h: number): number {",
        "perimeter(w: number, h: number, pad: number = 0): number {",
      ),
    },
    helperEdit: {
      symbol: "area",
      content: BASE.replace("return n < 0 ? 0 : n;", "return n <= 0 ? 0 : n;"),
    },
    residualEdit: BASE.replace(
      'registerShapes("area", "perimeter");',
      'registerShapes("area", "perimeter", "extra");',
    ),
    reordered: `// Shape helpers for the conformance battery.
function clamp(n: number): number {
  return n < 0 ? 0 : n;
}

export function perimeter(w: number, h: number): number {
  return 2 * (w + h);
}

export function area(w: number, h: number): number {
  return clamp(w * h);
}

registerShapes("area", "perimeter");
`,
    parseError: "export function broken(( {\n",
  },
};

// The seeded mutant: fingerprints derived from RAW content — format churn and
// line-ending noise move every anchor. If the battery cannot reject this, it
// is theater.
const rawContentMutant: LanguageAdapter = {
  language: "typescript-mutant",
  matches: tsAdapter.matches,
  anchors: (path, content) =>
    tsAdapter.anchors(path, content).map((a) => ({
      ...a,
      fingerprint: createHash("sha256").update(content, "utf8").digest("hex"),
    })),
};

describe("adapter conformance battery", () => {
  it("the bundled TypeScript adapter passes all eight behaviors", () => {
    assert.deepEqual(checkAdapterConformance(tsHarness), []);
  });

  it("rejects a seeded mutant whose fingerprints hash raw content — the battery bites", () => {
    const violations = checkAdapterConformance({ ...tsHarness, adapter: rawContentMutant });
    assert.ok(violations.length > 0, "mutant produced no violations");
    assert.ok(
      violations.some((v) => v.rule === "1-format-invariance"),
      `expected a format-invariance violation, got: ${JSON.stringify(violations)}`,
    );
  });

  it("flags a malformed fixture instead of reading vacuously green", () => {
    const violations = checkAdapterConformance({
      ...tsHarness,
      fixtures: { ...tsHarness.fixtures, base: "// nothing anchorable here\n" },
    });
    assert.ok(violations.some((v) => v.rule === "0-fixture-shape"));
  });
});
