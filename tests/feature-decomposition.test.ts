import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, FINDING_ORDER, type LintFinding, type LintFindingId } from "../src/lib/analyze.js";
import {
  readRegistrySync,
  updateRegistryEntry,
  normalizeRegistry,
  type Registry,
  type RegistryEntry,
} from "../src/lib/registry.js";

// ── Step 6: cohesive field round-trip ───────────────────────────────────────

describe("registry cohesive field", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-decomp-"));
    await mkdir(join(root, "docs"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("survives a normalize -> write -> normalize round trip", () => {
    const reg = normalizeRegistry({
      features: {
        big: { doc: "docs/features/big.md", type: "feature", primary_sources: ["src/a.ts"], status: "current", cohesive: true },
      },
    });
    assert.equal(reg.features.big.cohesive, true);
    const reserialized = normalizeRegistry(JSON.parse(JSON.stringify(reg)));
    assert.equal(reserialized.features.big.cohesive, true, "cohesive must not be dropped on re-read");
  });

  it("is preserved by an updateRegistryEntry touch on an unrelated field", () => {
    const path = join(root, "docs", ".registry.json");
    updateRegistryEntry(path, "big", {
      doc: "docs/features/big.md",
      type: "feature",
      primary_sources: ["src/a.ts"],
      status: "current",
      cohesive: true,
    });
    updateRegistryEntry(path, "big", { status: "in-progress" }); // touch
    assert.equal(readRegistrySync(path).features.big.cohesive, true);
  });

  it("is absent (not false) when never set", () => {
    const reg = normalizeRegistry({
      features: { x: { doc: "docs/features/x.md", type: "feature", primary_sources: ["src/a.ts"], status: "current" } },
    });
    assert.equal(reg.features.x.cohesive, undefined);
    assert.equal("cohesive" in JSON.parse(JSON.stringify(reg)).features.x, false);
  });
});

// ── Step 6: decomposition shape findings ─────────────────────────────────────

function entry(primary: string[], extra: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    doc: "docs/features/f.md",
    type: "feature",
    primary_sources: primary,
    related_sources: [],
    docs: [],
    depends_on: [],
    risk: [],
    last_updated: "2026-06-22",
    status: "current",
    ...extra,
  };
}

function has(lint: LintFinding[], id: LintFindingId): LintFinding | undefined {
  return lint.find((f) => f.id === id);
}

describe("decomposition shape findings", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-decomp-"));
    await mkdir(join(root, "src"), { recursive: true });
    for (const f of ["a", "b", "c", "d", "e", "f"]) {
      await writeFile(join(root, "src", `${f}.ts`), `export const ${f} = 1;\n`);
    }
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function run(features: Record<string, RegistryEntry>): LintFinding[] {
    const registry: Registry = { features };
    return analyze({ root, registry, srcDir: "src" }).lint;
  }

  const SIX = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];

  it("fires under-decomposed (info) when one feature owns the whole project", () => {
    const lint = run({ app: entry(SIX) });
    const f = has(lint, "under-decomposed");
    assert.ok(f, "expected under-decomposed");
    assert.equal(f.severity, "info"); // never warn — must not block clean
    assert.equal(f.feature, "app");
  });

  it("is muted by cohesive: true", () => {
    const lint = run({ app: entry(SIX, { cohesive: true }) });
    assert.equal(has(lint, "under-decomposed"), undefined);
  });

  it("does NOT fire once there are two mature feature entries (the codument case)", () => {
    const lint = run({
      front: entry(["src/a.ts", "src/b.ts", "src/c.ts"]),
      back: entry(["src/d.ts", "src/e.ts", "src/f.ts"], { doc: "docs/features/back.md" }),
    });
    assert.equal(has(lint, "under-decomposed"), undefined);
  });

  it("does NOT fire for a one-file feature that is not a barrel (no false over-decomposed)", () => {
    // single feature owning a real-logic file → under fires, over does not
    const lint = run({ app: entry(SIX) });
    assert.equal(has(lint, "over-decomposed"), undefined);
  });

  it("fires over-decomposed (info) for a feature whose sole primary is an index/barrel file", async () => {
    await writeFile(join(root, "src", "index.ts"), "export * from './a.js';\n");
    const lint = run({
      app: entry(SIX),
      barrel: entry(["src/index.ts"], { doc: "docs/features/barrel.md" }),
    });
    const f = has(lint, "over-decomposed");
    assert.ok(f, "expected over-decomposed");
    assert.equal(f.severity, "info");
    assert.equal(f.feature, "barrel");
  });
});

// ── Step 6: every finding id is registered for stable ordering ───────────────

describe("FINDING_ORDER", () => {
  // "Every id is in the order array" is no longer assertable, because it is no longer
  // deniable: LintFindingId IS the array's member type. This previously lived here as a
  // `Record<LintFindingId, true>` whose exhaustiveness only bites under `tsc`, which
  // never runs over tests/ — so it sat dead while three ids slipped past it.
  //
  // What the derivation cannot catch is a DUPLICATE: a repeated literal collapses in
  // the union and survives in the array, and `sortFindings` resolves ties by `indexOf`,
  // so the later copy is dead weight that reads as a deliberate rank.
  it("lists each id exactly once (a duplicate is invisible to the derived union)", () => {
    const seen = new Set<LintFindingId>();
    const dupes = FINDING_ORDER.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    assert.deepEqual(dupes, [], `FINDING_ORDER repeats: ${dupes.join(", ")}`);
  });
});
