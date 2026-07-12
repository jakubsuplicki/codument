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
