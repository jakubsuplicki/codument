import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  analyze,
  discoverSourceFiles,
  makeIgnoredPredicate,
  isExcluded,
  isSourceFile,
  rollupScore,
  resolveExclusionSpec,
  resolveScopeSync,
  isTestPath,
  TEST_CONVENTIONS,
  configuredExclusions,
  DEFAULT_EXCLUSION_SPEC,
  type CoverageRatio,
  type LintFinding,
  deriveDependencyEdges,
} from "../src/lib/analyze.js";
import type { RegistryEntry } from "../src/lib/registry.js";
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

async function analyzeFixture() {
  const registry = await readRegistry(join(FIXTURE, "docs", ".registry.json"));
  return analyze({ root: FIXTURE, registry, srcDir: "src" });
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
    // A root-level test-fixture tree is excluded (its own source is a test
    // asset, not governed first-party source)...
    assert.equal(
      isExcluded("fixtures/benchmarks/seeded-bugs/project/src/auth/authorize.js"),
      true,
    );
    // ...but the rule is root-anchored: real first-party source under a nested
    // `fixtures/` dir (or a file merely named fixtures) stays in scope, so the
    // opinionated default cannot silently swallow a project's product code.
    assert.equal(isExcluded("src/fixtures/factory.ts"), false);
    assert.equal(isExcluded("src/fixtures.ts"), false);
    assert.equal(isExcluded("src/auth/login.ts"), false);
  });

  // Cargo's law, anchored where the law applies. A crate root's `tests/` and
  // `benches/` hold test binaries and benchmarks the way `_test.go` files do —
  // and before this rule existed a Rust project's integration tests read as
  // undocumented first-party source to the diff-driven gate (`review --strict`
  // failed on them as unmapped) and to `generated-leakage`.
  it("excludes a crate root's cargo test and benchmark trees, anchored", () => {
    assert.equal(isExcluded("tests/api.rs"), true);
    assert.equal(isExcluded("tests/common/mod.rs"), true);
    assert.equal(isExcluded("benches/throughput.rs"), true);
    // A crate's real source is never swept up, whatever it is called.
    assert.equal(isExcluded("src/lib.rs"), false);
    assert.equal(isExcluded("src/exams/tests/model.rs"), false);
    // Honest bound: a cargo WORKSPACE member's tests stay governed. The matcher
    // cannot see where a `Cargo.toml` sits, and guessing would reopen the
    // unanchored hazard — such a workspace declares its own pattern.
    assert.equal(isExcluded("crates/parser/tests/integration.rs"), false);
    // The rule is Rust-scoped, not a directory-name rule: a non-`.rs` file at
    // the same path is untouched by it.
    assert.equal(isExcluded("tests/adapter-conformance.ts"), false);
  });

  // The boundary the spec actually draws: it removes what a language's own test
  // convention NAMES, never everything that lives near tests. `tests`, `test`
  // and `spec` are ordinary words — a lab-diagnostics, exam or assessment
  // product has domain code by those names — so a directory alone never proves
  // a file is a test, and one shared spec means one shared blind spot across
  // coverage, the gate, `scan` discovery and the editor hook.
  it("keeps a first-party module under a test-named directory in scope", () => {
    assert.equal(isExcluded("src/exams/tests/model.ts"), false);
    assert.equal(isExcluded("src/lab/test/protocol.ts"), false);
    assert.equal(isExcluded("src/exams/spec/rubric.ts"), false);
    // ...while the convention-named file beside it is still a test.
    assert.equal(isExcluded("src/exams/tests/model.test.ts"), true);
  });

  it("isSourceFile gates on extension and exclusion", () => {
    assert.equal(isSourceFile("src/auth/login.ts"), true);
    assert.equal(isSourceFile("docs/features/auth.md"), false);
    assert.equal(isSourceFile("src/generated/api-types.ts"), false);
  });

  it("module-flavored JS/TS extensions are source; declaration variants are not", () => {
    assert.equal(isSourceFile("next.config.mjs"), true);
    assert.equal(isSourceFile("scripts/build.cjs"), true);
    assert.equal(isSourceFile("src/loader.mts"), true);
    assert.equal(isSourceFile("src/loader.cts"), true);
    // Declaration artifacts stay outside governance, whatever their flavor.
    assert.equal(isSourceFile("src/types.d.ts"), false);
    assert.equal(isSourceFile("src/types.d.mts"), false);
    assert.equal(isSourceFile("src/types.d.cts"), false);
  });

  it("python is source; its test conventions and environment trees are not", () => {
    assert.equal(isSourceFile("app/settings.py"), true);
    assert.equal(isSourceFile("app/models.pyi"), true);
    assert.equal(isSourceFile("manage.py"), true);
    // pytest conventions — the `*.test.*` family's analogs.
    assert.equal(isSourceFile("tests/test_models.py"), false);
    assert.equal(isSourceFile("app/models_test.py"), false);
    assert.equal(isSourceFile("tests/conftest.py"), false);
    // Environment/bytecode trees never count as first-party source.
    assert.equal(isSourceFile(".venv/lib/python3.12/site-packages/x.py"), false);
    assert.equal(isSourceFile("venv/bin/activate_this.py"), false);
    assert.equal(isSourceFile("app/__pycache__/settings.py"), false);
    assert.equal(isSourceFile("app/settings.pyc"), false);
  });
});

describe("discoverSourceFiles", () => {
  it("lists in-scope source files and excludes the generated dir", () => {
    const { paths, unreadable } = discoverSourceFiles(FIXTURE, "src");
    assert.deepStrictEqual(unreadable, [], "a readable tree reports nothing unreadable");
    assert.deepStrictEqual(paths, [
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
      const raw = discoverSourceFiles(tmp, ".").paths;
      assert.ok(raw.includes("lib/compiled.js"));
      assert.ok(raw.includes("vendored/sdk.ts"));

      // listIgnoredPaths collapses the wholly-ignored dirs to single entries.
      const listing = listIgnoredPaths(tmp);
      assert.equal(listing.ok, true);
      assert.deepStrictEqual(listing.ok && listing.paths, ["lib", "vendored"]);

      // Git-aware discovery drops them, leaving only hand-written source.
      const ignored = makeIgnoredPredicate(listing.ok ? listing.paths : []);
      const scoped = discoverSourceFiles(tmp, ".", DEFAULT_EXCLUSION_SPEC, ignored).paths;
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

// Widening the built-in spec is not a one-directional improvement, and pinning
// which direction it moves is the honest version of the claim. An UNOWNED file
// leaving scope raises coverage (it stops counting as undocumented). An OWNED
// one leaves numerator and denominator together, so a ratio below 100% can only
// hold or fall — and the user learns about it from `generated-leakage`, whose
// job is to say "un-map this", not from a number that quietly moved.
describe("what a spec widening does to a project that already registered the file", () => {
  async function cargoLikeProject() {
    const tmp = await mkdtemp(join(tmpdir(), "codument-cargo-scope-"));
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "tests"), { recursive: true });
    await writeFile(join(tmp, "src", "lib.rs"), "pub fn a() {}\n");
    // Unowned, so the baseline sits below 100% — a dropped owned file cannot
    // show a fall against a ratio already floored at 1.0.
    await writeFile(join(tmp, "src", "parser.rs"), "pub fn b() {}\n");
    await writeFile(join(tmp, "tests", "api.rs"), "#[test] fn t() {}\n");
    const registry = {
      features: {
        core: {
          doc: "docs/features/core.md",
          type: "feature" as const,
          primary_sources: ["src/lib.rs", "tests/api.rs"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current" as const,
        },
      },
    };
    // The spec as it stood before Cargo's trees were recognized.
    const preUpgrade = {
      ...DEFAULT_EXCLUSION_SPEC,
      globs: DEFAULT_EXCLUSION_SPEC.globs.filter((g) => !g.endsWith("/**/*.rs")),
    };
    return { tmp, registry, preUpgrade };
  }

  it("lowers the ownership ratio rather than raising it, when the excluded file was owned", async () => {
    const { tmp, registry, preUpgrade } = await cargoLikeProject();
    try {
      const before = analyze({ root: tmp, registry, srcDir: ".", exclusion: preUpgrade });
      const after = analyze({ root: tmp, registry, srcDir: ".", exclusion: DEFAULT_EXCLUSION_SPEC });
      assert.ok(
        ratio(after.coverage.ratios, "ownership").ratio <
          ratio(before.coverage.ratios, "ownership").ratio,
        "an owned file leaving scope must leave numerator and denominator together",
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("says so out loud: the registered cargo test draws generated-leakage", async () => {
    const { tmp, registry, preUpgrade } = await cargoLikeProject();
    try {
      const before = analyze({ root: tmp, registry, srcDir: ".", exclusion: preUpgrade });
      const after = analyze({ root: tmp, registry, srcDir: ".", exclusion: DEFAULT_EXCLUSION_SPEC });
      assert.equal(
        hasFinding(before.lint, "generated-leakage", { file: "tests/api.rs" }),
        false,
      );
      assert.equal(hasFinding(after.lint, "generated-leakage", { file: "tests/api.rs" }), true);
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
    // `db` is a foundation concept (auth + tasks depend on it, it depends on
    // nothing), so it is a vacuous case excluded from the denominator — not a
    // miss. Denominator is auth, tasks, notifications; auth + tasks declare deps.
    assert.equal(dependency.numerator, 2);
    assert.equal(dependency.denominator, 3);
    assert.equal(dependency.ratio, 0.67);

    const risk = ratio(result.coverage.ratios, "risk");
    assert.equal(risk.numerator, 2);
    assert.equal(risk.denominator, 2);
    assert.equal(risk.ratio, 1);

    // equal-weight average of the three applicable ratios (0.83, 0.67, 1) → 0.83
    assert.equal(result.coverage.percent, 83);
    assert.deepStrictEqual(result.coverage.applicable, [
      "ownership",
      "dependency",
      "risk",
    ]);
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
    // notifications is an island: nothing depends on it and it depends on
    // nothing — a probable wiring omission, so it is flagged.
    assert.ok(
      hasFinding(lint, "empty-depends-on", { feature: "notifications" }),
      "notifications empty depends_on",
    );
    // db is a foundation: auth + tasks depend on it, so its empty depends_on is
    // the expected leaf state, not a gap — it must NOT be flagged.
    assert.ok(
      !hasFinding(lint, "empty-depends-on", { feature: "db" }),
      "db is a foundation — empty depends_on must not be flagged",
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
      { id: "risk", label: "", numerator: 1, denominator: 1, ratio: 1, applicable: true },
    ];
    // a zero-denominator ratio never counts as 0% or 100% — drop risk to N/A and
    // the score is the average of just ownership + dependency, unchanged by order
    const withNa: CoverageRatio[] = [
      base[0],
      base[1],
      { id: "risk", label: "", numerator: 0, denominator: 0, ratio: null, applicable: false },
    ];
    const forward = rollupScore(base);
    const reversed = rollupScore([...base].reverse());
    assert.equal(forward.percent, 78);
    assert.equal(reversed.percent, 78);
    assert.deepStrictEqual(forward.applicable.sort(), [
      "dependency",
      "ownership",
      "risk",
    ]);
    const na = rollupScore(withNa);
    assert.deepStrictEqual(na.applicable.sort(), ["dependency", "ownership"]);
    assert.equal(na.percent, rollupScore([...withNa].reverse()).percent);
  });

  it("returns a null score when no ratio is applicable", () => {
    const report = rollupScore([
      { id: "risk", label: "", numerator: 0, denominator: 0, ratio: null, applicable: false },
    ]);
    assert.equal(report.score, null);
    assert.equal(report.percent, null);
  });
});

describe("doc integrity findings (thin-doc + link-rot)", () => {
  function entry(doc: string, status: string) {
    const slug = (doc.split("/").pop() ?? "").replace(".md", "");
    return {
      doc,
      type: "feature",
      primary_sources: [`src/${slug}.ts`],
      related_sources: [],
      docs: [],
      depends_on: ["plain"],
      risk: [],
      status,
    };
  }

  const REGISTRY = JSON.stringify({
    features: {
      stub: entry("docs/features/stub.md", "current"),
      summarized: entry("docs/features/summarized.md", "current"),
      plain: entry("docs/features/plain.md", "current"),
      fresh: entry("docs/features/fresh.md", "needs-review"),
      linky: entry("docs/features/linky.md", "current"),
    },
  });

  const SRC = Object.fromEntries(
    ["stub", "summarized", "plain", "fresh", "linky"].map((s) => [
      `src/${s}.ts`,
      `export const ${s} = 1;\n`,
    ]),
  );

  async function integrityLint(
    files: Record<string, string>,
  ): Promise<LintFinding[]> {
    const tmp = await mkdtemp(join(tmpdir(), "codument-integrity-"));
    try {
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(join(tmp, dirname(rel)), { recursive: true });
        await writeFile(join(tmp, rel), content);
      }
      const registry = await readRegistry(join(tmp, "docs", ".registry.json"));
      return analyze({ root: tmp, registry, srcDir: "src" }).lint;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  it("thin-doc fires on a mature stub but not on Summary / In-plain-terms / needs-review docs", async () => {
    const lint = await integrityLint({
      "docs/.registry.json": REGISTRY,
      ...SRC,
      "docs/features/stub.md": "# Stub\n\nNothing under a layer heading.\n",
      "docs/features/summarized.md": "# Sum\n\n## Summary\n\nReal orientation.\n",
      "docs/features/plain.md": "# Plain\n\n## In plain terms\n\nReal orientation.\n",
      "docs/features/fresh.md": "# Fresh\n\nstub scaffold, but needs-review.\n",
      "docs/features/linky.md": "# Linky\n\n## Summary\n\nok.\n",
    });
    const thin = lint.filter((f) => f.id === "thin-doc").map((f) => f.feature);
    assert.deepStrictEqual(thin.sort(), ["stub"]);
  });

  it("link-rot flags dangling links and wikilinks, ignoring valid / external / fenced", async () => {
    const body = [
      "# Linky",
      "",
      "## Summary",
      "",
      "A [valid](./plain.md) link and an [external](https://example.com) one.",
      "A [[plain]] wikilink that resolves.",
      "",
      "A [dead](./missing.md) link and a [[ghost-feature]] wikilink.",
      "",
      "```md",
      "An example [fenced](./also-missing.md) link that must be ignored.",
      "```",
      "",
    ].join("\n");
    const lint = await integrityLint({
      "docs/.registry.json": REGISTRY,
      ...SRC,
      "docs/features/stub.md": "# S\n\n## Summary\n\nx.\n",
      "docs/features/summarized.md": "# S\n\n## Summary\n\nx.\n",
      "docs/features/plain.md": "# P\n\n## In plain terms\n\nx.\n",
      "docs/features/fresh.md": "# F\n\n## Summary\n\nx.\n",
      "docs/features/linky.md": body,
    });
    const rot = lint.filter(
      (f) => f.id === "link-rot" && f.file === "docs/features/linky.md",
    );
    const msgs = rot.map((f) => f.message).join(" | ");
    assert.equal(rot.length, 2, msgs);
    assert.match(msgs, /missing\.md/);
    assert.match(msgs, /ghost-feature/);
    assert.doesNotMatch(msgs, /also-missing\.md/); // fenced example ignored
    assert.doesNotMatch(msgs, /example\.com/); // external link ignored
  });

  it("link-rot handles balanced parens in a path (route groups), not truncating at the inner paren", async () => {
    const body = [
      "# Linky",
      "",
      "## Summary",
      "",
      "A [valid route group](./app/(tabs)/settings.md) that resolves.",
      "A [dead route group](./app/(tabs)/missing.md) that does not.",
      "",
    ].join("\n");
    const lint = await integrityLint({
      "docs/.registry.json": REGISTRY,
      ...SRC,
      "docs/features/stub.md": "# S\n\n## Summary\n\nx.\n",
      "docs/features/summarized.md": "# S\n\n## Summary\n\nx.\n",
      "docs/features/plain.md": "# P\n\n## In plain terms\n\nx.\n",
      "docs/features/fresh.md": "# F\n\n## Summary\n\nx.\n",
      "docs/features/linky.md": body,
      "docs/features/app/(tabs)/settings.md": "exists\n",
    });
    const rot = lint.filter(
      (f) => f.id === "link-rot" && f.file === "docs/features/linky.md",
    );
    const msgs = rot.map((f) => f.message).join(" | ");
    // the valid (tabs) link resolves whole and is not flagged; only the missing
    // one is, proving the path was not truncated at the inner paren.
    assert.equal(rot.length, 1, msgs);
    assert.match(msgs, /\(tabs\)\/missing\.md/);
    assert.doesNotMatch(msgs, /settings\.md/);
  });
});

describe("empty-depends-on (foundation exemption)", () => {
  // app -> util. util is a foundation (app depends on it) that declares nothing;
  // island depends on nothing and nothing depends on it.
  const REGISTRY = JSON.stringify({
    features: {
      app: {
        doc: "docs/features/app.md",
        type: "feature",
        primary_sources: ["src/app.ts"],
        depends_on: ["util"],
        status: "current",
      },
      util: {
        doc: "docs/concepts/util.md",
        type: "concept",
        primary_sources: ["src/util.ts"],
        depends_on: [],
        status: "current",
      },
      island: {
        doc: "docs/features/island.md",
        type: "feature",
        primary_sources: ["src/island.ts"],
        depends_on: [],
        status: "current",
      },
    },
  });

  async function lintFor(): Promise<LintFinding[]> {
    const tmp = await mkdtemp(join(tmpdir(), "codument-foundation-"));
    try {
      await mkdir(join(tmp, "docs"), { recursive: true });
      await mkdir(join(tmp, "src"), { recursive: true });
      await writeFile(join(tmp, "docs", ".registry.json"), REGISTRY);
      for (const s of ["app", "util", "island"]) {
        await writeFile(join(tmp, "src", `${s}.ts`), `export const ${s} = 1;\n`);
      }
      const registry = await readRegistry(join(tmp, "docs", ".registry.json"));
      return analyze({ root: tmp, registry, srcDir: "src" }).lint;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  it("flags an island but never a depended-upon foundation", async () => {
    const flagged = (await lintFor())
      .filter((f) => f.id === "empty-depends-on")
      .map((f) => f.feature)
      .sort();
    // island flagged (probable wiring omission); util exempt (foundation).
    assert.deepStrictEqual(flagged, ["island"]);
  });
});

describe("empty-depends-on — scaffold exemption + confirmed leaf (first-run honesty)", () => {
  async function analyzed(entryPatch: Record<string, unknown>) {
    const tmp = await mkdtemp(join(tmpdir(), "codument-scaffold-"));
    try {
      await mkdir(join(tmp, "docs"), { recursive: true });
      await mkdir(join(tmp, "src"), { recursive: true });
      await writeFile(
        join(tmp, "docs", ".registry.json"),
        JSON.stringify({
          features: {
            leaf: {
              doc: "docs/features/leaf.md",
              type: "feature",
              primary_sources: ["src/leaf.ts"],
              depends_on: [],
              status: "current",
              ...entryPatch,
            },
          },
        }),
      );
      await writeFile(join(tmp, "src", "leaf.ts"), "export const leaf = 1;\n");
      const registry = await readRegistry(join(tmp, "docs", ".registry.json"));
      return analyze({ root: tmp, registry, srcDir: "src" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  it("a fresh needs-review scaffold fires nothing and never opens at a 0% dependency ratio", async () => {
    // The state a fresh `scan` writes: seconds-old scaffolds must not trip the
    // tool's own warnings (the same in-flight rationale as the thin-doc lint).
    const r = await analyzed({ status: "needs-review" });
    assert.ok(!r.lint.some((f) => f.id === "empty-depends-on"), "no finding on a scaffold");
    const dep = r.coverage.ratios.find((x) => x.id === "dependency");
    assert.equal(dep?.denominator, 0, "scaffolds step out of the ratio, not drag it to 0%");
  });

  it("a mature isolated entry still fires (the exemption is for scaffolds, not everyone)", async () => {
    const r = await analyzed({});
    assert.ok(r.lint.some((f) => f.id === "empty-depends-on" && f.feature === "leaf"));
  });

  it("depends_on_confirmed clears a reviewed true leaf honestly (finding AND ratio)", async () => {
    const r = await analyzed({ depends_on_confirmed: true });
    assert.ok(!r.lint.some((f) => f.id === "empty-depends-on"), "confirmed leaf is clear");
    const dep = r.coverage.ratios.find((x) => x.id === "dependency");
    assert.equal(dep?.denominator, 0, "a confirmed-empty is vacuous, like a foundation");
  });
});

describe("registry graph integrity (dangling-depends-on + orphan-doc)", () => {
  // app -> util resolves; app -> ghost-layer dangles. co-owned.md is owned via
  // app's docs array; orphan.md exists under docs/features with no owner; the
  // plans page and the docs-root page sit outside the features|concepts trees.
  const REGISTRY = JSON.stringify({
    features: {
      app: {
        doc: "docs/features/app.md",
        type: "feature",
        primary_sources: ["src/app.ts"],
        // deliberately "./"-spelled: the filesystem forgives it (missing-doc
        // stays silent), so the parse must canonicalize it or the string-keyed
        // orphan check would false-fire on an owned page.
        docs: ["./docs/concepts/co-owned.md"],
        depends_on: ["util", "ghost-layer"],
        status: "current",
      },
      util: {
        doc: "docs/concepts/util.md",
        type: "concept",
        primary_sources: ["src/util.ts"],
        depends_on: [],
        status: "current",
      },
    },
  });

  async function graphLint(): Promise<LintFinding[]> {
    const tmp = await mkdtemp(join(tmpdir(), "codument-graph-"));
    try {
      const files: Record<string, string> = {
        "docs/.registry.json": REGISTRY,
        "src/app.ts": "export const app = 1;\n",
        "src/util.ts": "export const util = 1;\n",
        "docs/features/app.md": "# App\n\n## Summary\n\nx.\n",
        "docs/concepts/util.md": "# Util\n\n## Summary\n\nx.\n",
        "docs/concepts/co-owned.md": "# Co-owned\n\nowned via app.docs.\n",
        "docs/features/orphan.md": "# Orphan\n\nno entry points here.\n",
        "docs/plans/roadmap.md": "# Roadmap\n\ntransient planning page.\n",
        "docs/overview.md": "# Overview\n\ndocs-root page.\n",
      };
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(join(tmp, dirname(rel)), { recursive: true });
        await writeFile(join(tmp, rel), content);
      }
      const registry = await readRegistry(join(tmp, "docs", ".registry.json"));
      return analyze({ root: tmp, registry, srcDir: "src" }).lint;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  it("dangling-depends-on fires per unresolvable edge (warn), never on one that resolves", async () => {
    const dangling = (await graphLint()).filter((f) => f.id === "dangling-depends-on");
    assert.equal(dangling.length, 1, dangling.map((f) => f.message).join(" | "));
    assert.equal(dangling[0].severity, "warn");
    assert.equal(dangling[0].feature, "app");
    assert.match(dangling[0].message, /"ghost-layer"/);
    assert.doesNotMatch(dangling[0].message, /"util"/);
  });

  it("orphan-doc notes an unowned feature/concept page (info) — owned pages and pages outside those trees stay silent", async () => {
    const orphans = (await graphLint()).filter((f) => f.id === "orphan-doc");
    assert.deepStrictEqual(
      orphans.map((f) => f.file),
      ["docs/features/orphan.md"],
      orphans.map((f) => f.message).join(" | "),
    );
    // Info, never warn: an unowned page is a question ("own it or know why
    // not"), not a CI failure — the plans page and docs-root page never fire.
    assert.equal(orphans[0].severity, "info");
  });
});

// ── generated-leakage sees git's ground truth ───────────────────────────
//
// The safety net that should have caught the field defect was structurally
// blind: analyze computed the gitignore predicate for the coverage denominator
// and never handed it to computeLint, so the lint tested only the static
// exclusion spec. A registry holding 378 gitignored build artifacts reported
// "Lint: no findings" — the one check that could have caught the leak had the
// answer in scope and did not look.

describe("generated-leakage consults git's ignore set, not only the static spec", () => {
  let tmp: string;

  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

  const analyzeWith = (sources: string[]) =>
    analyze({
      root: tmp,
      srcDir: ".",
      registry: {
        features: {
          app: {
            doc: "docs/features/app.md",
            type: "feature",
            primary_sources: sources,
            related_sources: [],
            docs: [],
            depends_on: [],
            risk: [],
            status: "current",
          },
        },
      },
    });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-leak-"));
    await mkdir(join(tmp, "app"), { recursive: true });
    await mkdir(join(tmp, "out"), { recursive: true });
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await writeFile(join(tmp, ".gitignore"), "out/\n");
    await writeFile(join(tmp, "app", "real.ts"), "export const a = 1;\n");
    await writeFile(join(tmp, "out", "gen.js"), "exports.g = 1;\n");
    await writeFile(join(tmp, "app", "thing.test.ts"), "export const t = 1;\n");
    await writeFile(join(tmp, "docs", "features", "app.md"), "# app\n\nPromise.\n");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("flags a git-ignored file listed as a source, naming git as the rule", () => {
    git(["init"]);
    const leaks = analyzeWith(["app/real.ts", "out/gen.js"]).lint.filter(
      (f) => f.id === "generated-leakage",
    );
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].file, "out/gen.js");
    // The evidence must name WHICH rule fired: git's ignore set is a stronger
    // claim ("the repo itself declared this untracked") than a glob heuristic.
    assert.match(leaks[0].message, /git-ignored/);
  });

  it("does not flag an unignored, non-excluded source", () => {
    git(["init"]);
    const leaks = analyzeWith(["app/real.ts"]).lint.filter(
      (f) => f.id === "generated-leakage",
    );
    assert.deepStrictEqual(leaks, []);
  });

  it("does not flag a TRACKED file that merely matches a gitignore pattern", () => {
    // The false-positive guard, and the reason this rule is safe to make a warn:
    // `ls-files --others --ignored` lists only UNTRACKED ignored files, so a file
    // the project committed is never claimed to be build output — however broad
    // the pattern that would otherwise match it. A deliberately-committed
    // `.env.example` or vendored file stays documentable.
    git(["init"]);
    git(["add", "app/real.ts", "docs/features/app.md"]);
    git(["commit", "-m", "track the source"]);
    // Only NOW does a pattern matching the tracked file appear.
    writeFileSync(join(tmp, ".gitignore"), "out/\n*.ts\n");
    // Precondition: git agrees the pattern matches, yet the file is tracked.
    assert.equal(git(["check-ignore", "--no-index", "app/real.ts"]).trim(), "app/real.ts");

    const leaks = analyzeWith(["app/real.ts"]).lint.filter(
      (f) => f.id === "generated-leakage",
    );
    assert.deepStrictEqual(leaks, [], "a tracked file is never build output");
  });

  it("reports one finding per source, never two, when both rules match", () => {
    // A `.d.ts` inside an ignored build dir matches the static spec AND git's
    // ignore set. The lint id feeds doctor --strict's exit code and the report's
    // counts, so a file must contribute exactly one finding.
    git(["init"]);
    writeFileSync(join(tmp, "out", "types.d.ts"), "export declare const x: number;\n");
    const leaks = analyzeWith(["out/types.d.ts"]).lint.filter(
      (f) => f.id === "generated-leakage",
    );
    assert.equal(leaks.length, 1);
    assert.match(leaks[0].message, /git-ignored/, "the stronger rule wins the evidence");
  });

  it("flags every git-ignored source, one finding each (the field shape)", () => {
    // The reported registry held hundreds of build artifacts and produced
    // "Lint: no findings". Scaled down, this is that shape.
    git(["init"]);
    for (const n of [1, 2, 3]) {
      writeFileSync(join(tmp, "out", `gen${n}.js`), `exports.g = ${n};\n`);
    }
    const leaks = analyzeWith([
      "app/real.ts",
      "out/gen1.js",
      "out/gen2.js",
      "out/gen3.js",
    ]).lint.filter((f) => f.id === "generated-leakage");
    assert.equal(leaks.length, 3);
    assert.deepStrictEqual(
      leaks.map((f) => f.file).sort(),
      ["out/gen1.js", "out/gen2.js", "out/gen3.js"],
    );
  });

  it("still flags a statically-excluded source, with the spec's own wording", () => {
    git(["init"]);
    const leaks = analyzeWith(["app/real.ts", "app/thing.test.ts"]).lint.filter(
      (f) => f.id === "generated-leakage",
    );
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].file, "app/thing.test.ts");
    assert.match(leaks[0].message, /matches a built-in exclusion rule/);
  });

  it("cannot flag git-ignored leakage when the ignore rules are undeterminable", () => {
    // No `git init`: the honest limit. The lint cannot claim a file is ignored
    // by a repository it could not read — which is exactly why doctor discloses
    // the unverified scope rather than leaving the clean lint to imply safety.
    const result = analyzeWith(["app/real.ts", "out/gen.js"]);
    assert.deepStrictEqual(
      result.lint.filter((f) => f.id === "generated-leakage"),
      [],
    );
    assert.equal(result.scope.gitIgnore, "unavailable");
  });
});

describe("resolveExclusionSpec widens the defaults, never narrows them", () => {
  let root: string;

  const writeMetaWith = async (exclude?: unknown): Promise<void> => {
    await writeFile(
      join(root, ".codument-meta.json"),
      JSON.stringify({
        version: "0.9.0",
        initialized: "2026-07-21",
        project: { srcDir: "src" },
        ...(exclude === undefined ? {} : { exclude }),
      }),
      "utf-8",
    );
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-exclude-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the default spec itself when no meta file exists", async () => {
    assert.deepEqual(await resolveExclusionSpec(root), DEFAULT_EXCLUSION_SPEC);
  });

  it("returns the default spec when the meta declares no exclude block", async () => {
    await writeMetaWith(undefined);
    assert.deepEqual(await resolveExclusionSpec(root), DEFAULT_EXCLUSION_SPEC);
  });

  it("adds configured dirs to the defaults without dropping any", async () => {
    await writeMetaWith({ dirs: ["out", "public-preprod"] });
    const spec = await resolveExclusionSpec(root);
    assert.ok(spec.dirs.includes("out"));
    assert.ok(spec.dirs.includes("public-preprod"));
    for (const preset of DEFAULT_EXCLUSION_SPEC.dirs) {
      assert.ok(spec.dirs.includes(preset), `default dir ${preset} was dropped`);
    }
  });

  it("adds configured globs to the defaults without dropping any", async () => {
    await writeMetaWith({ globs: ["**/*.gen.ts"] });
    const spec = await resolveExclusionSpec(root);
    assert.ok(spec.globs.includes("**/*.gen.ts"));
    for (const preset of DEFAULT_EXCLUSION_SPEC.globs) {
      assert.ok(spec.globs.includes(preset), `default glob ${preset} was dropped`);
    }
  });

  it("never lets config touch the extension list (the language matrix's truth)", async () => {
    await writeMetaWith({ dirs: ["out"], globs: ["**/*.gen.ts"] });
    const spec = await resolveExclusionSpec(root);
    assert.deepEqual(spec.extensions, DEFAULT_EXCLUSION_SPEC.extensions);
  });

  it("dedupes a configured entry that repeats a default", async () => {
    await writeMetaWith({ dirs: ["dist", "out"] });
    const spec = await resolveExclusionSpec(root);
    assert.equal(spec.dirs.filter((d) => d === "dist").length, 1);
  });

  it("does not mutate the shared default spec across calls", async () => {
    const before = [...DEFAULT_EXCLUSION_SPEC.dirs];
    await writeMetaWith({ dirs: ["out"] });
    await resolveExclusionSpec(root);
    assert.deepEqual(DEFAULT_EXCLUSION_SPEC.dirs, before);
    assert.ok(!DEFAULT_EXCLUSION_SPEC.dirs.includes("out"));
  });

  // A returned array that IS the default's array turns any caller's in-place
  // edit into a process-wide spec rewrite. Every branch must hand back a copy,
  // including the ones that add nothing — those are the common paths.
  it("never returns an array the default spec also holds", async () => {
    const assertUnaliased = (spec: typeof DEFAULT_EXCLUSION_SPEC, label: string): void => {
      assert.notEqual(spec.dirs, DEFAULT_EXCLUSION_SPEC.dirs, `${label}: dirs aliased`);
      assert.notEqual(spec.globs, DEFAULT_EXCLUSION_SPEC.globs, `${label}: globs aliased`);
      assert.notEqual(
        spec.extensions,
        DEFAULT_EXCLUSION_SPEC.extensions,
        `${label}: extensions aliased`,
      );
    };
    assertUnaliased(await resolveExclusionSpec(root), "no meta file");
    await writeMetaWith(undefined);
    assertUnaliased(await resolveExclusionSpec(root), "no exclude block");
    await writeMetaWith({});
    assertUnaliased(await resolveExclusionSpec(root), "empty block");
    await writeMetaWith({ dirs: [], globs: [] });
    assertUnaliased(await resolveExclusionSpec(root), "empty lists");
    await writeMetaWith({ globs: ["**/*.gen.ts"] });
    assertUnaliased(await resolveExclusionSpec(root), "globs only");
  });

  it("survives a caller mutating the spec it was handed", async () => {
    await writeMetaWith({ globs: ["**/*.gen.ts"] });
    const first = await resolveExclusionSpec(root);
    first.dirs.push("mutated-by-caller");
    const second = await resolveExclusionSpec(root);
    assert.ok(!second.dirs.includes("mutated-by-caller"));
    assert.ok(!DEFAULT_EXCLUSION_SPEC.dirs.includes("mutated-by-caller"));
  });

  it("accepts a non-ASCII dir name and a glob carrying separators", async () => {
    await writeMetaWith({ dirs: ["ausgabe-\u00fcber"], globs: ["packages/*/dist/**"] });
    const spec = await resolveExclusionSpec(root);
    assert.equal(isExcluded("src/ausgabe-\u00fcber/x.ts", spec), true);
    assert.equal(isExcluded("packages/api/dist/bundle.js", spec), true);
    assert.equal(isExcluded("packages/api/src/bundle.js", spec), false);
  });

  it("makes a configured dir actually exclude, end to end", async () => {
    await writeMetaWith({ dirs: ["out"] });
    const spec = await resolveExclusionSpec(root);
    assert.equal(isExcluded("out/bundle.js", spec), true);
    assert.equal(isSourceFile("out/bundle.js", spec), false);
    // ...and it was NOT excluded before the config existed.
    assert.equal(isExcluded("out/bundle.js", DEFAULT_EXCLUSION_SPEC), false);
  });

  it("makes a configured glob actually exclude, end to end", async () => {
    await writeMetaWith({ globs: ["**/*.gen.ts"] });
    const spec = await resolveExclusionSpec(root);
    assert.equal(isSourceFile("src/api.gen.ts", spec), false);
    assert.equal(isSourceFile("src/api.ts", spec), true);
  });

  it("propagates the validation error rather than falling back to defaults", async () => {
    await writeMetaWith({ dirs: ["build/out"] });
    await assert.rejects(() => resolveExclusionSpec(root), /is a path/);
  });

  // Two failures, two answers. A file that PARSES but declares something wrong is
  // the user having said a wrong thing — it must not be scored past. A file that
  // does not parse says nothing about whether a declaration exists, so degrading
  // is honest as long as it is reported: unknown is not empty.
  // A project's own declaration and a built-in heuristic call for different
  // responses, so the evidence has to say which one fired: "you declared this"
  // versus "codument's guess may be wrong about your file".
  it("names the project's own rule when a declared path is registered", async () => {
    await mkdir(join(root, "out"), { recursive: true });
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "out", "gen.js"), "exports.g = 1;\n");
    await writeFile(join(root, "docs", "features", "app.md"), "# app\n");
    await writeFile(
      join(root, "docs", ".registry.json"),
      JSON.stringify({
        features: {
          app: {
            doc: "docs/features/app.md",
            type: "feature",
            primary_sources: ["out/gen.js"],
            related_sources: [],
            docs: [],
            depends_on: [],
            risk: [],
            status: "current",
          },
        },
      }),
    );
    const registry = await readRegistry(join(root, "docs", ".registry.json"));
    const declared = { dirs: ["out"] };
    const withDeclaration = analyze({
      root,
      registry,
      exclusion: { ...DEFAULT_EXCLUSION_SPEC, dirs: [...DEFAULT_EXCLUSION_SPEC.dirs, "out"] },
      declaredExclusions: declared,
    }).lint.filter((f) => f.id === "generated-leakage");
    assert.equal(withDeclaration.length, 1, "an exclusion silences the gate only visibly");
    assert.match(withDeclaration[0].message, /declared out-of-scope/);
    assert.match(withDeclaration[0].message, /dirs: out/);

    // A built-in rule keeps its own wording, so the two are distinguishable.
    await writeFile(join(root, "out", "gen.js"), "exports.g = 1;\n");
    const builtIn = analyze({
      root,
      registry,
      exclusion: { ...DEFAULT_EXCLUSION_SPEC, dirs: [...DEFAULT_EXCLUSION_SPEC.dirs, "out"] },
      declaredExclusions: null,
    }).lint.filter((f) => f.id === "generated-leakage");
    assert.equal(builtIn.length, 1);
    assert.match(builtIn[0].message, /built-in exclusion rule/);
    assert.doesNotMatch(builtIn[0].message, /declared/);
  });

  it("degrades and reports when the metadata cannot be read at all", async () => {
    await writeFile(join(root, ".codument-meta.json"), "{ not json", "utf-8");
    const scope = resolveScopeSync(root);
    assert.deepEqual(scope.spec.dirs, DEFAULT_EXCLUSION_SPEC.dirs);
    assert.equal(scope.configured, null);
    assert.match(String(scope.unreadable), /is unreadable/);
    assert.match(String(scope.unreadable), /declared scope could not be read/);
  });

  it("says nothing about readability when the metadata is fine", async () => {
    await writeMetaWith({ dirs: ["out"] });
    assert.equal(resolveScopeSync(root).unreadable, undefined);
    await writeMetaWith(undefined);
    assert.equal(resolveScopeSync(root).unreadable, undefined);
  });

  it("refuses rather than degrades when a declaration itself is invalid", async () => {
    await writeMetaWith({ dirs: ["build/out"] });
    assert.throws(() => resolveScopeSync(root), /is a path/);
  });

  it("reports the configured additions, and null when there are none", async () => {
    await writeMetaWith(undefined);
    assert.equal(await configuredExclusions(root), null);
    await writeMetaWith({});
    assert.equal(await configuredExclusions(root), null);
    await writeMetaWith({ dirs: [], globs: [] });
    assert.equal(await configuredExclusions(root), null);
    await writeMetaWith({ dirs: ["out"] });
    assert.deepEqual(await configuredExclusions(root), { dirs: ["out"], globs: [] });
  });
});

describe("one definition of a test file, and the spec is composed from it", () => {
  // Two surfaces ask "is this a test file": the exclusion spec (keep tests out
  // of the coverage scope) and the prose-altitude heuristic (a cited test path
  // is not file enumeration). A second copy is how they would drift, so the
  // spec is built FROM the conventions — pinned structurally here.
  it("every test convention is present in the default spec", () => {
    for (const dir of TEST_CONVENTIONS.dirs) {
      assert.ok(DEFAULT_EXCLUSION_SPEC.dirs.includes(dir), `spec lost test dir ${dir}`);
    }
    for (const glob of TEST_CONVENTIONS.globs) {
      assert.ok(DEFAULT_EXCLUSION_SPEC.globs.includes(glob), `spec lost test glob ${glob}`);
    }
  });

  it("does not share array identity with the spec (a mutation cannot cross over)", () => {
    assert.notEqual(TEST_CONVENTIONS.dirs, DEFAULT_EXCLUSION_SPEC.dirs);
    assert.notEqual(TEST_CONVENTIONS.globs, DEFAULT_EXCLUSION_SPEC.globs);
    const beforeDirs = [...TEST_CONVENTIONS.dirs];
    const beforeGlobs = [...TEST_CONVENTIONS.globs];
    DEFAULT_EXCLUSION_SPEC.dirs.push("mutated-dir");
    DEFAULT_EXCLUSION_SPEC.globs.push("mutated-glob");
    try {
      assert.deepEqual(TEST_CONVENTIONS.dirs, beforeDirs);
      assert.deepEqual(TEST_CONVENTIONS.globs, beforeGlobs);
    } finally {
      DEFAULT_EXCLUSION_SPEC.dirs.pop();
      DEFAULT_EXCLUSION_SPEC.globs.pop();
    }
  });

  // Every language family's convention, through the REAL exported predicate —
  // the prose heuristic's exemption is only as honest as this function.
  const testPaths = [
    "src/a.test.ts",
    "src/a.spec.ts",
    "src/services/applicant.service.spec.ts",
    "src/__tests__/a.ts",
    "src/nested/__tests__/deep/a.ts",
    "src/test_thing.py",
    "src/thing_test.py",
    "src/conftest.py",
    "src/thing_test.go",
    "src/FooTest.java",
    "src/FooTests.java",
    "src/FooTestCase.java",
    "src/FooTest.kt",
    "src/FooSpec.kt",
    "app/src/test/java/Foo.java",
    "tests/integration.rs",
    "tests/common/helpers.rs",
    "benches/throughput.rs",
    "fixtures/thing.ts",
  ];
  for (const path of testPaths) {
    it(`recognizes ${path}`, () => assert.equal(isTestPath(path), true));
  }

  const notTestPaths = [
    "src/a.ts",
    "src/services/applicant.service.ts",
    "src/testing.ts",
    "src/contest.py",
    "src/latest.go",
    "src/Foo.java",
    "src/Tester.kt",
    "src/fixtures/real-source.ts",
    // Cargo's rule is anchored at the crate root and scoped to Rust, so a
    // module named `tests`, a workspace member's tests, and a same-path file in
    // another language all stay first-party source.
    "src/exams/tests/model.rs",
    "crates/parser/tests/integration.rs",
    "tests/adapter-conformance.ts",
  ];
  for (const path of notTestPaths) {
    it(`does not claim ${path} is a test`, () => assert.equal(isTestPath(path), false));
  }

  // An honest bound worth pinning rather than discovering: the JVM source-set
  // glob is not language-scoped, so ANY project's literal `src/test/` directory
  // is treated as tests. Bounded — it only widens an info-only exemption.
  it("treats any literal src/test/ tree as tests, whatever the language", () => {
    assert.equal(isTestPath("src/test/utils.ts"), true);
  });

  it("does not consult the project's declared exclusions (documented bound)", () => {
    // A project's own `exclude.globs` convention is NOT honored yet; the doc
    // says so, and this pins that the claim stays true.
    assert.equal(isTestPath("src/a.integration.ts"), false);
  });
});

describe("an unreadable directory is reported, never silently skipped", () => {
  // The loudness regression adopting the shared walker inherited: the walk
  // swallowed a permissions error and returned a SHORTER file list, which shrinks
  // the coverage denominator — and a smaller denominator makes the percentage read
  // HIGHER than the truth. Same most-confident-where-most-wrong inversion as an
  // undeterminable ignore set, arriving by a different route.
  let root: string;
  let locked: string;

  // chmod is meaningless as root and on filesystems that ignore permission bits;
  // probe rather than assume, so this never fails for the wrong reason.
  const canLockADirectory = async (): Promise<boolean> => {
    const probe = await mkdtemp(join(tmpdir(), "codument-perm-probe-"));
    try {
      await chmod(probe, 0o000);
      readdirSync(probe);
      return false; // read succeeded despite 000 — cannot simulate the failure
    } catch {
      return true;
    } finally {
      await chmod(probe, 0o755).catch(() => {});
      await rm(probe, { recursive: true, force: true });
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-unreadable-"));
    await mkdir(join(root, "src", "open"), { recursive: true });
    await writeFile(join(root, "src", "open", "a.ts"), "export const a = 1;\n");
    locked = join(root, "src", "locked");
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, "hidden.ts"), "export const h = 1;\n");
  });

  afterEach(async () => {
    await chmod(locked, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it("names the directory it could not read, and still returns what it could", async (t) => {
    if (!(await canLockADirectory())) return t.skip("permission bits not enforced here (root?)");
    await chmod(locked, 0o000);
    const { paths, unreadable } = discoverSourceFiles(root, "src");
    assert.deepStrictEqual(paths, ["src/open/a.ts"], "the readable half is still returned");
    assert.deepStrictEqual(unreadable, ["src/locked"], "and the unreadable half is NAMED");
  });

  it("surfaces it on the scope verdict, so the score is not published bare", async (t) => {
    if (!(await canLockADirectory())) return t.skip("permission bits not enforced here (root?)");
    await chmod(locked, 0o000);
    const result = analyze({ root, registry: { features: {} }, srcDir: "src" });
    assert.deepStrictEqual(result.scope.unreadableDirs, ["src/locked"]);
    // The denominator really did shrink — which is exactly why it is disclosed.
    assert.equal(result.inScopeSourceCount, 1);
  });

  it("says nothing when every directory is readable", () => {
    const result = analyze({ root, registry: { features: {} }, srcDir: "src" });
    assert.equal(result.scope.unreadableDirs, undefined);
    assert.equal(result.inScopeSourceCount, 2, "both files are in scope when readable");
  });

  it("names the srcDir itself when that is what could not be read", async (t) => {
    if (!(await canLockADirectory())) return t.skip("permission bits not enforced here (root?)");
    const solo = await mkdtemp(join(tmpdir(), "codument-unreadable-root-"));
    const base = join(solo, "src");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "a.ts"), "export const a = 1;\n");
    try {
      await chmod(base, 0o000);
      const { paths, unreadable } = discoverSourceFiles(solo, "src");
      assert.deepStrictEqual(paths, []);
      assert.deepStrictEqual(unreadable, ["src"]);
    } finally {
      await chmod(base, 0o755).catch(() => {});
      await rm(solo, { recursive: true, force: true });
    }
  });

  // The `|| "."` branch: reachable only when the walk root IS the project root,
  // i.e. a flat layout with no `src/` (the default srcDir fallback) whose root
  // cannot be read. relative(root, root) is "" and must not report an empty path.
  it("names the project root as '.' when the walk root is the root itself", async (t) => {
    if (!(await canLockADirectory())) return t.skip("permission bits not enforced here (root?)");
    const flat = await mkdtemp(join(tmpdir(), "codument-unreadable-flat-"));
    try {
      await writeFile(join(flat, "a.ts"), "export const a = 1;\n");
      await chmod(flat, 0o000);
      const { paths, unreadable } = discoverSourceFiles(flat, ".");
      assert.deepStrictEqual(paths, []);
      assert.deepStrictEqual(unreadable, ["."], "never an empty-string path");
    } finally {
      await chmod(flat, 0o755).catch(() => {});
      await rm(flat, { recursive: true, force: true });
    }
  });

  // The sibling walker the first fix left behind: the docs tree. Worse than a
  // shrunken ratio — a doc under an unreadable directory is invisible to
  // link-rot, which is a `warn` that gates --strict, so an actionable finding
  // would be suppressed without a trace.
  it("reports an unreadable docs subdirectory, which link-rot would otherwise miss", async (t) => {
    if (!(await canLockADirectory())) return t.skip("permission bits not enforced here (root?)");
    const lockedDocs = join(root, "docs", "private");
    await mkdir(lockedDocs, { recursive: true });
    await writeFile(join(lockedDocs, "note.md"), "[gone](../nowhere.md)\n");
    try {
      await chmod(lockedDocs, 0o000);
      const result = analyze({ root, registry: { features: {} }, srcDir: "src" });
      assert.ok(
        result.scope.unreadableDirs?.includes("docs/private"),
        `docs tree failure must be disclosed: ${JSON.stringify(result.scope.unreadableDirs)}`,
      );
    } finally {
      await chmod(lockedDocs, 0o755).catch(() => {});
    }
  });

  // Absent is not unreadable. Conflating them fires on every project without a
  // docs/ tree and on every ordinary mid-walk race, which would drown the signal
  // the disclosure exists to carry.
  it("says nothing about a directory that simply does not exist", () => {
    const result = analyze({ root, registry: { features: {} }, srcDir: "src" });
    assert.equal(result.scope.unreadableDirs, undefined, "no docs/ tree is not a failure");
    // And a srcDir that does not exist yields an empty walk, not a disclosure.
    const absent = discoverSourceFiles(root, "no-such-dir");
    assert.deepStrictEqual(absent, { paths: [], unreadable: [] });
  });

  it("merges the source walk and the docs walk into one sorted list", async (t) => {
    if (!(await canLockADirectory())) return t.skip("permission bits not enforced here (root?)");
    const lockedDocs = join(root, "docs", "private");
    await mkdir(lockedDocs, { recursive: true });
    try {
      await chmod(locked, 0o000);
      await chmod(lockedDocs, 0o000);
      const result = analyze({ root, registry: { features: {} }, srcDir: "src" });
      assert.deepStrictEqual(result.scope.unreadableDirs, ["docs/private", "src/locked"]);
    } finally {
      await chmod(lockedDocs, 0o755).catch(() => {});
    }
  });
});

// The dependency edges codument can derive from the import graph. A FLOOR, not
// the dependency set: import resolution finds only what is expressible as an
// import, so this never fabricates an edge to clear a finding.
describe("deriveDependencyEdges", () => {
  const src = (files: Record<string, string>) => (p: string) => files[p] ?? null;
  const reg = (features: Record<string, string[]>): [string, RegistryEntry][] =>
    Object.entries(features).map(([key, primary_sources]) => [
      key,
      {
        doc: `docs/features/${key}.md`,
        type: "feature",
        primary_sources,
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      } as RegistryEntry,
    ]);

  it("derives an edge when one entry's source imports another entry's source", () => {
    const edges = deriveDependencyEdges(
      reg({ app: ["src/app.ts"], money: ["src/money.ts"] }),
      src({ "src/app.ts": `import { add } from "./money.js";`, "src/money.ts": "export const add = 1;" }),
    );
    assert.deepStrictEqual(edges.get("app"), ["money"]);
    assert.equal(edges.has("money"), false);
  });

  it("drops an edge to a file no entry owns, rather than inventing a target", () => {
    const edges = deriveDependencyEdges(
      reg({ app: ["src/app.ts"] }),
      src({ "src/app.ts": `import "./unregistered.js";` }),
    );
    assert.equal(edges.size, 0);
  });

  it("drops a self-edge between two sources of the same feature", () => {
    const edges = deriveDependencyEdges(
      reg({ app: ["src/app.ts", "src/helper.ts"] }),
      src({ "src/app.ts": `import "./helper.js";`, "src/helper.ts": "" }),
    );
    assert.equal(edges.size, 0);
  });

  it("reports every owner of a shared source, not an arbitrary first one", () => {
    const edges = deriveDependencyEdges(
      reg({ app: ["src/app.ts"], a: ["src/shared.ts"], b: ["src/shared.ts"] }),
      src({ "src/app.ts": `import "./shared.js";`, "src/shared.ts": "" }),
    );
    assert.deepStrictEqual(edges.get("app"), ["a", "b"]);
  });

  it("skips a source it cannot read instead of throwing", () => {
    const edges = deriveDependencyEdges(reg({ app: ["src/gone.ts"] }), src({}));
    assert.equal(edges.size, 0);
  });

  it("is deterministic: edges come back sorted regardless of entry order", () => {
    const files = src({
      "src/app.ts": `import "./z.js";\nimport "./a.js";`,
      "src/z.ts": "",
      "src/a.ts": "",
    });
    const one = deriveDependencyEdges(reg({ app: ["src/app.ts"], zed: ["src/z.ts"], ay: ["src/a.ts"] }), files);
    const two = deriveDependencyEdges(reg({ zed: ["src/z.ts"], ay: ["src/a.ts"], app: ["src/app.ts"] }), files);
    assert.deepStrictEqual(one.get("app"), ["ay", "zed"]);
    assert.deepStrictEqual(one.get("app"), two.get("app"));
  });
});

// The real variant of the "fabricated edge" risk. `resolveSpecifier` guesses
// `.ts` for an extensionless specifier and never tries an index file, so a
// directory-style import resolves to a path that does not exist. An entry that
// CLAIMS that path (a stale source, which `missing-source` reports separately)
// must not collect a confident edge to a file nobody imports.
describe("deriveDependencyEdges never invents an edge from a resolution guess", () => {
  const entry = (primary_sources: string[]): RegistryEntry =>
    ({
      doc: "docs/x.md",
      type: "feature",
      primary_sources,
      related_sources: [],
      docs: [],
      depends_on: [],
      risk: [],
      status: "current",
    }) as RegistryEntry;

  it("drops the edge when the guessed target does not exist, even if an entry claims it", () => {
    const registry: [string, RegistryEntry][] = [
      ["app", entry(["src/app.ts"])],
      // Claims src/config.ts, which is not on disk — the guess would land here.
      ["ghost", entry(["src/config.ts"])],
    ];
    const files: Record<string, string> = {
      "src/app.ts": `import { settings } from "./config";`,
    };

    const edges = deriveDependencyEdges(registry, (p) => files[p] ?? null);
    assert.equal(edges.size, 0, "a guess that landed on a nonexistent file is not an edge");
  });

  it("still derives the edge when the guessed target really exists", () => {
    const registry: [string, RegistryEntry][] = [
      ["app", entry(["src/app.ts"])],
      ["config", entry(["src/config.ts"])],
    ];
    const files: Record<string, string> = {
      "src/app.ts": `import { settings } from "./config";`,
      "src/config.ts": `export const settings = 1;`,
    };

    assert.deepStrictEqual(deriveDependencyEdges(registry, (p) => files[p] ?? null).get("app"), [
      "config",
    ]);
  });
});

// Step 5 wiring: the finding answers its own question in place. Same id, same
// severity, same firing conditions — only the message and evidence gain the
// edges codument could derive.
describe("empty-depends-on carries the derived edges as evidence", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-derive-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "docs", "features"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (rel: string, body: string) => {
    await writeFile(join(root, rel), body);
  };
  const doc = async (slug: string) =>
    write(`docs/features/${slug}.md`, `# ${slug}\n\n## In plain terms\n\nreal doc.\n`);

  it("names the derivable edges as a floor, without changing the finding's id or severity", async () => {
    await write("src/app.ts", `import { add } from "./money.js";\nexport const run = () => add;\n`);
    await write("src/money.ts", `export const add = 1;\n`);
    await doc("app");
    await doc("money");
    await write(
      "docs/.registry.json",
      JSON.stringify({
        features: {
          app: { doc: "docs/features/app.md", type: "feature", primary_sources: ["src/app.ts"], related_sources: [], docs: [], depends_on: [], risk: [], status: "current" },
          money: { doc: "docs/features/money.md", type: "feature", primary_sources: ["src/money.ts"], related_sources: [], docs: [], depends_on: [], risk: [], status: "current" },
        },
      }),
    );

    const registry = await readRegistry(join(root, "docs", ".registry.json"));
    const report = analyze({ root, registry, srcDir: "src" });
    const finding = report.lint.find((f) => f.id === "empty-depends-on" && f.feature === "app");
    assert.ok(finding, "app still trips empty-depends-on — when it fires is unchanged");
    assert.equal(finding.severity, "warn");
    assert.deepStrictEqual(finding.evidence, ["money"]);
    assert.match(finding.message, /floor/);
    assert.match(finding.message, /money/);
  });

  it("leaves the message and shape untouched when nothing can be derived", async () => {
    await write("src/lonely.ts", `export const x = 1;\n`);
    await doc("lonely");
    await write(
      "docs/.registry.json",
      JSON.stringify({
        features: {
          lonely: { doc: "docs/features/lonely.md", type: "feature", primary_sources: ["src/lonely.ts"], related_sources: [], docs: [], depends_on: [], risk: [], status: "current" },
        },
      }),
    );

    const registry = await readRegistry(join(root, "docs", ".registry.json"));
    const report = analyze({ root, registry, srcDir: "src" });
    const finding = report.lint.find((f) => f.id === "empty-depends-on");
    assert.ok(finding);
    assert.equal(finding.evidence, undefined, "no evidence key at all, so --json stays byte-identical");
    assert.equal(finding.message, "lonely: mature entry has empty depends_on");
  });
});
