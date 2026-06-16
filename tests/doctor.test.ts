import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildReport, writeCoverageArtifacts } from "../src/commands/doctor.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const FIXTURE = join(
  here,
  "..",
  "fixtures",
  "benchmarks",
  "change-control",
  "project",
);

describe("buildReport (change-control fixture)", () => {
  it("reports the golden coverage percent and lint composition", () => {
    const report = buildReport(FIXTURE);

    assert.equal(report.registryExists, true);
    assert.equal(report.version, 1);
    assert.equal(report.inScopeSourceCount, 6);
    assert.equal(report.coverage.percent, 78);

    assert.equal(report.lint.byId["missing-source"], 1);
    assert.equal(report.lint.byId["generated-leakage"], 1);
    assert.equal(report.lint.byId["high-fanout"], 1);
    assert.equal(report.lint.byId["empty-depends-on"], 2);
    assert.equal(report.lint.byId["unmapped-source"], 1);
  });

  it("is deterministic across runs", () => {
    assert.deepStrictEqual(buildReport(FIXTURE), buildReport(FIXTURE));
  });
});

describe("buildReport (missing registry)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-doctor-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("prepends a missing-registry warning instead of failing", () => {
    const report = buildReport(tmp);
    assert.equal(report.registryExists, false);
    assert.equal(report.lint.byId["missing-registry"], 1);
  });
});

describe("writeCoverageArtifacts", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-cov-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes a deterministic coverage.json and an SVG badge", () => {
    const report = buildReport(FIXTURE);
    const { jsonPath, svgPath } = writeCoverageArtifacts(tmp, report);

    const artifact = JSON.parse(readFileSync(jsonPath, "utf-8"));
    assert.equal(artifact.version, 1);
    assert.equal(artifact.percent, 78);
    assert.ok(Array.isArray(artifact.ratios));

    const svg = readFileSync(svgPath, "utf-8");
    assert.match(svg, /<svg /);
    assert.match(svg, />78%</);
  });
});

describe("codument doctor (CLI)", () => {
  it("--json emits the stable contract and exits 0", () => {
    const out = execFileSync("node", [CLI, "doctor", "--json"], {
      cwd: FIXTURE,
      encoding: "utf-8",
    });
    const report = JSON.parse(out);
    assert.equal(report.version, 1);
    assert.equal(report.coverage.percent, 78);
    assert.ok(Array.isArray(report.lint.findings));
  });

  it("human output leads with documentation coverage", () => {
    const out = execFileSync("node", [CLI, "doctor"], {
      cwd: FIXTURE,
      encoding: "utf-8",
    });
    assert.ok(out.includes("Documentation coverage"));
    assert.ok(out.includes("ownership"));
  });
});
