import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeChangeState, type ChangeState } from "../src/lib/change-state.js";
import { normalizeRegistry, type Registry } from "../src/lib/registry.js";
import type { AnchorChange } from "../src/lib/fingerprint.js";
import { buildReview } from "../src/commands/review.js";

// ── Phase 2e gate-wiring golden table ───────────────────────────────────────
// Per-symbol anchor changes (from the caller) resolve to their owning FEATURE so
// a one-symbol edit to a shared file wakes only that symbol's doc — the cascade
// dissolved. Concept umbrellas wake at file grain. Ownership is `primary_sources`
// only. This table fixes EXACTLY which scenarios flip the stale-doc verdict.

function reg(features: Record<string, unknown>): Registry {
  return normalizeRegistry({ features });
}
function chg(id: string, kind: AnchorChange["kind"] = "changed"): AnchorChange {
  return { id, name: id, kind };
}
function staleFeatures(s: ChangeState): string[] {
  return s.staleDocs.map((d) => d.feature).sort();
}

// Two features sharing one file, split per-symbol; the canonical cascade case.
const SHARED_TWO = {
  alpha: {
    doc: "docs/features/alpha.md",
    primary_sources: ["src/shared.ts"],
    owned_symbols: { "src/shared.ts": ["alphaCmd()."] },
  },
  beta: {
    doc: "docs/features/beta.md",
    primary_sources: ["src/shared.ts"],
    owned_symbols: { "src/shared.ts": ["betaCmd()."] },
  },
};

describe("gate wiring — cascade dissolution (shared file, per-symbol)", () => {
  it("a one-symbol edit wakes ONLY that symbol's owning doc (not every co-owner)", () => {
    const s = computeChangeState({
      registry: reg(SHARED_TWO),
      changedFiles: ["src/shared.ts"],
      anchorChanges: { "src/shared.ts": [chg("src/shared.ts::alphaCmd().")] },
    });
    assert.deepStrictEqual(staleFeatures(s), ["alpha"]);
    // the changedSources attributed to alpha is the file that woke it
    assert.deepStrictEqual(s.staleDocs[0].changedSources, ["src/shared.ts"]);
  });

  it("co-movement of the owning doc clears it; the other owner stays unwoken", () => {
    const s = computeChangeState({
      registry: reg(SHARED_TWO),
      changedFiles: ["src/shared.ts", "docs/features/alpha.md"],
      anchorChanges: { "src/shared.ts": [chg("src/shared.ts::alphaCmd().")] },
    });
    assert.deepStrictEqual(staleFeatures(s), []);
  });

  it("editing both owned symbols wakes both docs", () => {
    const s = computeChangeState({
      registry: reg(SHARED_TWO),
      changedFiles: ["src/shared.ts"],
      anchorChanges: {
        "src/shared.ts": [
          chg("src/shared.ts::alphaCmd()."),
          chg("src/shared.ts::betaCmd()."),
        ],
      },
    });
    assert.deepStrictEqual(staleFeatures(s), ["alpha", "beta"]);
  });
});

describe("gate wiring — concept umbrellas wake at file grain", () => {
  const FEATURE_PLUS_CONCEPT = {
    gamma: { doc: "docs/features/gamma.md", primary_sources: ["src/shared.ts"] },
    lib: { doc: "docs/concepts/lib.md", primary_sources: ["src/shared.ts"] },
  };

  it("a symbol edit wakes the owning feature AND the concept umbrella (file grain)", () => {
    const s = computeChangeState({
      registry: reg(FEATURE_PLUS_CONCEPT),
      changedFiles: ["src/shared.ts"],
      anchorChanges: { "src/shared.ts": [chg("src/shared.ts::gammaThing().")] },
    });
    assert.deepStrictEqual(staleFeatures(s), ["gamma", "lib"]);
  });

  it("a file owned ONLY by a concept wakes the concept (symbol is feature-unowned)", () => {
    const s = computeChangeState({
      registry: reg({
        lib: { doc: "docs/concepts/lib.md", primary_sources: ["src/onlylib.ts"] },
      }),
      changedFiles: ["src/onlylib.ts"],
      anchorChanges: { "src/onlylib.ts": [chg("src/onlylib.ts::helper().")] },
    });
    assert.deepStrictEqual(staleFeatures(s), ["lib"]);
  });
});

describe("gate wiring — anti-gaming / precision", () => {
  it("a cosmetic-only change (anchors present but empty) wakes nothing", () => {
    const s = computeChangeState({
      registry: reg(SHARED_TWO),
      changedFiles: ["src/shared.ts"],
      anchorChanges: { "src/shared.ts": [] },
    });
    assert.deepStrictEqual(staleFeatures(s), []);
  });

  it("a related_sources-only owner never goes stale (related = impact, not ownership)", () => {
    const s = computeChangeState({
      registry: reg({
        ...SHARED_TWO,
        solo: {
          doc: "docs/features/solo.md",
          primary_sources: ["src/solo.ts"],
          related_sources: ["src/shared.ts"],
        },
      }),
      changedFiles: ["src/shared.ts"],
      anchorChanges: { "src/shared.ts": [chg("src/shared.ts::alphaCmd().")] },
    });
    assert.deepStrictEqual(staleFeatures(s), ["alpha"]);
    assert.ok(!staleFeatures(s).includes("solo"), "solo (related-only) not woken");
  });
});

describe("gate wiring — fail loud on unresolved shared symbols", () => {
  it("an unassigned shared symbol wakes ALL candidates and lints (never silent)", () => {
    const s = computeChangeState({
      registry: reg(SHARED_TWO),
      changedFiles: ["src/shared.ts"],
      anchorChanges: { "src/shared.ts": [chg("src/shared.ts::orphan().")] },
    });
    // fail-loud: both candidates woken (never under-wake)
    assert.deepStrictEqual(staleFeatures(s), ["alpha", "beta"]);
    assert.deepStrictEqual(s.ownershipLints, [
      {
        file: "src/shared.ts",
        descriptor: "orphan().",
        kind: "unassigned",
        features: ["alpha", "beta"],
      },
    ]);
  });

  it("a symbol two owners both claim is ambiguous (woken + linted)", () => {
    const s = computeChangeState({
      registry: reg({
        alpha: {
          doc: "docs/features/alpha.md",
          primary_sources: ["src/shared.ts"],
          owned_symbols: { "src/shared.ts": ["dupe()."] },
        },
        beta: {
          doc: "docs/features/beta.md",
          primary_sources: ["src/shared.ts"],
          owned_symbols: { "src/shared.ts": ["dupe()."] },
        },
      }),
      changedFiles: ["src/shared.ts"],
      anchorChanges: { "src/shared.ts": [chg("src/shared.ts::dupe().")] },
    });
    assert.deepStrictEqual(staleFeatures(s), ["alpha", "beta"]);
    assert.deepStrictEqual(s.ownershipLints[0].kind, "ambiguous");
    assert.deepStrictEqual(s.ownershipLints[0].features, ["alpha", "beta"]);
  });
});

describe("gate wiring — file-grain fallback when anchors are absent", () => {
  it("a changed file with NO anchor data wakes every primary owner (feature + concept)", () => {
    const s = computeChangeState({
      registry: reg({
        ...SHARED_TWO,
        lib: { doc: "docs/concepts/lib.md", primary_sources: ["src/shared.ts"] },
        solo: {
          doc: "docs/features/solo.md",
          primary_sources: ["src/solo.ts"],
          related_sources: ["src/shared.ts"],
        },
      }),
      changedFiles: ["src/shared.ts"],
      // no anchorChanges → file-grain fallback
    });
    // every PRIMARY owner wakes; the related-only owner (solo) still does not
    assert.deepStrictEqual(staleFeatures(s), ["alpha", "beta", "lib"]);
  });

  it("a coarse (non-TS) primary source falls back to file grain", () => {
    const s = computeChangeState({
      registry: reg({
        cfg: { doc: "docs/features/cfg.md", primary_sources: ["src/legacy.js"] },
      }),
      changedFiles: ["src/legacy.js"],
      anchorChanges: {}, // .js is source but not precise → absent → file grain
    });
    assert.deepStrictEqual(staleFeatures(s), ["cfg"]);
  });
});

describe("gate wiring — docs-changed-without-source respects ownership", () => {
  it("a doc that moved while its owned symbol did not is 'changed without source', not stale", () => {
    const s = computeChangeState({
      registry: reg(SHARED_TWO),
      // alpha's symbol changed; beta's doc changed but beta's symbol did not
      changedFiles: ["src/shared.ts", "docs/features/beta.md"],
      anchorChanges: { "src/shared.ts": [chg("src/shared.ts::alphaCmd().")] },
    });
    assert.deepStrictEqual(staleFeatures(s), ["alpha"]);
    assert.ok(
      s.docsChangedWithoutSource.includes("docs/features/beta.md"),
      "beta doc moved without beta's owned source",
    );
  });
});

// ── End-to-end: the real anchor path (git + disk) dissolves the cascade ──────

let tmp: string;

function gitInit(root: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["add", "-A"]);
  run(["commit", "-m", "baseline"]);
}

async function scaffold(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(tmp, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

const E2E_REGISTRY = {
  features: {
    alpha: {
      doc: "docs/features/alpha.md",
      type: "feature",
      primary_sources: ["src/shared.ts"],
      owned_symbols: { "src/shared.ts": ["alphaCmd()."] },
      status: "current",
    },
    beta: {
      doc: "docs/features/beta.md",
      type: "feature",
      primary_sources: ["src/shared.ts"],
      owned_symbols: { "src/shared.ts": ["betaCmd()."] },
      status: "current",
    },
  },
};

const SHARED_SRC =
  "export function alphaCmd() {\n  return 1;\n}\n\nexport function betaCmd() {\n  return 2;\n}\n";

describe("gate wiring — end-to-end (temp git repo, real anchor diff)", () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-gate-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(E2E_REGISTRY, null, 2),
      "docs/features/alpha.md": "# alpha\n",
      "docs/features/beta.md": "# beta\n",
      "src/shared.ts": SHARED_SRC,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("editing alphaCmd's body wakes ONLY alpha — beta (same file) stays clean", async () => {
    await scaffold({
      "src/shared.ts": SHARED_SRC.replace("return 1;", "return 11;"),
    });
    const report = buildReview(tmp);
    assert.deepStrictEqual(
      report.state.staleDocs.map((d) => d.feature).sort(),
      ["alpha"],
      "only alpha's doc is stale; the cascade to beta is dissolved",
    );
  });

  it("a cosmetic reformat moves no symbol — nothing goes stale", async () => {
    // add a trailing blank line + extra indentation: token stream is unchanged
    await scaffold({
      "src/shared.ts": SHARED_SRC.replace("  return 1;", "    return 1;") + "\n",
    });
    const report = buildReview(tmp);
    assert.ok(report.changedFileCount >= 1, "git sees the file as modified");
    assert.deepStrictEqual(
      report.state.staleDocs,
      [],
      "no symbol fingerprint moved → no stale doc",
    );
  });

  // ── Phase 2d: classification routes coarse/unevaluable files to file-grain ──

  it("a parse error is surfaced AND gated file-grain (never read as fresh)", async () => {
    await scaffold({
      "src/shared.ts": SHARED_SRC + "<<<<<<< HEAD\n=======\n>>>>>>> branch\n",
    });
    const report = buildReview(tmp);
    assert.deepStrictEqual(
      report.state.unevaluable,
      ["src/shared.ts"],
      "the parse error is surfaced (fail-loud)",
    );
    // omitted from per-symbol → file-grain fallback wakes BOTH primary owners
    assert.deepStrictEqual(
      report.state.staleDocs.map((d) => d.feature).sort(),
      ["alpha", "beta"],
      "an un-evaluable owned file never reads as fresh",
    );
  });

  it("a file with no anchorable content wakes its owners file-grain (not fresh)", async () => {
    // replace the precise file with comments only: zero precise anchors. Pre-2d
    // this produced an empty anchor set that read as fresh; now it is coarse →
    // file-grain, so a real change still wakes the owning docs.
    await scaffold({
      "src/shared.ts": "// the implementation moved elsewhere\n// nothing exported here now\n",
    });
    const report = buildReview(tmp);
    assert.deepStrictEqual(report.state.unevaluable, [], "comments-only is coarse, not an error");
    assert.deepStrictEqual(
      report.state.staleDocs.map((d) => d.feature).sort(),
      ["alpha", "beta"],
      "a coarse owned file change still wakes its owners",
    );
  });
});
