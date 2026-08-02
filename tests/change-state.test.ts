import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeChangeState,
  detectApprovedPlanScope,
} from "../src/lib/change-state.js";
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

// The "messy AI change" the change-control fixture's changes/ overlay represents.
const CHANGED = [
  "src/auth/login.ts",
  "src/lib/db.ts",
  "src/lib/cache.ts",
  "src/lib/ratelimit.ts",
  "src/tasks/tasks.ts",
  "docs/features/tasks.md",
];
// Approved plan: docs/plans/add-rate-limiting.md
const PLAN_SCOPE = ["src/lib/ratelimit.ts", "src/auth/login.ts"];

async function state(extra: { planScope?: string[] } = {}) {
  const registry = await readRegistry(join(FIXTURE, "docs", ".registry.json"));
  return computeChangeState({ registry, changedFiles: CHANGED, ...extra });
}

describe("computeChangeState (change-control fixture diff)", () => {
  it("groups changed sources by owning feature", async () => {
    const s = await state();
    const byFeature = Object.fromEntries(s.byFeature.map((g) => [g.feature, g.files]));
    assert.deepStrictEqual(byFeature["auth"], ["src/auth/login.ts", "src/lib/db.ts"]);
    assert.ok(byFeature["db"].includes("src/lib/db.ts"));
    assert.ok(byFeature["tasks"].includes("src/tasks/tasks.ts"));
  });

  it("flags stale-auth and stale-db, but tasks is clean (positive control)", async () => {
    const s = await state();
    const stale = s.staleDocs.map((d) => d.feature).sort();
    assert.ok(stale.includes("auth"), "stale-auth");
    assert.ok(stale.includes("db"), "stale-db");
    assert.ok(!stale.includes("tasks"), "tasks changed with its doc → not stale");
  });

  it("flags unmapped changes (cache + ratelimit have no owner)", async () => {
    const s = await state();
    assert.deepStrictEqual(s.unmapped, [
      "src/lib/cache.ts",
      "src/lib/ratelimit.ts",
    ]);
  });

  it("buckets config/asset changes into otherChanged, but drops excluded paths", async () => {
    const registry = await readRegistry(join(FIXTURE, "docs", ".registry.json"));
    const s = computeChangeState({
      registry,
      changedFiles: [
        "src/lib/db.ts", // source
        "docs/features/tasks.md", // doc
        "app.json", // other (config)
        "assets/logo.png", // other (asset)
        "dist/bundle.js", // excluded build output → dropped everywhere
      ],
    });
    assert.deepStrictEqual(s.otherChanged, ["app.json", "assets/logo.png"]);
    // Excluded build output is not source, not docs, and not "other" — consistent
    // with how unmapped/coverage treat it (so it can't inflate the verdict count).
    assert.ok(!s.otherChanged.includes("dist/bundle.js"), "excluded path not in otherChanged");
    assert.ok(!s.changedSources.includes("app.json"), "app.json is not source");
    // The four non-excluded inputs partition cleanly into source/docs/other.
    assert.equal(s.changedSources.length + s.changedDocs.length + s.otherChanged.length, 4);
  });

  it("flags the high-risk touch (auth) and the high-fanout file (db)", async () => {
    const s = await state();
    const riskFeatures = s.riskTouches.map((r) => r.feature).sort();
    assert.ok(riskFeatures.includes("auth"));
    assert.ok(riskFeatures.includes("db"));

    const fanout = s.highFanout.find((f) => f.file === "src/lib/db.ts");
    assert.ok(fanout);
    assert.deepStrictEqual(fanout?.features, ["auth", "db", "tasks"]);
  });

  it("flags dependents of the changed db feature (auth, tasks)", async () => {
    const s = await state();
    const deps = s.dependents
      .filter((d) => d.dependsOn === "db")
      .map((d) => d.feature)
      .sort();
    assert.deepStrictEqual(deps, ["auth", "tasks"]);
  });

  it("flags out-of-plan changes when a plan scope is provided", async () => {
    const s = await state({ planScope: PLAN_SCOPE });
    assert.equal(s.planScoped, true);
    // db.ts, cache.ts, tasks.ts are outside the rate-limiting plan scope
    assert.deepStrictEqual(s.outOfPlan, [
      "src/lib/cache.ts",
      "src/lib/db.ts",
      "src/tasks/tasks.ts",
    ]);
  });

  it("is deterministic", async () => {
    assert.deepStrictEqual(await state({ planScope: PLAN_SCOPE }), await state({ planScope: PLAN_SCOPE }));
  });
});

// ── File-grain acknowledgment honoring (the conservative property) ──────────
//
// Pure golden tests over synthetic anchor changes: the `fileGrainAcked` set clears
// additive / concept / coarse staleness but NEVER an unacknowledged moved symbol.

import type { Registry, RegistryEntry } from "../src/lib/registry.js";
import type { AnchorChange } from "../src/lib/fingerprint.js";

function fgEntry(partial: Partial<RegistryEntry>): RegistryEntry {
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

// alpha owns src/a.ts per-symbol; lib is a concept umbrella over the same file.
const FG_REGISTRY: Registry = {
  features: {
    alpha: fgEntry({ doc: "docs/features/alpha.md", primary_sources: ["src/a.ts"] }),
    lib: fgEntry({ doc: "docs/concepts/lib.md", type: "concept", primary_sources: ["src/a.ts"] }),
  },
};

const changed = (from: string, to: string): AnchorChange => ({
  id: "src/a.ts::foo().",
  name: "foo",
  kind: "changed",
  from,
  to,
});
const added: AnchorChange = { id: "src/a.ts::bar().", name: "bar", kind: "added", to: "h_bar" };

function fgStale(
  anchorChanges: Record<string, AnchorChange[]>,
  fileGrainAcked?: string[],
): string[] {
  return computeChangeState({
    registry: FG_REGISTRY,
    changedFiles: ["src/a.ts"],
    anchorChanges,
    fileGrainAcked,
  })
    .staleDocs.map((d) => d.feature)
    .sort();
}

describe("computeChangeState — file-grain ack honoring", () => {
  it("clears an ADDITIVE (added symbol) feature wake when the file is file-grain acked", () => {
    // bar() was added; alpha wakes. Without a file ack it is stale; with one it clears.
    assert.deepStrictEqual(fgStale({ "src/a.ts": [added] }), ["alpha", "lib"]);
    assert.deepStrictEqual(fgStale({ "src/a.ts": [added] }, ["src/a.ts"]), []);
  });

  it("NEVER masks an unacknowledged moved (changed) symbol, even when file-grain acked", () => {
    // foo() moved (a real contract-changing anchor still in the filtered set = not
    // symbol-acked). alpha stays flagged despite the file ack; only the concept clears.
    assert.deepStrictEqual(fgStale({ "src/a.ts": [changed("h0", "h1")] }), ["alpha", "lib"]);
    assert.deepStrictEqual(fgStale({ "src/a.ts": [changed("h0", "h1")] }, ["src/a.ts"]), ["alpha"]);
  });

  it("clears the additive residue but keeps the moved symbol flagged (per-anchor, not whole-file)", () => {
    // A file with BOTH a moved foo() and an added bar(): alpha stays stale (foo), and
    // symbol-acking foo (dropping it from the filtered set) then lets the file ack
    // clear the additive residue.
    assert.deepStrictEqual(fgStale({ "src/a.ts": [changed("h0", "h1"), added] }, ["src/a.ts"]), [
      "alpha",
    ]);
    // foo symbol-acked → only the added bar() remains → file ack clears alpha too.
    assert.deepStrictEqual(fgStale({ "src/a.ts": [added] }, ["src/a.ts"]), []);
  });

  it("clears a CONCEPT umbrella's file-grain wake even when the file has a moved symbol", () => {
    // The concept (lib) wakes file-grain on any content move; a file ack clears that
    // contribution. The moved foo() still wakes its feature (alpha) — never masked.
    const s = fgStale({ "src/a.ts": [changed("h0", "h1")] }, ["src/a.ts"]);
    assert.ok(s.includes("alpha"), "moved symbol keeps its feature flagged");
    assert.ok(!s.includes("lib"), "concept file-grain wake cleared");
  });

  it("clears the COARSE / file-grain fallback wake (non-precise file, no anchor changes)", () => {
    // No anchorChanges entry for src/a.ts → the file-grain fallback wakes every
    // primary owner (alpha + concept lib). A file ack clears the whole fallback wake.
    assert.deepStrictEqual(fgStale({}), ["alpha", "lib"]);
    assert.deepStrictEqual(fgStale({}, ["src/a.ts"]), []);
  });

  it("is inert for a file with no covering ack (only the named file clears)", () => {
    // A file ack for some OTHER path does not clear src/a.ts.
    assert.deepStrictEqual(fgStale({ "src/a.ts": [added] }, ["src/other.ts"]), ["alpha", "lib"]);
  });
});

// ── Concept umbrella wakes off the PRE-ack-filter set (ADR-012) ──────────────
//
// A per-symbol ack adjudicates ONE feature contract; it must never clear the
// concept umbrella's file-grain flag. Only a file-grain ack (or a doc update)
// clears the concept residue.

describe("computeChangeState — concept umbrella vs per-symbol ack (ADR-012)", () => {
  const symbolAckedInput = {
    registry: FG_REGISTRY,
    changedFiles: ["src/a.ts"],
    // post-filter: the moved symbol was acknowledged (adjudicated) and dropped
    anchorChanges: { "src/a.ts": [] as AnchorChange[] },
    // pre-filter: the file's content genuinely moved
    contentMovedFiles: ["src/a.ts"],
  };

  it("a symbol ack clears the feature but NEVER the concept umbrella", () => {
    const s = computeChangeState(symbolAckedInput);
    assert.deepStrictEqual(
      s.staleDocs.map((d) => d.feature),
      ["lib"],
      "the umbrella still owes its file-grain narration",
    );
  });

  it("a file-grain ack is what clears the concept residue", () => {
    const s = computeChangeState({ ...symbolAckedInput, fileGrainAcked: ["src/a.ts"] });
    assert.deepStrictEqual(s.staleDocs, []);
  });

  it("a doc update clears it too", () => {
    const s = computeChangeState({
      ...symbolAckedInput,
      changedFiles: ["src/a.ts", "docs/concepts/lib.md"],
    });
    assert.deepStrictEqual(s.staleDocs, []);
  });

  it("a cosmetic-only change (empty pre-filter set) still wakes nothing", () => {
    const s = computeChangeState({ ...symbolAckedInput, contentMovedFiles: [] });
    assert.deepStrictEqual(s.staleDocs, []);
  });
});

// ── Deletions are first-class (ADR-012's conservative stance) ────────────────
//
// A deleted owned source wakes every primary owner at file grain; no ack clears
// it; a doc update — or the doc's own removal — is the only resolution; and
// removing the registry entry in the same change cannot dodge the wake.

function delState(input: {
  registry?: Registry;
  changedFiles?: string[];
  deletedFiles?: string[];
  baseRegistry?: Registry;
  fileGrainAcked?: string[];
}) {
  return computeChangeState({
    registry: input.registry ?? FG_REGISTRY,
    changedFiles: input.changedFiles ?? [],
    deletedFiles: input.deletedFiles,
    baseRegistry: input.baseRegistry,
    fileGrainAcked: input.fileGrainAcked,
  });
}

describe("computeChangeState — deletions first-class", () => {
  it("a deleted owned source wakes feature AND concept at file grain", () => {
    const s = delState({ deletedFiles: ["src/a.ts"] });
    assert.deepStrictEqual(
      s.staleDocs.map((d) => d.feature),
      ["alpha", "lib"],
    );
    assert.deepStrictEqual(s.deletedSources, ["src/a.ts"]);
    // the stale entry names the deleted file as what woke it
    assert.deepStrictEqual(s.staleDocs[0].changedSources, ["src/a.ts"]);
  });

  it("NO acknowledgment clears a deletion — a removal owes doc attention", () => {
    const s = delState({ deletedFiles: ["src/a.ts"], fileGrainAcked: ["src/a.ts"] });
    assert.deepStrictEqual(
      s.staleDocs.map((d) => d.feature),
      ["alpha", "lib"],
    );
  });

  it("a doc update in the same change resolves that owner's wake", () => {
    const s = delState({
      deletedFiles: ["src/a.ts"],
      changedFiles: ["docs/features/alpha.md"],
    });
    assert.deepStrictEqual(
      s.staleDocs.map((d) => d.feature),
      ["lib"],
      "alpha resolved by its doc update; the concept still owes attention",
    );
  });

  it("deleting the doc WITH the source counts as attention (wholesale removal is resolved)", () => {
    const s = delState({ deletedFiles: ["src/a.ts", "docs/features/alpha.md"] });
    assert.deepStrictEqual(
      s.staleDocs.map((d) => d.feature),
      ["lib"],
    );
  });

  it("removing the registry entry in the same change cannot dodge the wake (base registry rules)", () => {
    // Current registry no longer knows src/a.ts; the base registry did.
    const s = delState({
      registry: { features: {} },
      deletedFiles: ["src/a.ts"],
      baseRegistry: FG_REGISTRY,
    });
    assert.deepStrictEqual(
      s.staleDocs.map((d) => d.feature),
      ["alpha", "lib"],
      "the entries that owned the file at base still flag their docs",
    );
  });

  it("entry-removed AND doc-removed together read as a resolved wholesale removal", () => {
    const s = delState({
      registry: { features: { lib: FG_REGISTRY.features.lib } },
      deletedFiles: ["src/a.ts", "docs/features/alpha.md", "docs/concepts/lib.md"],
      baseRegistry: FG_REGISTRY,
    });
    assert.deepStrictEqual(s.staleDocs, []);
  });

  it("a deleted unregistered source is surfaced but wakes nothing", () => {
    const s = delState({ deletedFiles: ["src/orphan.ts"] });
    assert.deepStrictEqual(s.staleDocs, []);
    assert.deepStrictEqual(s.deletedSources, ["src/orphan.ts"]);
  });

  it("excluded and non-source deletions stay out of deletedSources", () => {
    const s = delState({ deletedFiles: ["dist/bundle.js", "notes.txt"] });
    assert.deepStrictEqual(s.deletedSources, []);
    assert.deepStrictEqual(s.staleDocs, []);
  });
});

describe("detectApprovedPlanScope (fixture plan)", () => {
  it("reads scope only from list items, not explanatory prose", () => {
    const plan = detectApprovedPlanScope(FIXTURE);
    assert.ok(plan, "approved plan detected");
    assert.equal(plan?.plan, "docs/plans/add-rate-limiting.md");
    // The Scope prose mentions db.ts/cache.ts/tasks.ts as OUT-of-plan examples;
    // they must not leak into the detected scope.
    assert.deepStrictEqual(plan?.scope, [
      "src/auth/login.ts",
      "src/lib/ratelimit.ts",
    ]);
  });

  it("end-to-end: db.ts is out-of-plan when scope is detected (not injected)", async () => {
    const plan = detectApprovedPlanScope(FIXTURE);
    const s = await state({ planScope: plan?.scope });
    assert.ok(s.outOfPlan.includes("src/lib/db.ts"), "db.ts is out-of-plan");
    assert.ok(s.outOfPlan.includes("src/lib/cache.ts"));
    assert.ok(s.outOfPlan.includes("src/tasks/tasks.ts"));
  });
});

describe("detectApprovedPlanScope — one approval predicate with steps", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-plan-approval-"));
    await mkdir(join(tmp, "docs", "plans"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const SCOPE = "\n## Scope\n\n- `src/lib/thing.ts`\n";

  async function plan(status: string, frontmatter: boolean) {
    const content = frontmatter
      ? `---\nstatus: ${status}\n---\n\n# P\n${SCOPE}`
      : `# P\n\nStatus: ${status}\n${SCOPE}`;
    await writeFile(join(tmp, "docs", "plans", "p.md"), content);
  }

  it("an explicitly rejected plan never drives the scope gate", async () => {
    await plan("not approved", true);
    assert.equal(detectApprovedPlanScope(tmp), null);
    await plan("not approved", false);
    assert.equal(detectApprovedPlanScope(tmp), null);
  });

  it("`Status: **approved**` (body, emphasized) is approved for the scope gate — same as steps", async () => {
    // The old local regex required literal frontmatter `status: approved`, so a
    // body-status plan drove `steps` but never enabled out-of-plan detection.
    await plan("**approved**", false);
    const p = detectApprovedPlanScope(tmp);
    assert.ok(p, "detected");
    assert.deepStrictEqual(p?.scope, ["src/lib/thing.ts"]);
  });

  it("frontmatter `status: approved` still detects", async () => {
    await plan("approved", true);
    assert.ok(detectApprovedPlanScope(tmp));
  });
});

describe("detectApprovedPlanScope — root-level scope + multiple approved plans", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-plan-scope-"));
    await mkdir(join(tmp, "docs", "plans"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writePlan(name: string, scopeLines: string[]) {
    await writeFile(
      join(tmp, "docs", "plans", name),
      `---\nstatus: approved\n---\n\n# P\n\n## Scope\n\n${scopeLines.join("\n")}\n`,
    );
  }

  it("accepts root-level filenames (`cli.ts`, `package.json`) — but not version-like prose", async () => {
    await writePlan("a.md", [
      "- `cli.ts`",
      "- `package.json`",
      "- `src/lib/db.ts`",
      "- release as `v0.7.0` once done",
    ]);
    const p = detectApprovedPlanScope(tmp);
    assert.deepStrictEqual(p?.scope, ["cli.ts", "package.json", "src/lib/db.ts"]);
  });

  it("root-level scope entries make root-level edits in-plan end-to-end", async () => {
    await writePlan("a.md", ["- `cli.ts`"]);
    const p = detectApprovedPlanScope(tmp);
    const s = computeChangeState({
      registry: { features: {} },
      changedFiles: ["cli.ts"],
      planScope: p?.scope,
    });
    assert.deepStrictEqual(s.outOfPlan, [], "a legitimately scoped root file is never out-of-plan");
  });

  it("multiple approved plans: first by filename wins, ALL are named as contenders", async () => {
    await writePlan("b-second.md", ["- `src/lib/b.ts`"]);
    await writePlan("a-first.md", ["- `src/lib/a.ts`"]);
    const p = detectApprovedPlanScope(tmp);
    assert.equal(p?.plan, "docs/plans/a-first.md");
    assert.deepStrictEqual(p?.scope, ["src/lib/a.ts"]);
    assert.deepStrictEqual(p?.contenders, [
      "docs/plans/a-first.md",
      "docs/plans/b-second.md",
    ]);
  });

  it("a single approved plan has itself as the only contender (no warning owed)", async () => {
    await writePlan("a.md", ["- `src/lib/a.ts`"]);
    assert.deepStrictEqual(detectApprovedPlanScope(tmp)?.contenders, ["docs/plans/a.md"]);
  });
});

// Plan 17 step 3: a changed file the registry names as a source but that no
// adapter gates (outside the source-extension spec: .css, .json, …) must be
// SURFACED with its owning docs — info-only, never a strict verdict input.
// (.vue was the founding example; plan 20's adapter RETIRED it from this
// surface — the notice retires itself per file type as judgment arrives.)
describe("ungated registered changes (non-source blind spot)", () => {
  const registry = {
    features: {
      website: {
        doc: "docs/features/website.md",
        type: "feature" as const,
        primary_sources: ["app/components/Hero.vue", "src/site.ts"],
        related_sources: ["app/assets/site.css"],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      },
    },
  };

  it("a registered .css change surfaces with its owning doc", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["app/assets/site.css"],
    });
    assert.deepEqual(s.ungatedRegistered, [
      {
        file: "app/assets/site.css",
        owners: [{ feature: "website", doc: "docs/features/website.md" }],
      },
    ]);
    // Still in the other-changed bucket (it is not a recognized source)…
    assert.deepEqual(s.otherChanged, ["app/assets/site.css"]);
    // …and never a staleness verdict: strict inputs stay empty.
    assert.deepEqual(s.staleDocs, []);
    assert.deepEqual(s.unmapped, []);
  });

  it("RETIREMENT: a registered .vue is now GATED source — it never rides the ungated surface", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["app/components/Hero.vue"],
    });
    assert.deepEqual(s.ungatedRegistered, []);
    assert.deepEqual(s.changedSources, ["app/components/Hero.vue"]);
    assert.deepEqual(s.staleDocs.map((d) => d.feature), ["website"]);
  });

  it("a related-source registration counts too", () => {
    const reg = {
      features: {
        website: {
          ...registry.features.website,
          primary_sources: ["src/site.ts"],
          related_sources: ["app/assets/site.css"],
        },
      },
    };
    const s = computeChangeState({
      registry: reg as never,
      changedFiles: ["app/assets/site.css"],
    });
    assert.equal(s.ungatedRegistered.length, 1);
    assert.equal(s.ungatedRegistered[0].file, "app/assets/site.css");
  });

  it("an unregistered non-source change stays plain otherChanged", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["app/assets/other.css", "logo.png"],
    });
    assert.deepEqual(s.ungatedRegistered, []);
    assert.deepEqual(s.otherChanged, ["app/assets/other.css", "logo.png"]);
  });

  it("a REGISTERED declaration artifact is surfaced, not silently dropped", () => {
    const reg = {
      features: {
        types: {
          doc: "docs/features/types.md",
          type: "feature" as const,
          primary_sources: ["types/api.d.ts"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current",
        },
      },
    };
    const s = computeChangeState({
      registry: reg as never,
      changedFiles: ["types/api.d.ts"],
    });
    assert.deepEqual(s.ungatedRegistered, [
      { file: "types/api.d.ts", owners: [{ feature: "types", doc: "docs/features/types.md" }] },
    ]);
    // Still excluded from every verdict input and from other-changed.
    assert.deepEqual(s.staleDocs, []);
    assert.deepEqual(s.otherChanged, []);
    // An UNREGISTERED declaration artifact stays fully silent, as before.
    const quiet = computeChangeState({
      registry: reg as never,
      changedFiles: ["types/other.d.ts"],
    });
    assert.deepEqual(quiet.ungatedRegistered, []);
    assert.deepEqual(quiet.otherChanged, []);
  });

  it("a registered recognized source is gated normally, never listed as ungated", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["src/site.ts"],
    });
    assert.deepEqual(s.ungatedRegistered, []);
    assert.equal(s.staleDocs.length, 1);
  });
});

// ADVERSARIAL REVIEW: this project's own doc contract (change-control-gate.md,
// "A changed file the registry names as a source but no adapter gates is
// SURFACED, never silent") says a registered-but-excluded file rides the
// `ungatedRegistered` info surface rather than vanishing — proven above for a
// registered `.d.ts`. `tests/adapter-conformance.ts` used to be a registered
// primary_source of change-control-gate; this diff both widened the exclusion
// spec to swallow it AND deleted its registry entry, rather than leaving it
// registered to ride the very surface this file documents for exactly this
// scenario. The result: a file the doc still narrates as defining "the ONE
// testable meaning of precise" now produces NO signal at all when it changes.
describe("REGRESSION: tests/adapter-conformance.ts lost ALL governance, not just gating", () => {
  it("changing tests/adapter-conformance.ts today produces zero signal in the real project's own change-state", async () => {
    const registry = await readRegistry(join(here, "..", "docs", ".registry.json"));
    const s = computeChangeState({
      registry,
      changedFiles: ["tests/adapter-conformance.ts"],
    });
    const surfaced =
      s.staleDocs.length > 0 ||
      s.unmapped.includes("tests/adapter-conformance.ts") ||
      s.ungatedRegistered.some((u) => u.file === "tests/adapter-conformance.ts");
    assert.ok(
      surfaced,
      "tests/adapter-conformance.ts defines a load-bearing contract per the change-control-gate doc, " +
        "but is now completely invisible to the gate: not staleDocs, not unmapped (excluded by the widened " +
        "spec), and not ungatedRegistered (dropped from the registry instead of kept registered).",
    );
  });
});
