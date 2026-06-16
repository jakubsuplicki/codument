import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  analyze,
  discoverSourceFiles,
  makeIgnoredPredicate,
  isExcluded,
  isSourceFile,
  rollupScore,
  DEFAULT_EXCLUSION_SPEC,
  type CoverageRatio,
  type LintFinding,
} from "../src/lib/analyze.js";
import { listIgnoredPaths } from "../src/lib/git.js";
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

async function analyzeFixture(
  extra: { changedWindow?: { file: string; mappedDocChanged: boolean }[] } = {},
) {
  const registry = await readRegistry(join(FIXTURE, "docs", ".registry.json"));
  return analyze({ root: FIXTURE, registry, srcDir: "src", ...extra });
}

function ratio(ratios: CoverageRatio[], id: string): CoverageRatio {
  const found = ratios.find((r) => r.id === id);
  assert.ok(found, `expected ratio ${id}`);
  return found;
}

function hasFinding(
  lint: LintFinding[],
  id: string,
  match: Partial<LintFinding>,
): boolean {
  return lint.some(
    (f) =>
      f.id === id &&
      (match.feature === undefined || f.feature === match.feature) &&
      (match.file === undefined || f.file === match.file),
  );
}

describe("exclusion spec", () => {
  it("excludes generated, test, spec and declaration files", () => {
    assert.equal(isExcluded("src/generated/api-types.ts"), true);
    assert.equal(isExcluded("src/auth/login.test.ts"), true);
    assert.equal(isExcluded("src/auth/login.spec.ts"), true);
    assert.equal(isExcluded("src/types/index.d.ts"), true);
    assert.equal(isExcluded("node_modules/x/index.ts"), true);
    assert.equal(isExcluded("src/auth/login.ts"), false);
  });

  it("isSourceFile gates on extension and exclusion", () => {
    assert.equal(isSourceFile("src/auth/login.ts"), true);
    assert.equal(isSourceFile("docs/features/auth.md"), false);
    assert.equal(isSourceFile("src/generated/api-types.ts"), false);
  });
});

describe("discoverSourceFiles", () => {
  it("lists in-scope source files and excludes the generated dir", () => {
    const files = discoverSourceFiles(FIXTURE, "src");
    assert.deepStrictEqual(files, [
      "src/auth/login.ts",
      "src/auth/session.ts",
      "src/lib/db.ts",
      "src/lib/validate.ts",
      "src/notify/email.ts",
      "src/tasks/tasks.ts",
    ]);
  });
});

describe("gitignore-aware scope (temp repo)", () => {
  it("keeps gitignored build/vendored trees out of the coverage denominator", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-scope-"));
    try {
      await mkdir(join(tmp, "src"), { recursive: true });
      await mkdir(join(tmp, "lib"), { recursive: true });
      await mkdir(join(tmp, "vendored"), { recursive: true });
      await writeFile(join(tmp, "src", "app.ts"), "export const a = 1;\n");
      await writeFile(join(tmp, "lib", "compiled.js"), "module.exports = 1;\n");
      await writeFile(join(tmp, "vendored", "sdk.ts"), "export const v = 1;\n");
      await writeFile(join(tmp, ".gitignore"), "lib/\nvendored/\n");
      const run = (args: string[]) =>
        execFileSync("git", args, {
          cwd: tmp,
          stdio: "ignore",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        });
      run(["init"]);
      run(["config", "user.email", "t@e.com"]);
      run(["config", "user.name", "T"]);

      // A pure filesystem walk (no predicate) still sees the build/vendor files.
      const raw = discoverSourceFiles(tmp, ".");
      assert.ok(raw.includes("lib/compiled.js"));
      assert.ok(raw.includes("vendored/sdk.ts"));

      // listIgnoredPaths collapses the wholly-ignored dirs to single entries.
      assert.deepStrictEqual(listIgnoredPaths(tmp), ["lib", "vendored"]);

      // Git-aware discovery drops them, leaving only hand-written source.
      const ignored = makeIgnoredPredicate(listIgnoredPaths(tmp));
      const scoped = discoverSourceFiles(tmp, ".", DEFAULT_EXCLUSION_SPEC, ignored);
      assert.deepStrictEqual(scoped, ["src/app.ts"]);

      // analyze() wires this in: only the one real file is in-scope and unowned.
      const result = analyze({ root: tmp, registry: { features: {} }, srcDir: "." });
      assert.equal(result.inScopeSourceCount, 1);
      const ownership = result.coverage.ratios.find((r) => r.id === "ownership");
      assert.deepStrictEqual(ownership?.detail?.unowned, ["src/app.ts"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("analyze coverage (change-control fixture)", () => {
  it("reproduces the golden ownership/dependency/risk ratios and score", async () => {
    const result = await analyzeFixture();

    assert.equal(result.inScopeSourceCount, 6);

    const ownership = ratio(result.coverage.ratios, "ownership");
    assert.equal(ownership.numerator, 5);
    assert.equal(ownership.denominator, 6);
    assert.equal(ownership.ratio, 0.83);
    assert.deepStrictEqual(ownership.detail?.unowned, ["src/lib/validate.ts"]);

    const dependency = ratio(result.coverage.ratios, "dependency");
    assert.equal(dependency.numerator, 2);
    assert.equal(dependency.denominator, 4);
    assert.equal(dependency.ratio, 0.5);

    const risk = ratio(result.coverage.ratios, "risk");
    assert.equal(risk.numerator, 2);
    assert.equal(risk.denominator, 2);
    assert.equal(risk.ratio, 1);

    const freshness = ratio(result.coverage.ratios, "freshness");
    assert.equal(freshness.applicable, false);
    assert.equal(freshness.ratio, null);

    // equal-weight average of the three applicable ratios → 0.78 (freshness N/A)
    assert.equal(result.coverage.percent, 78);
    assert.deepStrictEqual(result.coverage.applicable, [
      "ownership",
      "dependency",
      "risk",
    ]);
  });

  it("computes freshness when a git window is injected", async () => {
    const result = await analyzeFixture({
      changedWindow: [
        { file: "src/auth/login.ts", mappedDocChanged: false },
        { file: "src/tasks/tasks.ts", mappedDocChanged: true },
        { file: "src/lib/db.ts", mappedDocChanged: false },
      ],
    });
    const freshness = ratio(result.coverage.ratios, "freshness");
    assert.equal(freshness.applicable, true);
    assert.equal(freshness.numerator, 1);
    assert.equal(freshness.denominator, 3);
    assert.equal(freshness.ratio, 0.33);
  });
});

describe("analyze lint (change-control fixture)", () => {
  it("flags the planted registry-health problems", async () => {
    const { lint } = await analyzeFixture();

    assert.ok(
      hasFinding(lint, "missing-source", {
        feature: "auth",
        file: "src/auth/oauth.ts",
      }),
      "missing oauth.ts",
    );
    assert.ok(
      hasFinding(lint, "generated-leakage", {
        feature: "notifications",
        file: "src/generated/api-types.ts",
      }),
      "generated api-types leakage",
    );
    assert.ok(
      hasFinding(lint, "unmapped-source", { file: "src/lib/validate.ts" }),
      "unmapped validate.ts",
    );
    assert.ok(
      hasFinding(lint, "empty-depends-on", { feature: "notifications" }),
      "notifications empty depends_on",
    );
    assert.ok(
      hasFinding(lint, "empty-depends-on", { feature: "db" }),
      "db empty depends_on",
    );

    const fanout = lint.find((f) => f.id === "high-fanout");
    assert.ok(fanout, "high-fanout db.ts");
    assert.equal(fanout?.file, "src/lib/db.ts");
    assert.equal(fanout?.count, 3);
    assert.deepStrictEqual(fanout?.evidence, ["auth", "db", "tasks"]);
  });
});

const BLOAT_FIXTURE = join(
  here,
  "..",
  "fixtures",
  "benchmarks",
  "doc-bloat",
);

describe("bloat detection (doc-bloat calibration fixture)", () => {
  async function bloatFindings(root: string) {
    const registry = await readRegistry(join(root, "docs", ".registry.json"));
    const { lint } = analyze({ root, registry, srcDir: "src" });
    return lint.filter((f) => f.id === "bloated-doc");
  }

  it("flags each bloat signal in isolation and not the clean doc", async () => {
    const bloated = await bloatFindings(BLOAT_FIXTURE);
    const byFile = new Map(bloated.map((f) => [f.file, f.evidence?.join(" ") ?? ""]));

    assert.match(byFile.get("docs/features/huge.md") ?? "", /lines \(> 400\)/);
    assert.match(byFile.get("docs/features/bigsection.md") ?? "", /section .* \(> 150\)/);
    assert.match(
      byFile.get("docs/features/logheavy.md") ?? "",
      /completed-log items \(> 15\)/,
    );
    assert.equal(byFile.has("docs/features/clean.md"), false);
  });
});

describe("bloat detection (change-control tasks.md)", () => {
  it("flags tasks.md for completed-log accumulation by default", async () => {
    const { lint } = await analyzeFixture();
    const tasks = lint.find(
      (f) => f.id === "bloated-doc" && f.file === "docs/features/tasks.md",
    );
    assert.ok(tasks, "tasks.md flagged");
    assert.match(tasks?.evidence?.join(" ") ?? "", /completed-log items/);
  });

  it("respects a raised completed-log threshold (CLI override)", async () => {
    const registry = await readRegistry(join(FIXTURE, "docs", ".registry.json"));
    const { lint } = analyze({
      root: FIXTURE,
      registry,
      srcDir: "src",
      bloat: { wholeDocLines: 400, sectionLines: 150, completedLogItems: 30 },
    });
    assert.equal(
      lint.some((f) => f.id === "bloated-doc" && f.file === "docs/features/tasks.md"),
      false,
    );
  });
});

describe("determinism", () => {
  it("produces identical output across runs", async () => {
    const a = await analyzeFixture();
    const b = await analyzeFixture();
    assert.deepStrictEqual(a, b);
  });

  it("rollupScore is invariant to ratio order and excludes N/A ratios", () => {
    const base: CoverageRatio[] = [
      { id: "ownership", label: "", numerator: 5, denominator: 6, ratio: 0.83, applicable: true },
      { id: "dependency", label: "", numerator: 2, denominator: 4, ratio: 0.5, applicable: true },
      { id: "risk", label: "", numerator: 2, denominator: 2, ratio: 1, applicable: true },
      { id: "freshness", label: "", numerator: 0, denominator: 0, ratio: null, applicable: false },
    ];
    const forward = rollupScore(base);
    const reversed = rollupScore([...base].reverse());
    assert.equal(forward.percent, 78);
    assert.equal(reversed.percent, 78);
    // a zero-denominator ratio never counts as 0% or 100%
    assert.deepStrictEqual(forward.applicable.sort(), [
      "dependency",
      "ownership",
      "risk",
    ]);
  });

  it("returns a null score when no ratio is applicable", () => {
    const report = rollupScore([
      { id: "risk", label: "", numerator: 0, denominator: 0, ratio: null, applicable: false },
    ]);
    assert.equal(report.score, null);
    assert.equal(report.percent, null);
  });
});
