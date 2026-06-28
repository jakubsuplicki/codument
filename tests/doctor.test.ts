import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
    assert.equal(report.coverage.percent, 83);

    assert.equal(report.lint.byId["missing-source"], 1);
    assert.equal(report.lint.byId["generated-leakage"], 1);
    // only notifications (an island); db is a foundation auth + tasks depend on.
    assert.equal(report.lint.byId["empty-depends-on"], 1);
    assert.equal(report.lint.byId["unmapped-source"], 1);

    // high-fanout is informational, never an actionable finding: it stays out of
    // the lint count/byId and lives in notes, so "clean" can't be reached by
    // collapsing a genuinely-shared file to one owner.
    assert.equal(report.lint.byId["high-fanout"], undefined);
    assert.ok(!report.lint.findings.some((f) => f.id === "high-fanout"));
    const fanoutNotes = report.lint.notes.filter((n) => n.id === "high-fanout");
    assert.equal(fanoutNotes.length, 1);
    assert.equal(fanoutNotes[0].severity, "info");
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
    assert.equal(artifact.percent, 83);
    assert.ok(Array.isArray(artifact.ratios));

    const svg = readFileSync(svgPath, "utf-8");
    assert.match(svg, /<svg /);
    assert.match(svg, />83%</);
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
    assert.equal(report.coverage.percent, 83);
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

describe("codument doctor --strict (CLI gating)", () => {
  function run(args: string[], cwd: string): { status: number; stdout: string } {
    try {
      const stdout = execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8" });
      return { status: 0, stdout };
    } catch (err) {
      // execFileSync throws on a nonzero exit; capture the status and stdout.
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
  }

  let clean: string;
  let missing: string;
  beforeEach(async () => {
    clean = await mkdtemp(join(tmpdir(), "codument-strict-clean-"));
    await mkdir(join(clean, "docs"), { recursive: true });
    await writeFile(
      join(clean, "docs", ".registry.json"),
      JSON.stringify({ features: {} }),
    );
    missing = await mkdtemp(join(tmpdir(), "codument-strict-missing-"));
  });
  afterEach(async () => {
    await rm(clean, { recursive: true, force: true });
    await rm(missing, { recursive: true, force: true });
  });

  it("exits 1 on the dirty fixture when findings are present", () => {
    assert.equal(run(["doctor", "--strict"], FIXTURE).status, 1);
  });

  it("leaves bare doctor at exit 0 on the same dirty fixture", () => {
    assert.equal(run(["doctor"], FIXTURE).status, 0);
  });

  it("exits 0 with --strict on a clean repo (no findings)", () => {
    assert.equal(run(["doctor", "--strict"], clean).status, 0);
  });

  it("exits 1 with --strict --json but keeps the JSON contract byte-identical", () => {
    const plain = run(["doctor", "--json"], FIXTURE);
    const strict = run(["doctor", "--json", "--strict"], FIXTURE);
    assert.equal(plain.status, 0);
    assert.equal(strict.status, 1);
    // --strict must not change stdout: same JSON either way, only the exit differs.
    assert.equal(strict.stdout, plain.stdout);
    assert.ok(JSON.parse(strict.stdout).lint.count > 0);
  });

  it("exits 1 with --strict on a missing-registry repo", () => {
    assert.equal(run(["doctor", "--strict"], missing).status, 1);
  });
});
