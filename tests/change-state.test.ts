import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  computeChangeState,
  detectApprovedPlanScope,
  removedInChange,
  resolveDocPointers,
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

  it("summarizes dependents one-per-feature, ranking umbrella-only edges last", async () => {
    const s = await state();
    // `dependents` stays one entry per EDGE — it is the machine contract.
    assert.ok(s.dependents.length >= s.dependentsSummary.length);
    // The summary has no duplicate features.
    const features = s.dependentsSummary.map((d) => d.feature);
    assert.deepStrictEqual(features, [...new Set(features)], "one entry per feature");
    // Every edge survives the collapse — the summary hides nothing.
    const edgeCount = s.dependentsSummary.reduce((n, d) => n + d.dependsOn.length, 0);
    assert.equal(edgeCount, s.dependents.length);
    // `db` is a concept in this fixture, so a dependent whose only edge is on `db`
    // is umbrella-only and sorts after any dependent with a real feature edge.
    const umbrellaOnly = s.dependentsSummary.filter((d) => d.viaUmbrella);
    assert.ok(umbrellaOnly.length > 0, "the fixture has umbrella-only dependents");
    const firstUmbrella = s.dependentsSummary.findIndex((d) => d.viaUmbrella);
    assert.ok(
      s.dependentsSummary.slice(firstUmbrella).every((d) => d.viaUmbrella),
      "umbrella-only dependents are contiguous at the end",
    );
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
        kind: "impact-only",
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
      {
        file: "types/api.d.ts",
        owners: [{ feature: "types", doc: "docs/features/types.md" }],
        kind: "excluded",
      },
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

// Plan 41: the registry is the control plane every other answer derives from, so
// an entry left pointing at a path this change removed is worse than a stale doc.
// Probe C: `git mv` on a registered source reached the gate as a bare add, and the
// ghost pointer survived a fully green run with nothing to reap it.
describe("registry pointers left dangling by this change", () => {
  const registry = {
    features: {
      i18n: {
        doc: "docs/concepts/i18n.md",
        type: "concept" as const,
        primary_sources: ["i18n/format.ts"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      },
    },
  };

  it("PROBE C: a renamed registered source leaves a pointer finding naming the destination", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/dateFormat.ts"],
      renames: [{ from: "i18n/format.ts", to: "i18n/dateFormat.ts" }],
    });
    assert.deepEqual(s.registryPointers, [
      {
        file: "i18n/format.ts",
        features: ["i18n"],
        kind: "renamed",
        renamedTo: "i18n/dateFormat.ts",
      },
    ]);
  });

  it("re-pointing the entry clears it — the finding self-heals, no ack to remember", () => {
    const repointed = {
      features: { i18n: { ...registry.features.i18n, primary_sources: ["i18n/dateFormat.ts"] } },
    };
    const s = computeChangeState({
      registry: repointed as never,
      changedFiles: ["i18n/dateFormat.ts"],
      renames: [{ from: "i18n/format.ts", to: "i18n/dateFormat.ts" }],
    });
    assert.deepEqual(s.registryPointers, []);
  });

  it("a deletion leaves one too, and doc attention does NOT settle it", () => {
    const s = computeChangeState({
      registry: registry as never,
      // The owning doc is updated in the same change, so the deletion's DOC debt is
      // paid — the pointer debt is a separate obligation and must survive it.
      changedFiles: ["docs/concepts/i18n.md"],
      deletedFiles: ["i18n/format.ts"],
    });
    assert.deepEqual(s.staleDocs, [], "the doc was attended to");
    assert.deepEqual(
      s.registryPointers.map((p) => [p.file, p.kind]),
      [["i18n/format.ts", "deleted"]],
      "…but the registry still names the removed path",
    );
  });

  it("a path that is still THERE was not removed — neither half fires on a present file", () => {
    // Both inputs can name a path that exists at head: git pairs renames by
    // similarity (a file split re-creates the origin as a shim), and `deletedFiles`
    // reports the index side (`git rm x` then re-create x). Demanding the registry
    // stop naming a file you can see on disk is unsatisfiable — dropping the entry
    // only makes the surviving file unmapped — so presence at head settles it.
    const split = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/dateFormat.ts", "i18n/format.ts"],
      renames: [{ from: "i18n/format.ts", to: "i18n/dateFormat.ts" }],
    });
    assert.deepEqual(split.registryPointers, [], "the origin is present — nothing was removed");

    const recreated = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/format.ts"],
      deletedFiles: ["i18n/format.ts"],
    });
    assert.deepEqual(recreated.registryPointers, [], "removed from the index, still on disk");

    // Control: with the path genuinely gone, both still fire (so the guard above
    // narrows the finding rather than deleting it).
    const gone = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/dateFormat.ts"],
      renames: [{ from: "i18n/format.ts", to: "i18n/dateFormat.ts" }],
      deletedFiles: [],
    });
    assert.equal(gone.registryPointers.length, 1, "a real move still flags");
  });

  it("a related-only registration dangles too — a wrong pointer is wrong either way", () => {
    const reg = {
      features: {
        i18n: {
          ...registry.features.i18n,
          primary_sources: ["i18n/index.ts"],
          related_sources: ["i18n/format.ts"],
        },
      },
    };
    const s = computeChangeState({
      registry: reg as never,
      changedFiles: ["i18n/dateFormat.ts"],
      renames: [{ from: "i18n/format.ts", to: "i18n/dateFormat.ts" }],
    });
    assert.deepEqual(s.registryPointers.map((p) => p.features), [["i18n"]]);
  });

  it("a PRE-EXISTING dangle does not fire — review judges the change, doctor judges the repo", () => {
    // Nothing was renamed or deleted here; `i18n/format.ts` is simply absent from
    // the tree and always was. Blocking an unrelated edit on an adopting repo's old
    // debt is what would make the gate unsatisfiable.
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/other.ts"],
    });
    assert.deepEqual(s.registryPointers, []);
  });

  it("renaming an UNREGISTERED file is not a pointer problem", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["src/b.ts"],
      renames: [{ from: "src/a.ts", to: "src/b.ts" }],
    });
    assert.deepEqual(s.registryPointers, []);
  });

  it("what is GONE is decided once, so the two pointer findings cannot disagree", () => {
    // A copy and a file split both arrive labelled as renames with the origin still on
    // disk, and a path dropped from the index but present in the tree was not removed
    // either. Both narrowings governed the registry pointer already; the doc pointer
    // reads the same answer rather than re-deriving one.
    assert.deepEqual(
      removedInChange([{ from: "a.ts", to: "b.ts" }], ["b.ts"], []),
      ["a.ts"],
      "a genuine move",
    );
    assert.deepEqual(
      removedInChange([{ from: "a.ts", to: "b.ts" }], ["a.ts", "b.ts"], []),
      [],
      "a copy or a split leaves the origin in place",
    );
    assert.deepEqual(removedInChange([], [], ["a.ts"]), ["a.ts"], "a deletion");
    assert.deepEqual(
      removedInChange([], ["a.ts"], ["a.ts"]),
      [],
      "dropped from the index, still in the tree",
    );
  });
});

// The registry's pointer to a vanished file was always checked; the sentence beside it
// never was, so a rename that correctly re-pointed the entry went green with the owning
// doc still sending its next reader to a path that is not there.
describe("a doc naming a path this change removed", () => {
  let dir: string;
  const registry = {
    features: {
      i18n: {
        doc: "docs/concepts/i18n.md",
        type: "concept" as const,
        primary_sources: ["i18n/dateFormat.ts"],
        related_sources: [],
        docs: ["docs/concepts/i18n-extra.md"],
        depends_on: [],
        risk: [],
        status: "current",
      },
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codument-docptr-"));
    await mkdir(join(dir, "docs", "concepts"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => writeFileSync(join(dir, rel), body);

  it("finds the dead path in the owning doc's prose, and clears when the doc is corrected", () => {
    write("docs/concepts/i18n.md", "# i18n\n\n## Key files\n\n- `i18n/format.ts` — formatting\n");
    assert.deepEqual(resolveDocPointers(dir, registry as never, ["i18n/format.ts"]), [
      { doc: "docs/concepts/i18n.md", paths: ["i18n/format.ts"] },
    ]);

    write("docs/concepts/i18n.md", "# i18n\n\n## Key files\n\n- `i18n/dateFormat.ts` — formatting\n");
    assert.deepEqual(resolveDocPointers(dir, registry as never, ["i18n/format.ts"]), []);
  });

  it("reads every doc an entry names, not only its primary one", () => {
    write("docs/concepts/i18n.md", "# i18n\n");
    write("docs/concepts/i18n-extra.md", "See `i18n/format.ts` for the shape.\n");
    assert.deepEqual(
      resolveDocPointers(dir, registry as never, ["i18n/format.ts"]).map((p) => p.doc),
      ["docs/concepts/i18n-extra.md"],
    );
  });

  it("a path is a path, never a fragment of a longer one", () => {
    write(
      "docs/concepts/i18n.md",
      "`i18n/format.ts.bak` is generated, and `vendor/i18n/format.ts` is theirs.\n",
    );
    assert.deepEqual(
      resolveDocPointers(dir, registry as never, ["i18n/format.ts"]),
      [],
      "neither mention is the removed path",
    );
  });

  it("a removal nobody documented, and a doc that is not there, both stay silent", () => {
    write("docs/concepts/i18n.md", "# i18n\n\nNothing about files here.\n");
    assert.deepEqual(resolveDocPointers(dir, registry as never, ["i18n/format.ts"]), []);
    assert.deepEqual(resolveDocPointers(dir, registry as never, []), [], "nothing was removed");
    // docs/concepts/i18n-extra.md is registered and absent — an unreadable doc
    // contributes nothing rather than raising, the advisory stance every walk takes.
    assert.deepEqual(resolveDocPointers(dir, registry as never, ["anything.ts"]), []);
  });
});

// ADR 017: a registration is an explicit claim that a file is load-bearing to a
// named doc, so a file no adapter can judge is still GOVERNED at file grain when a
// feature/concept OWNS it. The field false green this closes: rewriting a
// registered locale pack (the app's entire user-visible string surface) counted as
// "0 source, 1 other" and exited 0.
describe("governed registered changes (ADR 017, narrowed by ADR 020)", () => {
  // The risk tag is what governs an unread file now. ADR 017 gated every owned one,
  // and it was right that a claimed file going silently green is a false green — but
  // nothing here can be read, so the only artifact a block could demand is a
  // signature over content nobody looked at. A risk tag is the project saying the
  // opposite out loud, and it is the whole difference between this describe and the
  // downgrade test at the end of it.
  const registry = {
    features: {
      i18n: {
        doc: "docs/concepts/i18n.md",
        type: "concept" as const,
        primary_sources: ["i18n/index.ts", "i18n/locales/en/journal.json"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: ["user-facing-copy"],
        status: "current",
      },
    },
  };

  it("FIELD REPLAY: rewriting an owned locale pack wakes its doc (was a silent green)", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/locales/en/journal.json"],
    });
    assert.deepEqual(s.governedRegistered, ["i18n/locales/en/journal.json"]);
    // It is governed, so it is no longer merely "ungated / verify by hand"…
    assert.deepEqual(s.ungatedRegistered, []);
    // …and it now feeds the stale-doc verdict `--strict` already gates on.
    assert.deepEqual(
      s.staleDocs.map((d) => d.feature),
      ["i18n"],
    );
    assert.deepEqual(s.staleDocs[0].changedSources, ["i18n/locales/en/journal.json"]);
  });

  // Both clearing tests below assert an EMPTY staleDocs, which is also what a
  // missing governed wake would produce — so each pairs the assertion with proof
  // that the file was genuinely governed, and the ack case with an unacked control.
  // Without that pairing they would pass with the whole wake deleted.
  it("doc attention clears it, exactly like any other wake", () => {
    // Control first: the same change WITHOUT the doc edit must wake, so the empty
    // staleDocs below proves the doc edit cleared a real wake rather than that no
    // wake ever existed. (`governedRegistered` alone would not prove it — a file is
    // classified governed whether or not the wake fires.)
    const woke = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/locales/en/journal.json"],
    });
    assert.equal(woke.staleDocs.length, 1, "control: it wakes without doc attention");
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/locales/en/journal.json", "docs/concepts/i18n.md"],
    });
    assert.deepEqual(s.staleDocs, [], "…and the doc edit clears it");
  });

  it("a file-grain ack clears it — the ack route is reachable for unjudgeable files", () => {
    const input = {
      registry: registry as never,
      changedFiles: ["i18n/locales/en/journal.json"],
    };
    // Control: without the ack this exact input wakes, so the ack is load-bearing.
    assert.equal(computeChangeState(input).staleDocs.length, 1);
    const s = computeChangeState({ ...input, fileGrainAcked: ["i18n/locales/en/journal.json"] });
    assert.deepEqual(s.staleDocs, []);
    // Still reported as governed: the ack adjudicated it, it was never ungoverned.
    assert.deepEqual(s.governedRegistered, ["i18n/locales/en/journal.json"]);
  });

  it("DELETION PARITY: removing an owned locale pack wakes its doc (probe D)", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: [],
      deletedFiles: ["i18n/locales/en/journal.json"],
    });
    assert.deepEqual(s.governedDeleted, ["i18n/locales/en/journal.json"]);
    assert.deepEqual(
      s.staleDocs.map((d) => d.feature),
      ["i18n"],
    );
  });

  it("a deletion is not ack-clearable — a removal owes doc attention (ADR 012)", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: [],
      deletedFiles: ["i18n/locales/en/journal.json"],
      fileGrainAcked: ["i18n/locales/en/journal.json"],
    });
    assert.equal(s.staleDocs.length, 1, "no ack fast-path for a deletion");
  });

  // The DELETION axis of the governed-set matrix. Deletion is the branch this
  // change newly reaches, so the two rules it must not break — related never
  // wakes, exclusion overrides registration — are guarded here as well as on the
  // changed path; a green suite that only ever tested the changed path would not
  // notice an ownership guard widened to include related sources.
  it("DELETION × related-only: an impact-only registration still never wakes", () => {
    const reg = {
      features: {
        i18n: {
          ...registry.features.i18n,
          primary_sources: ["i18n/index.ts"],
          related_sources: ["i18n/locales/en/journal.json"],
        },
      },
    };
    const s = computeChangeState({
      registry: reg as never,
      changedFiles: [],
      deletedFiles: ["i18n/locales/en/journal.json"],
    });
    assert.deepEqual(s.governedDeleted, []);
    assert.deepEqual(s.staleDocs, [], "related claims impact, never ownership — even on deletion");
  });

  it("DELETION × excluded: exclusion still overrides registration", () => {
    const reg = {
      features: {
        gen: {
          doc: "docs/features/gen.md",
          type: "feature" as const,
          primary_sources: ["data/fixtures.seed.json"],
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
      changedFiles: [],
      deletedFiles: ["data/fixtures.seed.json"],
    });
    assert.deepEqual(s.governedDeleted, []);
    assert.deepEqual(s.staleDocs, []);
  });

  it("without a risk tag the same rewrite is reported, not gated — and says how to gate it", () => {
    // ADR 020 narrows ADR 017: the false green it closed comes back for files nobody
    // declared risky, because the block it demanded could only ever be cleared by a
    // signature over content the tool never read. What replaces it is disclosure —
    // the file is named, its owner is named, and the one registry line that restores
    // the block is named — so the downgrade is something the reader declines rather
    // than something that happens to them.
    const noRisk = {
      features: { i18n: { ...registry.features.i18n, risk: [] } },
    };
    const s = computeChangeState({
      registry: noRisk as never,
      changedFiles: ["i18n/locales/en/journal.json"],
    });
    assert.deepEqual(s.governedRegistered, [], "not gated");
    assert.deepEqual(s.staleDocs, [], "so nothing goes stale for it");
    assert.deepEqual(
      s.ungatedRegistered.map((u) => [u.file, u.kind]),
      [["i18n/locales/en/journal.json", "unread"]],
      "…but it is reported, in its own words — not as excluded, not as impact-only",
    );
    assert.deepEqual(s.ungatedRegistered[0].owners.map((o) => o.feature), ["i18n"]);
  });

  it("a deletion gates with no risk tag at all — nothing has to be read to see it is gone", () => {
    // The worse half of ADR 017's field case, and the half the narrowing does not
    // touch: a removal is structurally proven and its fix (update the doc, or drop
    // the entry) is checkable, so it clears both of ADR 020's bars without anyone
    // declaring anything.
    const noRisk = {
      features: { i18n: { ...registry.features.i18n, risk: [] } },
    };
    const s = computeChangeState({
      registry: noRisk as never,
      changedFiles: [],
      deletedFiles: ["i18n/locales/en/journal.json"],
    });
    assert.deepEqual(s.governedDeleted, ["i18n/locales/en/journal.json"]);
    assert.deepEqual(
      s.staleDocs.map((d) => d.feature),
      ["i18n"],
    );
  });

  it("one risky owner gates the file, even where another owner is quiet", () => {
    // Risk is a claim about consequence, and a feature saying "this can hurt" is not
    // overruled by a co-owner who has not thought about it. The alternative rule —
    // every owner must agree — would make the gate a function of the least careful
    // entry that happens to name the file.
    const mixed = {
      features: {
        i18n: { ...registry.features.i18n, risk: [] },
        legal: {
          doc: "docs/features/legal.md",
          type: "feature" as const,
          primary_sources: ["i18n/locales/en/journal.json"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: ["compliance"],
          status: "current",
        },
      },
    };
    const s = computeChangeState({
      registry: mixed as never,
      changedFiles: ["i18n/locales/en/journal.json"],
    });
    assert.deepEqual(s.governedRegistered, ["i18n/locales/en/journal.json"]);
    assert.deepEqual(s.ungatedRegistered, [], "one risky owner is enough");
    assert.deepEqual(
      s.staleDocs.map((d) => d.feature).sort(),
      ["i18n", "legal"],
      "and both owners wake — the wake follows ownership, not who declared the risk",
    );
  });

  it("a file owned by one feature and merely related to another wakes only its owner", () => {
    const reg = {
      features: {
        i18n: { ...registry.features.i18n, primary_sources: ["i18n/locales/en/journal.json"] },
        shell: {
          doc: "docs/features/shell.md",
          type: "feature" as const,
          primary_sources: ["src/shell.ts"],
          related_sources: ["i18n/locales/en/journal.json"],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current",
        },
      },
    };
    for (const input of [
      { changedFiles: ["i18n/locales/en/journal.json"], deletedFiles: [] },
      { changedFiles: [], deletedFiles: ["i18n/locales/en/journal.json"] },
    ]) {
      const s = computeChangeState({ registry: reg as never, ...input });
      assert.deepEqual(
        s.staleDocs.map((d) => d.feature),
        ["i18n"],
        "the co-mentioning feature must not wake",
      );
    }
  });

  it("related-only registration stays impact-only — it never wakes", () => {
    const reg = {
      features: {
        i18n: {
          ...registry.features.i18n,
          primary_sources: ["i18n/index.ts"],
          related_sources: ["i18n/locales/en/journal.json"],
        },
      },
    };
    const s = computeChangeState({
      registry: reg as never,
      changedFiles: ["i18n/locales/en/journal.json"],
    });
    assert.deepEqual(s.governedRegistered, [], "related claims impact, never ownership");
    assert.deepEqual(s.staleDocs, []);
    assert.equal(s.ungatedRegistered.length, 1, "still surfaced as verify-by-hand");
  });

  it("exclusion beats registration — an excluded owned file stays ungoverned", () => {
    const reg = {
      features: {
        gen: {
          doc: "docs/features/gen.md",
          type: "feature" as const,
          primary_sources: ["data/fixtures.seed.json"],
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
      changedFiles: ["data/fixtures.seed.json"],
    });
    assert.deepEqual(s.governedRegistered, []);
    assert.deepEqual(s.staleDocs, []);
    assert.equal(s.ungatedRegistered.length, 1, "the contradiction is still surfaced");
  });

  it("the residue is discriminated: excluded is a contradiction, impact-only is by design", () => {
    const reg = {
      features: {
        i18n: {
          ...registry.features.i18n,
          primary_sources: ["i18n/index.ts", "data/fixtures.seed.json"],
          related_sources: ["i18n/locales/en/journal.json"],
        },
      },
    };
    const s = computeChangeState({
      registry: reg as never,
      changedFiles: ["data/fixtures.seed.json", "i18n/locales/en/journal.json"],
    });
    assert.deepEqual(
      s.ungatedRegistered.map((u) => [u.file, u.kind]),
      [
        ["data/fixtures.seed.json", "excluded"],
        ["i18n/locales/en/journal.json", "impact-only"],
      ],
    );
  });

  it("a file that is BOTH excluded and impact-only reports the contradiction", () => {
    // Precedence, pinned: the two classes overlap, and only one of them names
    // something to fix. Without this case the discriminator could key off ownership
    // instead of exclusion and every other assertion would still pass.
    const reg = {
      features: {
        i18n: {
          ...registry.features.i18n,
          primary_sources: ["i18n/index.ts"],
          related_sources: ["data/fixtures.seed.json"],
        },
      },
    };
    const s = computeChangeState({
      registry: reg as never,
      changedFiles: ["data/fixtures.seed.json"],
    });
    assert.deepEqual(s.ungatedRegistered.map((u) => u.kind), ["excluded"]);
  });

  it("an UNREGISTERED unjudgeable file stays outside governance entirely", () => {
    const s = computeChangeState({
      registry: registry as never,
      changedFiles: ["i18n/locales/fr/journal.json"],
    });
    assert.deepEqual(s.governedRegistered, []);
    assert.deepEqual(s.staleDocs, []);
    assert.deepEqual(s.unmapped, [], "a non-source file never becomes 'unmapped'");
    assert.deepEqual(s.otherChanged, ["i18n/locales/fr/journal.json"]);
  });
});

// A first-party module that lives under a test directory but is not itself a
// test stays governed — the boundary the exclusion spec draws, seen from the
// gate rather than from the matcher. This repo's own conformance battery is the
// worked example: `tests/adapter-conformance.ts` defines a contract seven
// adapters must satisfy, change-control-gate.md narrates it in Key files, and
// no language convention names it a test. So changing it must wake its doc.
describe("a non-test module under a test directory is governed like any source", () => {
  it("changing this repo's conformance battery flags its owning doc", async () => {
    const registry = await readRegistry(join(here, "..", "docs", ".registry.json"));
    const s = computeChangeState({
      registry,
      changedFiles: ["tests/adapter-conformance.ts"],
    });
    assert.ok(
      s.staleDocs.some((d) => d.doc === "docs/features/change-control-gate.md"),
      "a registered, convention-unnamed module under tests/ must wake its owning doc, " +
        "not fall silently out of the gate",
    );
    assert.equal(s.unmapped.includes("tests/adapter-conformance.ts"), false);
  });
});

// Plan 43 / the 2026-08-09 field report, finding 4. A source entry can name a tree,
// so governing 380 locale files costs one registry line instead of 380.
describe("a pattern source governs a tree (plan 43)", () => {
  const TREE = "i18n/locales/**/*.json";
  // Risk-declared, because these are locale packs no adapter reads and ADR 020 gates
  // an unread file only where the project says it matters. Every test here is about
  // how a PATTERN resolves — one wake for a tree, no claim outside it, exclusion
  // still winning — and none of them could answer that with nothing waking at all.
  const registry = (sources: string[]): Registry => ({
    features: {
      i18n: {
        doc: "docs/concepts/i18n.md",
        type: "concept",
        primary_sources: sources,
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: ["user-facing-copy"],
        status: "current",
      },
    },
  });

  const state = (sources: string[], changedFiles: string[]) =>
    computeChangeState({ registry: registry(sources), changedFiles });

  it("wakes the owning doc ONCE however many files inside it moved", () => {
    const s = state([TREE], [
      "i18n/locales/en/common.json",
      "i18n/locales/fi/common.json",
      "i18n/locales/fi/settings.json",
    ]);
    assert.equal(s.staleDocs.length, 1, "one wake, not one per file");
    assert.equal(s.staleDocs[0].feature, "i18n");
    assert.equal(s.staleDocs[0].changedSources.length, 3, "the machine view keeps every path");
    assert.deepEqual(
      s.staleDocs[0].viaPatterns,
      [{ pattern: TREE, count: 3 }],
      "and the human view has the tree with its count",
    );
  });

  it("does not claim a file outside the tree", () => {
    const s = state([TREE], ["i18n/config.json", "i18n/locales/en/common.json"]);
    assert.deepEqual(s.staleDocs[0].changedSources, ["i18n/locales/en/common.json"]);
    assert.deepEqual(s.unmapped, [], "a non-source file is not an unmapped source");
  });

  it("cannot re-admit what the exclusion spec drops", () => {
    // The authoring guard is deliberately syntactic and cannot see the file list, so
    // THIS is the surface where the spec wins over a pattern that reaches too far.
    const s = state(["**/*.json"], [
      "i18n/locales/en/common.json",
      "node_modules/pkg/package.json",
      "dist/build.json",
    ]);
    assert.deepEqual(s.staleDocs[0].changedSources, ["i18n/locales/en/common.json"]);
    // And it does not manufacture the excluded-yet-registered CONTRADICTION for them
    // either. That finding means "you claimed a path the spec drops" and asks the user
    // to fix it; a pattern that merely swept past node_modules has nothing to fix, so
    // reporting it would be an unfixable finding invented by the expansion.
    assert.deepEqual(s.ungatedRegistered, []);
  });

  it("partitions overlapping trees rather than counting a file twice", () => {
    const s = state(["i18n/locales/**/*.json", "i18n/**/*.json"], [
      "i18n/locales/en/common.json",
      "i18n/other/x.json",
    ]);
    assert.deepEqual(s.staleDocs[0].viaPatterns, [
      { pattern: "i18n/locales/**/*.json", count: 1 },
      { pattern: "i18n/**/*.json", count: 1 },
    ]);
  });

  it("leaves a registry of literal paths rendering exactly as before", () => {
    const s = state(["i18n/locales/en/common.json"], ["i18n/locales/en/common.json"]);
    assert.deepEqual(s.staleDocs[0].viaPatterns, [], "no pattern, no collapsing");
    assert.deepEqual(s.staleDocs[0].changedSources, ["i18n/locales/en/common.json"]);
  });

  it("treats a trailing-slash directory the same way", () => {
    const s = state(["i18n/locales/"], ["i18n/locales/fi/common.json"]);
    assert.equal(s.staleDocs.length, 1);
    assert.deepEqual(s.staleDocs[0].viaPatterns, [{ pattern: "i18n/locales/", count: 1 }]);
  });
});

// Plan 44 step 1: the headline total counts every changed path while every bucket
// beside it filters the exclusion spec out, so the most ordinary change a step makes
// — editing a test — printed counts that did not add up, with nothing accounting for
// the remainder. A count a reader cannot reconcile is a count they stop reading.
describe("the change buckets partition the change set (plan 44)", () => {
  const state = (changedFiles: string[], deletedFiles: string[] = []) =>
    computeChangeState({
      registry: { features: {} },
      changedFiles,
      deletedFiles,
    });

  it("names what the exclusion spec drops, so the buckets sum to the total", () => {
    const changed = [
      "src/a.ts", // source
      "docs/features/a.md", // doc
      "app.json", // other
      "tests/a.test.ts", // excluded — a test, the common case
      "dist/bundle.js", // excluded — build output
    ];
    const s = state(changed);
    assert.deepStrictEqual(s.excludedChanged, ["dist/bundle.js", "tests/a.test.ts"]);
    assert.equal(
      s.changedSources.length + s.changedDocs.length + s.otherChanged.length + s.excludedChanged.length,
      changed.length,
      "every changed path lands in exactly one bucket",
    );
  });

  it("counts an excluded DELETION once, in the deletions bucket", () => {
    // The total counts deletions whole, so folding excluded deletions in here would
    // trade a total that does not add up for one that adds up twice.
    const s = state(["src/a.ts"], ["tests/gone.test.ts"]);
    assert.deepStrictEqual(s.excludedChanged, []);
  });

  it("a change with nothing excluded is unchanged", () => {
    const s = state(["src/a.ts", "docs/features/a.md", "app.json"]);
    assert.deepStrictEqual(s.excludedChanged, [], "the common case stays silent");
  });
});

describe("a new file the source spec cannot see, beside an entry's own sources (plan 49)", () => {
  const reg = (primary: string[]): Registry => ({
    features: {
      design: {
        doc: "docs/features/design.md",
        type: "feature",
        primary_sources: primary,
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      } as RegistryEntry,
    },
  });
  const additions = (added: string[], primary = ["src/design/theme.ts"]) =>
    computeChangeState({
      registry: reg(primary),
      changedFiles: added,
      addedFiles: added,
    }).specInvisibleAdditions;

  it("names it, once per entry, with the doc that claims the directory", () => {
    // Neither existing signal reaches this: the spec drops the extension before
    // ownership is ever asked, so `unmapped` never sees it and governance never
    // claims it. In the field that is how a directory an entry described filled up
    // with files its doc had never heard of.
    const out = additions(["src/design/mockup.html", "src/design/spec.pdf"]);
    assert.equal(out.length, 1, "one line per entry, never one per file");
    assert.equal(out[0].feature, "design");
    assert.equal(out[0].doc, "docs/features/design.md");
    assert.equal(out[0].directory, "src/design");
    assert.deepEqual(out[0].files, ["src/design/mockup.html", "src/design/spec.pdf"]);
  });

  it("stays silent for a file the spec CAN see — that one is already unmapped", () => {
    // A second finding over one file is two surfaces disagreeing about it.
    assert.deepEqual(additions(["src/design/extra.ts"]), []);
  });

  it("stays silent where the entry already declares a covering pattern", () => {
    // Asking again asks a project to re-declare what it declared.
    assert.deepEqual(
      additions(["src/design/mockup.html"], ["src/design/theme.ts", "src/design/*.html"]),
      [],
    );
  });

  it("stays silent for a file the entry names outright — that one is governed", () => {
    assert.deepEqual(
      additions(["src/design/mockup.html"], ["src/design/theme.ts", "src/design/mockup.html"]),
      [],
    );
  });

  it("stays silent for a MODIFIED file, and for a directory no entry's sources live in", () => {
    // Firing on modification would put a line on every edit of every locale file
    // forever, which is the wall this release exists to remove.
    const modified = computeChangeState({
      registry: reg(["src/design/theme.ts"]),
      changedFiles: ["src/design/mockup.html"],
    }).specInvisibleAdditions;
    assert.deepEqual(modified, [], "changed is not added");
    assert.deepEqual(additions(["elsewhere/mockup.html"]), [], "not beside anything an entry owns");
  });
});
