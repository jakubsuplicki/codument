import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildReport } from "../src/commands/doctor.js";

// Synthetic backtest: prove the coverage score moves DOWN at known
// staleness/drift moments (an unmapped source appears, a dependency is dropped),
// deterministically and without the network. The full Peelmeal git-history
// backtest (which also exercises freshness/drift) remains the gate before the
// public README badge is exposed — see the plan's Open Questions.

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-backtest-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function scaffold(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(tmp, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

const HEALTHY_REGISTRY = {
  features: {
    a: {
      doc: "docs/features/a.md",
      type: "feature",
      primary_sources: ["src/a.ts"],
      related_sources: [],
      docs: [],
      depends_on: ["b"],
      risk: ["auth"],
      last_updated: "2026-06-16",
      status: "current",
    },
    b: {
      doc: "docs/concepts/b.md",
      type: "concept",
      primary_sources: ["src/b.ts"],
      related_sources: [],
      docs: [],
      depends_on: ["a"],
      risk: [],
      last_updated: "2026-06-16",
      status: "current",
    },
  },
};

describe("coverage score backtest (synthetic drift)", () => {
  it("drops when an unmapped source appears and a dependency is dropped", async () => {
    await scaffold({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
      "docs/features/a.md": "# a\n",
      "docs/concepts/b.md": "# b\n",
      "docs/.registry.json": JSON.stringify(HEALTHY_REGISTRY, null, 2),
    });
    const healthy = buildReport(tmp).coverage.percent;
    assert.ok(healthy !== null);

    // Drift: a new unmapped source appears, and feature `a` loses its dependency.
    const drifted = structuredClone(HEALTHY_REGISTRY);
    drifted.features.a.depends_on = [];
    await scaffold({
      "src/c.ts": "export const c = 1;\n",
      "docs/.registry.json": JSON.stringify(drifted, null, 2),
    });
    const after = buildReport(tmp).coverage.percent;
    assert.ok(after !== null);

    assert.ok(
      (after as number) < (healthy as number),
      `expected drift to lower coverage (${healthy} -> ${after})`,
    );
  });

  it("is deterministic at a fixed repo state", async () => {
    await scaffold({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
      "docs/features/a.md": "# a\n",
      "docs/concepts/b.md": "# b\n",
      "docs/.registry.json": JSON.stringify(HEALTHY_REGISTRY, null, 2),
    });
    assert.equal(buildReport(tmp).coverage.percent, buildReport(tmp).coverage.percent);
  });
});
