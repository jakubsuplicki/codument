import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ReviewReport } from "../src/commands/review.js";
import { gateUnavailableSarif, reviewReportToSarif } from "../src/lib/sarif.js";

// A ReviewReport exercising every SARIF-projected finding kind at once: two stale
// docs (one enriched by a per-symbol drift move, one not), an unmapped source, an
// out-of-plan file, and an ambiguous ownership lint. Kept inline (not a fixture
// module) so it rides the test-file exclusion rather than reading as unmapped source.
const EVERY_FINDING_REPORT: ReviewReport = {
  version: 2,
  gate: "ok",
  isGitRepo: true,
  changedFileCount: 5,
  deletions: [],
  plan: null,
  state: {
    changedSources: ["src/auth/login.ts", "src/lib/cache.ts", "src/shared/util.ts"],
    changedDocs: [],
    byFeature: [],
    unmapped: ["src/lib/cache.ts"],
    otherChanged: [],
    excludedChanged: [],
    staleDocs: [
      { feature: "auth", doc: "docs/features/auth.md", changedSources: ["src/auth/login.ts"] },
      { feature: "billing", doc: "docs/features/billing.md", changedSources: ["src/billing/charge.ts"] },
    ],
    docsChangedWithoutSource: [],
    highFanout: [],
    riskTouches: [],
    dependents: [],
    dependentsSummary: [],
    outOfPlan: ["src/experimental/spike.ts"],
    planScoped: true,
    ownershipLints: [
      {
        file: "src/shared/util.ts",
        descriptor: "format",
        kind: "ambiguous",
        features: ["auth", "billing"],
      },
    ],
    unevaluable: ["src/legacy/broken.ts"],
    deletedSources: [],
    ungatedRegistered: [],
    governedRegistered: [],
    governedDeleted: [],
    // Both pointer shapes, because they render different messages and a CI check
    // failing on one of them alone used to upload a SARIF with no results at all.
    registryPointers: [
      {
        file: "src/i18n/format.ts",
        features: ["i18n"],
        kind: "renamed",
        renamedTo: "src/i18n/dateFormat.ts",
      },
      { file: "src/legacy/dropped.ts", features: ["auth", "billing"], kind: "deleted" },
    ],
    // The prose pointer beside them. It blocks `--strict` on the same terms, so it
    // needs a rule here on the same terms: a blocking input with no projection uploads
    // as a clean pass beside a check that exited 1.
    docPointers: [
      { doc: "docs/features/i18n.md", paths: ["src/i18n/format.ts", "src/legacy/dropped.ts"] },
    ],
  },
  drift: [
    {
      anchorId: "src/auth/login.ts::login",
      symbol: "login",
      kind: "changed",
      feature: "auth",
      doc: "docs/features/auth.md",
      from: "aaaa1111",
      to: "bbbb2222",
      signatureChanged: false,
      comovement: "not-referenced",
      acknowledged: false,
    },
  ],
  fileGrainAcked: [],
  coveringAcks: [],
  requireIndependentAck: false,
  independenceUnverifiable: false,
};

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", "sarif", name), "utf-8");
const serialize = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

describe("reviewReportToSarif", () => {
  it("maps every finding kind to the checked-in golden SARIF (byte-exact)", () => {
    // Golden regression: a ReviewReport with stale-doc (enriched + plain), unmapped,
    // out-of-plan, and ownership-lint findings -> the hand-verified fixture. Any change
    // to the mapping shape, rule catalog, message text, or ordering trips this.
    const sarif = serialize(reviewReportToSarif(EVERY_FINDING_REPORT));
    assert.equal(sarif, fixture("every-finding.sarif.json"));
  });

  it("is byte-identical across runs (no wall clock, deterministic sort)", () => {
    const a = serialize(reviewReportToSarif(EVERY_FINDING_REPORT));
    const b = serialize(reviewReportToSarif(EVERY_FINDING_REPORT));
    assert.equal(a, b);
    assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T|"startTimeUtc"|"endTimeUtc"/, "no timestamps");
  });

  it("results are sorted and every ruleId is in the advertised rule catalog", () => {
    const sarif = reviewReportToSarif(EVERY_FINDING_REPORT);
    const run = sarif.runs[0];
    const ruleIds = new Set(run.tool.driver.rules.map((r) => r.id));
    for (const result of run.results) {
      assert.ok(ruleIds.has(result.ruleId), `${result.ruleId} is a declared rule`);
    }
    const keys = run.results.map(
      (r) => `${r.ruleId} ${r.locations[0].physicalLocation.artifactLocation.uri} ${r.message.text}`,
    );
    assert.deepEqual(keys, [...keys].sort(), "results are in deterministic (rule, uri, message) order");
  });

  it("enriches a stale-doc with the moved symbol + transition, and relates the changed source", () => {
    const sarif = reviewReportToSarif(EVERY_FINDING_REPORT);
    const auth = sarif.runs[0].results.find((r) => r.message.text.includes('"auth"'));
    assert.ok(auth);
    assert.match(auth.message.text, /Moved: login \(aaaa1111→bbbb2222\)/);
    assert.equal(auth.locations[0].physicalLocation.artifactLocation.uri, "docs/features/auth.md");
    assert.equal(auth.relatedLocations?.[0].physicalLocation.artifactLocation.uri, "src/auth/login.ts");
    // billing has no drift finding -> no "Moved:" clause and (still) a related source.
    const billing = sarif.runs[0].results.find((r) => r.message.text.includes('"billing"'));
    assert.ok(billing && !/Moved:/.test(billing.message.text));
  });

  it("a clean report yields zero results but a full rule catalog", () => {
    const clean = structuredClone(EVERY_FINDING_REPORT);
    clean.state.staleDocs = [];
    clean.state.unmapped = [];
    clean.state.outOfPlan = [];
    clean.state.ownershipLints = [];
    clean.state.unevaluable = [];
    clean.state.registryPointers = [];
    clean.state.docPointers = [];
    const sarif = reviewReportToSarif(clean);
    assert.equal(sarif.runs[0].results.length, 0);
    assert.equal(sarif.runs[0].tool.driver.rules.length, 7, "the catalog is advertised regardless");
  });
});

describe("gateUnavailableSarif", () => {
  it("matches the checked-in golden and marks the invocation unsuccessful (byte-exact)", () => {
    // The fail-closed contract in SARIF form: no results, but executionSuccessful:false
    // + an error notification, so "0 results" is never read as "clean".
    const sarif = serialize(gateUnavailableSarif("not a git repository"));
    assert.equal(sarif, fixture("gate-unavailable.sarif.json"));
    const parsed = gateUnavailableSarif("not a git repository");
    assert.equal(parsed.runs[0].invocations?.[0].executionSuccessful, false);
    assert.equal(parsed.runs[0].results.length, 0);
    assert.match(
      parsed.runs[0].invocations?.[0].toolExecutionNotifications[0].message.text ?? "",
      /gate could not run: not a git repository/,
    );
  });
});

describe("review --format sarif (e2e)", () => {
  let tmp: string;
  const CLI = join(here, "..", "dist", "cli.js");
  const REGISTRY = {
    features: {
      auth: {
        doc: "docs/features/auth.md",
        type: "feature",
        primary_sources: ["src/auth/login.ts"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      },
    },
  };

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-sarif-e2e-"));
    await mkdir(join(tmp, "src", "auth"), { recursive: true });
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await writeFile(join(tmp, "docs", ".registry.json"), JSON.stringify(REGISTRY, null, 2));
    await writeFile(join(tmp, "docs", "features", "auth.md"), "# auth\n");
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const login = () => 1;\n");
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: tmp,
        stdio: "ignore",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    git(["init"]);
    git(["config", "user.email", "t@e.com"]);
    git(["config", "user.name", "T"]);
    git(["add", "-A"]);
    git(["commit", "-m", "baseline"]);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const runSarif = (args: string[] = []) => {
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [CLI, "review", "--format", "sarif", ...args], {
        cwd: tmp,
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    return { status, stdout };
  };

  it("emits a stale-doc SARIF result on a real change, byte-identical across runs", async () => {
    // Change the source, leave its doc alone → the gate flags auth stale; SARIF must
    // carry it as a codument/stale-doc result anchored at the doc.
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const login = () => 2;\n");
    const first = runSarif();
    const second = runSarif();
    assert.equal(first.stdout, second.stdout, "SARIF is byte-identical across runs");
    const sarif = JSON.parse(first.stdout);
    assert.equal(sarif.version, "2.1.0");
    const stale = sarif.runs[0].results.find((r: { ruleId: string }) => r.ruleId === "codument/stale-doc");
    assert.ok(stale, "the stale auth doc appears as a SARIF result");
    assert.equal(stale.locations[0].physicalLocation.artifactLocation.uri, "docs/features/auth.md");
  });

  it("--strict --format sarif exits 1 on drift, 0 when clean (stdout is SARIF either way)", async () => {
    // Clean tree: SARIF with zero results, exit 0.
    const clean = runSarif(["--strict"]);
    assert.equal(clean.status, 0);
    assert.equal(JSON.parse(clean.stdout).runs[0].results.length, 0);
    // Drift: same SARIF shape, exit 1 — the exit code comes from --strict, not the format.
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const login = () => 3;\n");
    const dirty = runSarif(["--strict"]);
    assert.equal(dirty.status, 1);
    assert.ok(JSON.parse(dirty.stdout).runs[0].results.length > 0);
  });

  it("a subdirectory root emits the gate-unavailable SARIF and exits 1 (distinct from the non-git branch)", async () => {
    // The wrong-root GateError path is a separate branch from the non-git guard: it
    // must also project to an unsuccessful-invocation SARIF, never human text or a
    // green document, so a CI job run from the wrong directory fails loud.
    await mkdir(join(tmp, "sub"), { recursive: true });
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [CLI, "review", "--format", "sarif"], {
        cwd: join(tmp, "sub"),
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    assert.equal(status, 1, "wrong-root fails closed under SARIF");
    const sarif = JSON.parse(stdout);
    assert.equal(sarif.runs[0].invocations[0].executionSuccessful, false);
    assert.match(
      sarif.runs[0].invocations[0].toolExecutionNotifications[0].message.text,
      /subdirectory/,
    );
  });

  it("a non-git tree emits the gate-unavailable SARIF AND exits 1 (shape and exit agree)", async () => {
    // Even bare (no --strict): the SARIF's executionSuccessful:false must be matched by
    // a nonzero exit, so a CI gating on the exit code alone never reads a gate that
    // could not run as green.
    const nogit = await mkdtemp(join(tmpdir(), "codument-sarif-nogit-"));
    await mkdir(join(nogit, "docs"), { recursive: true });
    await writeFile(join(nogit, "docs", ".registry.json"), JSON.stringify({ features: {} }));
    try {
      let status = 0;
      let stdout = "";
      try {
        stdout = execFileSync("node", [CLI, "review", "--format", "sarif"], {
          cwd: nogit,
          encoding: "utf-8",
        });
      } catch (err) {
        const e = err as { status?: number; stdout?: string };
        status = e.status ?? 1;
        stdout = e.stdout ?? "";
      }
      assert.equal(status, 1, "non-git --format sarif exits nonzero even without --strict");
      const sarif = JSON.parse(stdout);
      assert.equal(sarif.runs[0].invocations[0].executionSuccessful, false);
      assert.equal(sarif.runs[0].results.length, 0);
    } finally {
      await rm(nogit, { recursive: true, force: true });
    }
  });

  const usageError = (args: string[]) => {
    let status = 0;
    let stdout = "";
    try {
      execFileSync("node", [CLI, "review", "--format", "sarif", ...args], {
        cwd: tmp,
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    return { status, stdout };
  };

  it("--format sarif with --json/--bundle/--record is a usage error, never a silent override", () => {
    // Each of these would otherwise hand CI a non-SARIF document (--json's own shape,
    // the review bundle, or the --record success line), so all three are rejected.
    for (const conflicting of [["--json"], ["--bundle"], ["--record", "findings.json"]]) {
      const { status, stdout } = usageError(conflicting);
      assert.equal(status, 1, `--format sarif ${conflicting[0]} exits 1`);
      assert.match(stdout, /cannot combine|mutually exclusive/);
    }
  });

  it("projects an unparseable file as a codument/unevaluable result (no false-green)", () => {
    const sarif = reviewReportToSarif({
      ...EVERY_FINDING_REPORT,
      state: { ...EVERY_FINDING_REPORT.state, unevaluable: ["src/legacy/broken.ts"] },
    });
    const unevaluable = sarif.runs[0].results.find((r) => r.ruleId === "codument/unevaluable");
    assert.ok(unevaluable, "the parse-error file rides SARIF, matching the human warning");
    assert.equal(unevaluable.locations[0].physicalLocation.artifactLocation.uri, "src/legacy/broken.ts");
  });

  it("carries a review-gate block as an unsuccessful-invocation notification (never a clean pass)", () => {
    // The adversarial-review gate has no result representation; a block must still make
    // the SARIF non-clean so an exit-1 --require-review run is not uploaded as green.
    const sarif = reviewReportToSarif(EVERY_FINDING_REPORT, ["adversarial review gate blocked: ..."]);
    assert.equal(sarif.runs[0].invocations?.[0].executionSuccessful, false);
    assert.match(
      sarif.runs[0].invocations?.[0].toolExecutionNotifications[0].message.text ?? "",
      /review gate blocked/,
    );
    // Without a notification the clean run has no invocations block (byte-identical to before).
    assert.equal(reviewReportToSarif(EVERY_FINDING_REPORT).runs[0].invocations, undefined);
  });
});

// A dependency-free validator over the subset of JSON Schema Draft-07 the vendored
// SARIF 2.1.0 schema uses on the paths codument emits: $ref (internal only), type,
// properties, required, additionalProperties:false, items, enum, minimum, and anyOf
// (at-least-one). Deliberately an UNDER-approximation of full JSON Schema — it never
// falsely rejects valid output, and it DOES catch the realistic mapper bugs: an
// unknown/typo'd property (additionalProperties:false), a missing required field, or
// an out-of-enum level. No ajv, no network — the schema is a checked-in fixture.
interface SchemaNode {
  $ref?: string;
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  enum?: unknown[];
  minimum?: number;
  anyOf?: SchemaNode[];
  definitions?: Record<string, SchemaNode>;
}

function schemaErrors(schema: SchemaNode, value: unknown): string[] {
  const errors: string[] = [];
  const deref = (node: SchemaNode | undefined): SchemaNode | undefined => {
    let n = node;
    let guard = 0;
    while (n?.$ref && guard++ < 50) {
      n = schema.definitions?.[n.$ref.replace("#/definitions/", "")];
    }
    return n;
  };
  const typeOk = (t: string, v: unknown): boolean =>
    t === "object"
      ? typeof v === "object" && v !== null && !Array.isArray(v)
      : t === "array"
        ? Array.isArray(v)
        : t === "string"
          ? typeof v === "string"
          : t === "boolean"
            ? typeof v === "boolean"
            : t === "integer"
              ? Number.isInteger(v)
              : t === "number"
                ? typeof v === "number"
                : true;
  const check = (raw: SchemaNode, v: unknown, path: string): void => {
    const node = deref(raw);
    if (!node) return;
    if (node.type && !typeOk(node.type, v)) {
      errors.push(`${path}: expected ${node.type}, got ${Array.isArray(v) ? "array" : typeof v}`);
      return;
    }
    if (node.enum && !node.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} not in enum`);
    if (typeof v === "number" && node.minimum !== undefined && v < node.minimum) {
      errors.push(`${path}: ${v} < minimum ${node.minimum}`);
    }
    if (Array.isArray(v)) {
      if (node.items) {
        const items = node.items;
        v.forEach((item, i) => {
          check(items, item, `${path}[${i}]`);
        });
      }
      return;
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const props = node.properties ?? {};
      for (const req of node.required ?? []) {
        if (!(req in obj)) errors.push(`${path}: missing required "${req}"`);
      }
      if (node.additionalProperties === false) {
        for (const k of Object.keys(obj)) {
          if (!(k in props)) errors.push(`${path}: unknown property "${k}"`);
        }
      }
      for (const [k, val] of Object.entries(obj)) {
        if (props[k]) check(props[k], val, `${path}.${k}`);
      }
      if (node.anyOf) {
        const ok = node.anyOf.some((branch) => {
          const b = deref(branch);
          return b?.required ? b.required.every((r) => r in obj) : true;
        });
        if (!ok) errors.push(`${path}: satisfies none of anyOf`);
      }
    }
  };
  check(schema, value, "$");
  return errors;
}

describe("SARIF conforms to the vendored 2.1.0 schema (no network, no validator dep)", () => {
  const here2 = dirname(fileURLToPath(import.meta.url));
  const schema: SchemaNode = JSON.parse(
    readFileSync(join(here2, "fixtures", "sarif", "sarif-2.1.0.schema.json"), "utf-8"),
  );

  it("the every-finding SARIF validates against the schema", () => {
    assert.deepEqual(schemaErrors(schema, reviewReportToSarif(EVERY_FINDING_REPORT)), []);
  });

  it("the gate-unavailable SARIF validates against the schema", () => {
    assert.deepEqual(schemaErrors(schema, gateUnavailableSarif("not a git repository")), []);
  });

  it("the validator has teeth: an unknown property or bad enum is caught", () => {
    // Guard against a validator that silently passes everything (the failure mode of a
    // hand-rolled check): corrupt a valid document and confirm it is rejected.
    const good = reviewReportToSarif(EVERY_FINDING_REPORT) as unknown as {
      runs: { results: { ruleId: string; level: string; bogusField?: boolean }[] }[];
    };
    const unknownProp = structuredClone(good);
    unknownProp.runs[0].results[0].bogusField = true;
    assert.ok(
      schemaErrors(schema, unknownProp).some((e) => /unknown property "bogusField"/.test(e)),
      "an unknown property is rejected (additionalProperties:false)",
    );
    const badEnum = structuredClone(good);
    badEnum.runs[0].results[0].level = "catastrophic";
    assert.ok(
      schemaErrors(schema, badEnum).some((e) => /not in enum/.test(e)),
      "an out-of-enum level is rejected",
    );
  });
});
