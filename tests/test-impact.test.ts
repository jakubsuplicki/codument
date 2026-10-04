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
  it("retains prior test evidence when its destination is no longer a selected test", () => {
    const registry: Registry = { features: { alpha: {
      doc: "docs/alpha.md", type: "feature", primary_sources: ["src/a.ts"], related_sources: [],
      docs: [], depends_on: [], risk: ["security"], status: "current",
    } } };
    const impact = computeTestImpact({ changedPaths: ["build/old.ts"], registry,
      readText: () => null, before: { registry, changedPaths: ["tests/old.test.ts"],
        readText: (path) => path === "tests/old.test.ts" ? 'import { a } from "../src/a.js";' : null } });
    assert.deepEqual(impact.changedTests, []);
    assert.deepEqual(impact.before?.attributed, [{ test: "tests/old.test.ts", feature: "alpha", via: "direct-import" }]);
  });
  it("resolves an unchanged root pin before attributing a changed duplicate basename", () => {
    const impact = computeTestImpact({
      changedPaths: ["tests/shared.test.ts"],
      registry: registry(),
      readText: reader({
        "docs/features/alpha.md": "## Invariants & boundaries\n\n- Alpha stays stable. *(test: shared.test.ts)*\n",
        "shared.test.ts": "// The actual invariant test is unchanged.\n",
        "tests/shared.test.ts": 'import { beta } from "../src/beta.js";\n',
      }),
    });
    assert.deepEqual(impact.attributed, [
      { test: "tests/shared.test.ts", feature: "beta", via: "direct-import" },
    ]);
    assert.deepEqual(impact.dependents, []);
  });

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

  it("keeps changed and removed imports attributed in their original snapshot", () => {
    const impact = computeTestImpact({
      changedPaths: ["tests/changed.test.ts", "tests/lost.test.ts"],
      registry: registry(),
      readText: reader({
        "tests/changed.test.ts": 'import { beta } from "../src/beta.js";\n',
        "tests/lost.test.ts": "// The original source import was removed.\n",
      }),
      before: {
        registry: registry(),
        readText: reader({
          "tests/changed.test.ts": 'import { alpha } from "../src/alpha.js";\n',
          "tests/lost.test.ts": 'import { alpha } from "../src/alpha.js";\n',
        }),
      },
    });
    assert.deepEqual(impact.attributed, [
      { test: "tests/changed.test.ts", feature: "beta", via: "direct-import" },
    ]);
    assert.deepEqual(impact.unattributed, ["tests/lost.test.ts"]);
    assert.deepEqual(impact.before, {
      attributed: [
        { test: "tests/changed.test.ts", feature: "alpha", via: "direct-import" },
        { test: "tests/lost.test.ts", feature: "alpha", via: "direct-import" },
      ],
      unattributed: [],
    });
    assert.deepEqual(impact.dependents, [{ feature: "consumer", dependsOn: "alpha" }]);
  });

  it("preserves old authoritative pins when selected pins change or disappear", () => {
    const files = {
      "tests/changed.test.ts": 'import { beta } from "../src/beta.js";\n',
      "tests/lost.test.ts": 'import { beta } from "../src/beta.js";\n',
    };
    const impact = computeTestImpact({
      changedPaths: Object.keys(files),
      registry: registry(),
      readText: reader({
        ...files,
        "docs/features/beta.md":
          "## Invariants & boundaries\n\n- Beta stays stable. *(test: tests/changed.test.ts)*\n",
      }),
      before: {
        registry: registry(),
        readText: reader({
          ...files,
          "docs/features/alpha.md":
            "## Invariants & boundaries\n\n- Alpha stays stable. *(tests: tests/changed.test.ts, tests/lost.test.ts)*\n",
        }),
      },
    });
    assert.deepEqual(impact.attributed, [
      { test: "tests/changed.test.ts", feature: "beta", via: "invariant-pin" },
      { test: "tests/lost.test.ts", feature: "beta", via: "direct-import" },
    ]);
    assert.deepEqual(impact.before, {
      attributed: [
        { test: "tests/changed.test.ts", feature: "alpha", via: "invariant-pin" },
        { test: "tests/lost.test.ts", feature: "alpha", via: "invariant-pin" },
      ],
      unattributed: [],
    });
  });

  it("merges old and current dependency edges without losing removed dependencies or duplicating survivors", () => {
    const beforeRegistry = registry();
    const selectedRegistry = registry();
    selectedRegistry.features.consumer.depends_on = ["beta", "alpha"];
    const impact = computeTestImpact({
      changedPaths: ["tests/shared.test.ts"],
      registry: selectedRegistry,
      readText: reader({
        "tests/shared.test.ts": [
          'import { beta } from "../src/beta.js";',
          'import { alpha } from "../src/alpha.js";',
        ].join("\n"),
      }),
      before: {
        registry: beforeRegistry,
        readText: reader({
          "tests/shared.test.ts": 'import { alpha } from "../src/alpha.js";\n',
        }),
      },
    });
    assert.deepEqual(impact.dependents, [
      { feature: "consumer", dependsOn: "alpha" },
      { feature: "consumer", dependsOn: "beta" },
    ]);
    assert.deepEqual(impact.dependentsSummary, [
      { feature: "consumer", dependsOn: ["alpha", "beta"], viaUmbrella: false },
    ]);

    selectedRegistry.features.consumer.depends_on = [];
    const removedEdge = computeTestImpact({
      changedPaths: ["tests/shared.test.ts"],
      registry: selectedRegistry,
      readText: reader({ "tests/shared.test.ts": 'import { beta } from "../src/beta.js";\n' }),
      before: {
        registry: beforeRegistry,
        readText: reader({ "tests/shared.test.ts": 'import { alpha } from "../src/alpha.js";\n' }),
      },
    });
    assert.deepEqual(removedEdge.dependents, [{ feature: "consumer", dependsOn: "alpha" }]);
    assert.deepEqual(removedEdge.dependentsSummary, [
      { feature: "consumer", dependsOn: ["alpha"], viaUmbrella: false },
    ]);
  });

  it("reports newly attributable tests as unattributed at the base", () => {
    const impact = computeTestImpact({
      changedPaths: ["tests/new.test.ts"],
      registry: registry(),
      readText: reader({ "tests/new.test.ts": 'import { alpha } from "../src/alpha.js";\n' }),
      before: { registry: registry(), readText: reader({}) },
    });
    assert.deepEqual(impact.attributed, [
      { test: "tests/new.test.ts", feature: "alpha", via: "direct-import" },
    ]);
    assert.deepEqual(impact.before, { attributed: [], unattributed: ["tests/new.test.ts"] });
  });
});
