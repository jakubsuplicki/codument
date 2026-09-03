import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "../src/lib/registry.js";
import { computeTestImpact } from "../src/lib/test-impact.js";

function registry(): Registry {
  return {
    features: {
      alpha: {
        doc: "docs/features/alpha.md",
        type: "feature",
        primary_sources: ["src/alpha.ts"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      },
      beta: {
        doc: "docs/features/beta.md",
        type: "feature",
        primary_sources: ["src/beta.ts"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      },
      consumer: {
        doc: "docs/features/consumer.md",
        type: "feature",
        primary_sources: ["src/consumer.ts"],
        related_sources: [],
        docs: [],
        depends_on: ["alpha"],
        risk: [],
        status: "current",
      },
    },
  };
}

function reader(files: Record<string, string>): (path: string) => string | null {
  return (path) => files[path] ?? null;
}

describe("computeTestImpact", () => {
  it("treats an explicit invariant pin as authoritative over imports", () => {
    const files = {
      "docs/features/alpha.md":
        "## Invariants & boundaries\n\n- Alpha stays stable. *(test: shared.test.ts)*\n",
      "docs/features/beta.md": "## Invariants & boundaries\n\n- Beta stays stable. *(untested)*\n",
      "docs/features/consumer.md":
        "## Invariants & boundaries\n\n- Consumer stays stable. *(untested)*\n",
      "tests/shared.test.ts": 'import { beta } from "../src/beta.js";\n',
    };

    assert.deepEqual(
      computeTestImpact({
        changedPaths: ["tests/shared.test.ts"],
        registry: registry(),
        readText: reader(files),
      }),
      {
        changedTests: ["tests/shared.test.ts"],
        attributed: [{ test: "tests/shared.test.ts", feature: "alpha", via: "invariant-pin" }],
        unattributed: [],
        dependents: [{ feature: "consumer", dependsOn: "alpha" }],
        dependentsSummary: [{ feature: "consumer", dependsOn: ["alpha"], viaUmbrella: false }],
      },
    );
  });

  it("falls back to supported direct TypeScript imports", () => {
    const files = {
      "docs/features/alpha.md": "## Invariants & boundaries\n\n- Alpha. *(untested)*\n",
      "docs/features/beta.md": "## Invariants & boundaries\n\n- Beta. *(untested)*\n",
      "docs/features/consumer.md": "## Invariants & boundaries\n\n- Consumer. *(untested)*\n",
      "tests/beta.test.ts": [
        'import { beta } from "../src/beta.js";',
        'import { alpha } from "../src/alpha.js";',
      ].join("\n"),
    };

    assert.deepEqual(
      computeTestImpact({
        changedPaths: ["tests/beta.test.ts"],
        registry: registry(),
        readText: reader(files),
      }),
      {
        changedTests: ["tests/beta.test.ts"],
        attributed: [
          { test: "tests/beta.test.ts", feature: "alpha", via: "direct-import" },
          { test: "tests/beta.test.ts", feature: "beta", via: "direct-import" },
        ],
        unattributed: [],
        dependents: [{ feature: "consumer", dependsOn: "alpha" }],
        dependentsSummary: [{ feature: "consumer", dependsOn: ["alpha"], viaUmbrella: false }],
      },
    );
  });

  it("names unsupported, unreadable, and unowned tests instead of guessing", () => {
    const files = {
      "docs/features/alpha.md": "## Invariants & boundaries\n\n- Alpha. *(untested)*\n",
      "docs/features/beta.md": "## Invariants & boundaries\n\n- Beta. *(untested)*\n",
      "docs/features/consumer.md": "## Invariants & boundaries\n\n- Consumer. *(untested)*\n",
      "tests/unowned.test.ts": 'import external from "external-package";\n',
      "tests/python_test.py": "from app import alpha\n",
    };

    assert.deepEqual(
      computeTestImpact({
        changedPaths: [
          "tests/removed.test.ts",
          "tests/python_test.py",
          "tests/unowned.test.ts",
          "src/alpha.ts",
        ],
        registry: registry(),
        readText: reader(files),
      }),
      {
        changedTests: ["tests/python_test.py", "tests/removed.test.ts", "tests/unowned.test.ts"],
        attributed: [],
        unattributed: ["tests/python_test.py", "tests/removed.test.ts", "tests/unowned.test.ts"],
        dependents: [],
        dependentsSummary: [],
      },
    );
  });

  it("attributes a deleted test from its surviving invariant pin", () => {
    const files = {
      "docs/features/alpha.md":
        "## Invariants & boundaries\n\n- Alpha stays stable. *(test: tests/removed.test.ts)*\n",
      "docs/features/beta.md": "## Invariants & boundaries\n\n- Beta. *(untested)*\n",
      "docs/features/consumer.md": "## Invariants & boundaries\n\n- Consumer. *(untested)*\n",
    };

    const impact = computeTestImpact({
      changedPaths: ["tests/removed.test.ts"],
      registry: registry(),
      readText: reader(files),
    });
    assert.deepEqual(impact.attributed, [
      { test: "tests/removed.test.ts", feature: "alpha", via: "invariant-pin" },
    ]);
    assert.deepEqual(impact.unattributed, []);
    assert.deepEqual(impact.dependents, [{ feature: "consumer", dependsOn: "alpha" }]);
  });
});
