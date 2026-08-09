import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeatureMap } from "../src/lib/feature-map.js";
import { materializeFile, materializeFileTo, shapeWarnings } from "../src/commands/map.js";
import { readRegistrySync, ExcludedSourceError } from "../src/lib/registry.js";

const MAP_MD = `
\`\`\`feature-map
src/fairness.ts | fairness  | feature | provably-fair engine
src/board.ts    | board     | feature | canvas render
src/main.ts     | app-shell | feature | DOM wiring  [secondary: board]
\`\`\`
`;

const rows = parseFeatureMap(MAP_MD).rows;

describe("materializeFile", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map-"));
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }, null, 2));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a new feature entry + a scaffold doc seeded from the responsibility", async () => {
    const r = materializeFile(root, rows, "src/fairness.ts");
    assert.equal(r.status, "created");
    assert.equal(r.feature, "fairness");

    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.ok(reg.features.fairness, "entry created");
    assert.deepEqual(reg.features.fairness.primary_sources, ["src/fairness.ts"]);
    assert.equal(reg.features.fairness.status, "needs-review");
    assert.equal(reg.features.fairness.type, "feature");

    const doc = await readFile(join(root, "docs", "features", "fairness.md"), "utf-8");
    assert.match(doc, /provably-fair engine/, "In plain terms seeded from responsibility");
    assert.match(doc, /status: needs-review/);
  });

  it("is idempotent — a second run on the same file is a noop", () => {
    materializeFile(root, rows, "src/fairness.ts");
    const again = materializeFile(root, rows, "src/fairness.ts");
    assert.equal(again.status, "noop");
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(reg.features.fairness.primary_sources, ["src/fairness.ts"]);
  });

  it("appends a second owned file to an existing feature", () => {
    // Two files mapped to the same feature would need a glob row; simulate by
    // re-routing board.ts then a hand-added second primary via the same key.
    materializeFile(root, rows, "src/board.ts");
    const twoFileRows = parseFeatureMap(
      "```feature-map\nsrc/board.ts | board | feature | r\nsrc/board-extra.ts | board | feature | r\n```\n",
    ).rows;
    const r = materializeFile(root, twoFileRows, "src/board-extra.ts");
    assert.equal(r.status, "updated");
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(reg.features.board.primary_sources.sort(), ["src/board-extra.ts", "src/board.ts"]);
  });

  it("routes a secondary feature into the secondary's related_sources (when it exists)", () => {
    materializeFile(root, rows, "src/board.ts"); // board now exists
    const r = materializeFile(root, rows, "src/main.ts");
    assert.equal(r.feature, "app-shell");
    assert.deepEqual(r.secondaryUpdated, ["board"]);
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.ok(reg.features.board.related_sources.includes("src/main.ts"));
  });

  it("does not write an unmapped file", () => {
    const r = materializeFile(root, rows, "src/unknown.ts");
    assert.equal(r.status, "unmapped");
    assert.equal(r.feature, null);
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(Object.keys(reg.features), []);
    assert.equal(existsSync(join(root, "docs", "features", "unknown.md")), false);
  });

  // ADVERSARIAL REVIEW FINDING (confirmed): registry.ts's new authoring guard
  // (Step 2) can now make `updateRegistryEntry` throw for a brand-new feature
  // key. `materializeFile`'s "create" branch writes the doc scaffold to disk
  // BEFORE calling `updateRegistryEntry` and has no rollback, so a refused
  // first-time file leaves an orphaned, unregistered doc scaffold behind — a
  // new-feature doc with no registry entry, and no clean way to detect it was
  // never actually adopted. This is a genuine sibling-caller regression: the
  // guard change in registry.ts fixed the write seam but exposed an unguarded
  // ordering bug in this existing (unchanged) caller.
  it("does not leave an orphaned doc scaffold when materializing a brand-new feature's excluded first file", () => {
    const excludedRows = parseFeatureMap(
      "```feature-map\nsrc/thing.test.js | thing | feature | r\n```\n",
    ).rows;

    assert.throws(() => materializeFile(root, excludedRows, "src/thing.test.js"));

    // Refused entries should leave no trace: no registry entry (true today)
    // AND no stray scaffold doc for a feature that doesn't exist (false today).
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(Object.keys(reg.features), []);
    assert.equal(existsSync(join(root, "docs", "features", "thing.md")), false);
  });
});

// Naming WHICH rule fired. A project's own declaration and a built-in heuristic
// call for different responses — "un-map it or narrow your declaration" versus
// "codument's guess may be wrong about your file" — and one generic refusal
// sends both to the same dead end.
// Plan 41: a plan's Feature Map is compacted out of its doc when the work ships
// (the standard requires it), which left every LATER file addition or rename on a
// refusal pointing at a plan that no longer carries a Map — two mandated behaviors
// disabling each other, with a hand-edited registry as the only way out.
describe("materializeFileTo (the post-ship route)", () => {
  let root: string;
  const registry = {
    features: {
      i18n: {
        doc: "docs/features/i18n.md",
        type: "feature",
        primary_sources: ["i18n/index.ts"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      },
    },
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map2-"));
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify(registry, null, 2));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("adds the file to a named existing feature, with no plan in the loop", () => {
    const r = materializeFileTo(root, "i18n/dateFormat.ts", "i18n");
    assert.equal(r.status, "updated");
    assert.equal(r.feature, "i18n");
    assert.deepEqual(readRegistrySync(join(root, "docs", ".registry.json")).features.i18n.primary_sources, [
      "i18n/dateFormat.ts",
      "i18n/index.ts",
    ]);
  });

  // Plan 36: the moment a second feature claims a file is the moment the churn is
  // created — from then on every edit wakes both docs until the registry says who
  // owns what. It used to pass in silence, so the bill only arrived later, at a red
  // gate, in front of someone who did not know a second claim had been added.
  describe("the second primary claim is where the churn starts, so it says so", () => {
    const claim = (key: string, patch: Record<string, unknown> = {}) => ({
      doc: `docs/features/${key}.md`,
      type: "feature",
      primary_sources: [],
      related_sources: [],
      docs: [],
      depends_on: [],
      risk: [],
      status: "current",
      ...patch,
    });
    const write = async (features: Record<string, unknown>): Promise<void> => {
      await writeFile(
        join(root, "docs", ".registry.json"),
        JSON.stringify({ features }, null, 2),
      );
    };

    it("warns naming every owner once a second feature claims the file", async () => {
      await write({
        cart: claim("cart", { primary_sources: ["src/shared.ts"] }),
        checkout: claim("checkout"),
      });
      const r = materializeFileTo(root, "src/shared.ts", "checkout");
      assert.equal(r.status, "updated");
      assert.deepEqual(r.sharedPrimary, ["cart", "checkout"]);
    });

    it("stays silent on the FIRST claim — one owner is the resolved state", async () => {
      await write({ cart: claim("cart"), checkout: claim("checkout") });
      assert.deepEqual(materializeFileTo(root, "src/solo.ts", "cart").sharedPrimary, []);
    });

    it("stays silent when the split is already authored", async () => {
      // A deliberate multi-owner file whose symbols are claimed is not churn — it
      // is exactly the fix the warning asks for, so warning about it would train
      // the reader to ignore the one case that matters.
      await write({
        cart: claim("cart", {
          primary_sources: ["src/shared.ts"],
          owned_symbols: { "src/shared.ts": ["priceOf()."] },
        }),
        checkout: claim("checkout"),
      });
      assert.deepEqual(materializeFileTo(root, "src/shared.ts", "checkout").sharedPrimary, []);
    });

    it("does not count a concept umbrella as a competing owner", async () => {
      // A concept co-documents at file grain and never fragments per-symbol
      // ownership, so a file owned by one feature plus any number of umbrellas
      // still resolves derived — no churn, nothing to warn about.
      await write({
        cart: claim("cart"),
        lib: { ...claim("lib"), type: "concept", primary_sources: ["src/shared.ts"] },
      });
      assert.deepEqual(materializeFileTo(root, "src/shared.ts", "cart").sharedPrimary, []);
    });
  });

  it("is idempotent — a file already owned is a noop, never a duplicate", () => {
    assert.equal(materializeFileTo(root, "i18n/index.ts", "i18n").status, "noop");
    assert.deepEqual(readRegistrySync(join(root, "docs", ".registry.json")).features.i18n.primary_sources, [
      "i18n/index.ts",
    ]);
  });

  it("refuses an unknown slug rather than inventing a feature", () => {
    // Creating one needs a responsibility line to seed its doc — exactly what a
    // Map row carries and a bare flag cannot. New features are new work, and new
    // work gets a plan.
    const r = materializeFileTo(root, "src/x.ts", "nope");
    assert.equal(r.status, "unknown-feature");
    assert.equal(r.feature, null);
    assert.deepEqual(Object.keys(readRegistrySync(join(root, "docs", ".registry.json")).features), [
      "i18n",
    ]);
  });

  it("still refuses an excluded path — the explicit route is not a way around scope", () => {
    assert.throws(
      () => materializeFileTo(root, "dist/bundle.js", "i18n"),
      ExcludedSourceError,
    );
  });
});

describe("materializeFile names the rule that refused a path", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map-rule-"));
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }, null, 2));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const excludedRows = parseFeatureMap(
    "```feature-map\nsrc/thing.test.js | thing | feature | r\nout/bundle.ts | bundled | feature | r\n```\n",
  ).rows;

  it("cites the built-in rule when no project declaration covers the path", () => {
    assert.throws(
      () => materializeFile(root, excludedRows, "src/thing.test.js"),
      (err: unknown) =>
        err instanceof ExcludedSourceError &&
        err.rule === null &&
        /built-in/.test(err.message),
    );
  });

  it("cites the project's own exclude rule when its declaration is what covers the path", async () => {
    await writeFile(
      join(root, ".codument-meta.json"),
      JSON.stringify({ exclude: { dirs: ["out"] } }, null, 2),
    );

    assert.throws(
      () => materializeFile(root, excludedRows, "out/bundle.ts"),
      (err: unknown) =>
        err instanceof ExcludedSourceError &&
        err.rule === "dirs: out" &&
        /project's own/.test(err.message),
    );
  });

  // The functional half: before this, materialize passed no spec, so ONLY the
  // built-in defaults reached the authoring guard and a project's own declared
  // exclusions were silently authorable.
  it("enforces a project declaration the built-in spec would have allowed", async () => {
    const declaredRows = parseFeatureMap(
      "```feature-map\npublic-preprod/app.ts | site | feature | r\n```\n",
    ).rows;

    // Without the declaration the path is ordinary source and materializes fine.
    assert.equal(materializeFile(root, declaredRows, "public-preprod/app.ts").status, "created");

    await rm(join(root, "docs", ".registry.json"));
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }, null, 2));
    await writeFile(
      join(root, ".codument-meta.json"),
      JSON.stringify({ exclude: { dirs: ["public-preprod"] } }, null, 2),
    );

    assert.throws(
      () => materializeFile(root, declaredRows, "public-preprod/app.ts"),
      (err: unknown) => err instanceof ExcludedSourceError,
    );
  });

  // ADVERSARIAL REVIEW FINDING (confirmed, Step 3): `register()` in map.ts
  // enriches a refusal by calling `declaredRuleFor(err.path, scope.configured)`
  // — but `err.path` is the RAW, as-typed source string `assertNoExcludedSource`
  // was given (registry.ts throws with `source`, not the normalized `stored`
  // path it actually tested exclusion against). `declaredRuleFor` normalizes
  // only via `toPosix` (separator swap), never `normalizeRelPath` (which also
  // strips a leading "./"), so a source whose text carries a leading "./" —
  // a plausible Feature Map authoring style, and legal input to the exported,
  // directly-tested `materializeFile` — is genuinely excluded by the project's
  // OWN declared glob (confirmed: `isExcluded` matches on the normalized form),
  // yet `declaredRuleFor`'s glob regex is anchored (`^pattern$`) and does not
  // match the unnormalized "./..." string, so it returns null and the refusal
  // is misattributed to "a built-in exclusion rule" — an actively false claim
  // that sends the user down the wrong remediation path ("codument's guess may
  // be wrong about your file" instead of "un-map it, or narrow the
  // declaration"). This is worse than naming neither rule: it names the wrong
  // one. Root cause: `register()` (map.ts) hands the unnormalized `err.path`
  // to `declaredRuleFor` instead of the normalized form the exclusion check
  // itself used.
  it("does not misattribute a project-declared glob exclusion as built-in when the source path carries a leading './'", () => {
    // Both the Map row and the materialized file carry the same leading "./"
    // (either an authoring convention in the plan doc, or a caller of the
    // exported materializeFile() that does not pre-normalize like the CLI's
    // toRepoRel() does) so exact-path routing still resolves to a real row.
    const dotSlashRows = parseFeatureMap(
      "```feature-map\n./public-preprod/app.ts | site | feature | r\n```\n",
    ).rows;

    return writeFile(
      join(root, ".codument-meta.json"),
      JSON.stringify({ exclude: { globs: ["public-preprod/**"] } }, null, 2),
    ).then(() => {
      assert.throws(
        () => materializeFile(root, dotSlashRows, "./public-preprod/app.ts"),
        (err: unknown) => {
          assert.ok(err instanceof ExcludedSourceError, `expected ExcludedSourceError, got ${err}`);
          // The project's own declared glob is genuinely what covers this path;
          // the refusal must say so, not blame a generic built-in heuristic.
          assert.equal(
            (err as ExcludedSourceError).rule,
            "globs: public-preprod/**",
            `expected attribution to the project's own declared glob, got rule=${
              (err as ExcludedSourceError).rule
            } message=${(err as ExcludedSourceError).message}`,
          );
          assert.ok(/project's own/.test((err as ExcludedSourceError).message));
          return true;
        },
      );
    });
  });
});

describe("shapeWarnings", () => {
  it("flags a single-row Feature Map", () => {
    const w = shapeWarnings(parseFeatureMap("```feature-map\nsrc/** | app | feature | the app\n```\n"));
    assert.ok(w.some((x) => /single row/.test(x.message)));
    assert.ok(w.some((x) => /umbrella glob/.test(x.message)));
  });

  it("is quiet on a well-decomposed Map", () => {
    assert.deepEqual(shapeWarnings(parseFeatureMap(MAP_MD)), []);
  });
});

// Plan 43 step 4: registering a tree is what makes the per-file line unnecessary.
// Materializing a file the tree already covers would grow those lines back one
// accidental call at a time — and the refusal is the only moment anyone learns the
// registration is doing its job.
describe("materialize refuses a file a tree already governs (plan 43)", () => {
  let root: string;
  const TREE = "i18n/locales/**/*.json";
  const FILE = "i18n/locales/fi/common.json";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map-tree-"));
    await mkdir(join(root, "docs", "concepts"), { recursive: true });
    await writeFile(
      join(root, "docs", ".registry.json"),
      JSON.stringify(
        {
          features: {
            i18n: {
              doc: "docs/concepts/i18n.md",
              type: "concept",
              primary_sources: [TREE],
              status: "current",
            },
            other: {
              doc: "docs/concepts/other.md",
              type: "concept",
              primary_sources: ["src/other.ts"],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const sources = (key: string): string[] =>
    readRegistrySync(join(root, "docs", ".registry.json")).features[key].primary_sources;

  it("names the governing entry and writes nothing, on the explicit route", () => {
    const r = materializeFileTo(root, FILE, "other");
    assert.equal(r.status, "governed");
    assert.deepEqual(r.governedBy, { feature: "i18n", pattern: TREE });
    assert.deepEqual(sources("other"), ["src/other.ts"], "no second claim was written");
    assert.deepEqual(sources("i18n"), [TREE], "and the tree did not grow a path");
  });

  it("refuses the tree's OWN entry too — the line would only restate the pattern", () => {
    const r = materializeFileTo(root, FILE, "i18n");
    assert.equal(r.status, "governed");
    assert.deepEqual(sources("i18n"), [TREE]);
  });

  it("refuses on the Map route as well, before any write", () => {
    const mapRows = parseFeatureMap(
      "```feature-map\ni18n/locales/** | i18n | concept | translations\n```",
    ).rows;
    const r = materializeFile(root, mapRows, FILE);
    assert.equal(r.status, "governed");
    assert.deepEqual(r.governedBy, { feature: "i18n", pattern: TREE });
    assert.deepEqual(sources("i18n"), [TREE]);
  });

  it("a file OUTSIDE the tree materializes normally", () => {
    const r = materializeFileTo(root, "src/elsewhere.ts", "other");
    assert.equal(r.status, "updated");
    assert.deepEqual(sources("other").sort(), ["src/elsewhere.ts", "src/other.ts"]);
  });
});
