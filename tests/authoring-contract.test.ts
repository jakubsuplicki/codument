import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeatureMap } from "../src/lib/feature-map.js";
import { materializeFile } from "../src/commands/map.js";
import { analyze } from "../src/lib/analyze.js";
import {
  readRegistry,
  readRegistrySync,
  updateRegistryEntry,
  ExcludedSourceError,
} from "../src/lib/registry.js";

// The end-to-end walk the per-seam tests cannot cover: author → refuse → lint →
// derive, on ONE registry. Each seam is pinned in isolation elsewhere; this
// checks they meet.
//
// Self-contained by construction. It builds its own project in a temp dir and
// references nothing outside this repository, so it runs identically on any
// host — the reason it is a fixture here rather than a replay of the field
// project that motivated the plan.
describe("the authoring contract, end to end", () => {
  let root: string;

  // A two-hop import chain plus the test file that must never enter the
  // registry: app → settlement → money.
  const MAP = parseFeatureMap(
    [
      "```feature-map",
      "src/money.ts       | money       | feature | rounding rules",
      "src/settlement.ts  | settlement  | feature | who owes whom",
      "src/app.ts         | app         | feature | entry point",
      "src/money.test.js  | money       | feature | the suite for money",
      "```",
      "",
    ].join("\n"),
  ).rows;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-authoring-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }));

    await writeFile(join(root, "src", "money.ts"), "export const round = (n: number) => n;\n");
    await writeFile(
      join(root, "src", "settlement.ts"),
      'import { round } from "./money.js";\nexport const settle = () => round(1);\n',
    );
    await writeFile(
      join(root, "src", "app.ts"),
      'import { settle } from "./settlement.js";\nexport const run = () => settle();\n',
    );
    // The file the loop used to author into the registry unchallenged.
    await writeFile(join(root, "src", "money.test.js"), 'test("rounds", () => {});\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const registryPath = () => join(root, "docs", ".registry.json");

  it("authors the real sources, refuses the test file, and derives the chain the imports describe", async () => {
    // ── Author ──────────────────────────────────────────────────────────
    for (const file of ["src/money.ts", "src/settlement.ts", "src/app.ts"]) {
      assert.equal(materializeFile(root, MAP, file).status, "created", `${file} materializes`);
    }

    // ── Refuse ──────────────────────────────────────────────────────────
    // The Map deliberately routes a test file to a real feature. Routing is not
    // an exemption from the scope contract, and the refusal says which rule.
    assert.throws(
      () => materializeFile(root, MAP, "src/money.test.js"),
      (err: unknown) =>
        err instanceof ExcludedSourceError &&
        err.rule === null &&
        /built-in/.test(err.message),
      "a Map row cannot smuggle a test file into the registry",
    );

    // The refusal left nothing behind, and did not damage the entry it targeted.
    const afterRefusal = readRegistrySync(registryPath());
    assert.deepStrictEqual(
      afterRefusal.features.money.primary_sources,
      ["src/money.ts"],
      "the refused path is absent and the real source survived",
    );

    // ── Lint ────────────────────────────────────────────────────────────
    // Entries are born needs-review (in-flight, and exempt from the dependency
    // nag). Promote them to the state a reviewed project is actually in, which
    // is where the finding — and the derivation — matter.
    for (const key of ["money", "settlement", "app"]) {
      updateRegistryEntry(registryPath(), key, { status: "current" });
      await writeFile(
        join(root, "docs", "features", `${key}.md`),
        `# ${key}\n\n## In plain terms\n\nWhat ${key} is for.\n`,
      );
    }

    const registry = await readRegistry(registryPath());
    const report = analyze({ root, registry, srcDir: "src" });

    // The lint the field project tripped is silent: no registered source is
    // out of scope, because authoring would not accept one.
    assert.equal(
      report.lint.filter((f) => f.id === "generated-leakage").length,
      0,
      "no out-of-scope source can be present to leak",
    );

    // ── Derive ──────────────────────────────────────────────────────────
    const edgesFor = (feature: string): string[] | undefined =>
      report.lint.find((f) => f.id === "empty-depends-on" && f.feature === feature)?.evidence;

    assert.deepStrictEqual(edgesFor("app"), ["settlement"], "app's import is answered");
    assert.deepStrictEqual(edgesFor("settlement"), ["money"], "the second hop is answered too");

    // money imports nothing, so there is nothing to derive — and the floor says
    // so by staying quiet rather than inventing an edge to look complete. Assert
    // the finding IS present first, or "no evidence" would pass vacuously on a
    // finding that never fired.
    const moneyFinding = report.lint.find(
      (f) => f.id === "empty-depends-on" && f.feature === "money",
    );
    assert.ok(moneyFinding, "money still trips the finding — deriving nothing is not an exemption");
    assert.equal(moneyFinding.evidence, undefined, "a true leaf derives nothing");
  });

  it("keeps a registry that already names a test file readable, so the lint can report it", async () => {
    // The other half of the plan's decision: authoring is strict, reading is
    // tolerant. A project that arrived with a bad entry must still be
    // diagnosable, or the lint could never tell anyone what is wrong.
    await writeFile(
      registryPath(),
      JSON.stringify({
        features: {
          money: {
            doc: "docs/features/money.md",
            type: "feature",
            primary_sources: ["src/money.ts", "src/money.test.js"],
            related_sources: [],
            docs: [],
            depends_on: [],
            risk: [],
            status: "current",
          },
        },
      }),
    );
    await writeFile(join(root, "docs", "features", "money.md"), "# money\n\n## In plain terms\n\nx\n");

    const registry = await readRegistry(registryPath());
    assert.ok(
      registry.features.money.primary_sources.includes("src/money.test.js"),
      "the bad entry loads rather than throwing",
    );

    const report = analyze({ root, registry, srcDir: "src" });
    assert.ok(
      report.lint.some((f) => f.id === "generated-leakage" && f.file === "src/money.test.js"),
      "and doctor still reports it, which is the point of staying tolerant",
    );

    // Repairing it is possible: dropping the test file is not itself an
    // authoring act that the guard refuses.
    updateRegistryEntry(registryPath(), "money", { primary_sources: ["src/money.ts"] });
    assert.deepStrictEqual(readRegistrySync(registryPath()).features.money.primary_sources, [
      "src/money.ts",
    ]);
  });

  it("strands no scaffold for a feature the refusal prevented from existing", () => {
    const orphanMap = parseFeatureMap(
      "```feature-map\nsrc/money.test.js | brand-new | feature | never adopted\n```\n",
    ).rows;

    assert.throws(() => materializeFile(root, orphanMap, "src/money.test.js"));

    assert.equal(
      existsSync(join(root, "docs", "features", "brand-new.md")),
      false,
      "no doc for a feature that was never registered",
    );
    assert.deepStrictEqual(Object.keys(readRegistrySync(registryPath()).features), []);
  });
});
