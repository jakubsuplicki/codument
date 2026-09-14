import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const CLI = resolve(process.cwd(), "dist", "cli.js");

describe("codument verify", () => {
  let repo: string;

  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      windowsHide: true,
    }).trim();

  const put = async (path: string, content: string): Promise<void> => {
    const absolute = join(repo, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  };

  const verify = (args: string[] = []) =>
    spawnSync(process.execPath, [CLI, "verify", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", GIT_CONFIG_NOSYSTEM: "1" },
      windowsHide: true,
    });

  const receiptPath = (): string => {
    const path = git(["rev-parse", "--git-path", "codument/verify-receipt.json"]);
    return resolve(repo, path);
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codument verify "));
    git(["init", "-q"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    await put(
      "docs/.registry.json",
      JSON.stringify(
        {
          features: {
            alpha: {
              doc: "docs/features/alpha.md",
              type: "feature",
              primary_sources: ["src/a.ts"],
              related_sources: [],
              docs: [],
              depends_on: [],
              risk: [],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    );
    await put(
      "docs/features/alpha.md",
      [
        "---",
        "title: Alpha",
        "status: current",
        "type: feature",
        "last_reviewed: 2026-09-03",
        "---",
        "",
        "# Alpha",
        "",
        "## In plain terms",
        "",
        "Alpha returns a stable numeric value.",
        "",
        "## Design approach",
        "",
        "The public function owns the value.",
        "",
        "## Invariants & boundaries",
        "",
        "- Alpha returns a number. *(test: tests/alpha.test.ts)*",
        "",
        "## Decisions",
        "",
        "- Keep the surface synchronous.",
        "",
        "## Key files",
        "",
        "- `src/a.ts`",
        "",
      ].join("\n"),
    );
    await put("src/a.ts", "export function a(): number { return 1; }\n");
    await put("tests/alpha.test.ts", 'import { a } from "../src/a.js";\nvoid a();\n');
    git(["add", "."]);
    git(["commit", "-qm", "baseline"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 60, retryDelay: 300 });
  });

  it("keeps named-test evidence and execution in the index despite unrelated dirty inputs", async () => {
    await put(".codument-meta.json", JSON.stringify({ testCommand: "node --test {file}" }));
    await put("tests/proof.test.cjs", 'const {test}=require("node:test"); const assert=require("node:assert/strict"); test("proof",()=>assert.equal(require("./value.cjs"),1));\n');
    await put("tests/value.cjs", "module.exports=1;\n");
    git(["add", "."]);
    git(["commit", "-qm", "tracked runner and finding test"]);
    await put("src/a.ts", "export function a(value: string): string { return value; }\n");
    await put("docs/features/alpha.md", "# Alpha\n\n## Invariants & boundaries\n\n- Returns a string. *(test: tests/proof.test.cjs)*\n");
    git(["add", "src/a.ts", "docs/features/alpha.md"]);
    assert.equal(verify().status, 1);
    const worksheet = JSON.parse(await readFile(join(repo, ".codument/review-worksheet.json"), "utf8"));
    worksheet.invariantsChecked = ["Selected source and named test checked"];
    worksheet.signer = "fixture reviewer";
    worksheet.findings = [{citation: "src/a.ts:1", detail: "Resolved fixture finding", failingTest: "tests/proof.test.cjs", status: "resolved"}];
    await put(".codument/review-worksheet.json", JSON.stringify(worksheet));
    const recorded = verify(["--record", ".codument/review-worksheet.json"]);
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);

    await put("tests/proof.test.cjs", "throw new Error('unstaged test must not run');\n");
    await put("tests/value.cjs", "module.exports=2;\n");
    await put(".codument-meta.json", JSON.stringify({ testCommand: "missing-runner {file}" }));
    assert.equal(verify().status, 0);
    const detailed = verify(["--json"]);
    assert.equal(detailed.status, 0, detailed.stdout + detailed.stderr);
    const result = JSON.parse(detailed.stdout);
    assert.equal(result.review.covered, true);
    assert.equal(result.review.confirmUnavailable, undefined, "selected tests actually run");
    assert.ok(result.ignoredDirtyCount >= 3);
    assert.match(await readFile(join(repo, "tests/proof.test.cjs"), "utf8"), /unstaged test/);
    const stagedReview = spawnSync(process.execPath, [CLI, "review", "--staged", "--require-review", "--json"], {cwd:repo, encoding:"utf8"});
    assert.equal(stagedReview.status, 0, stagedReview.stdout + stagedReview.stderr);
    assert.equal(JSON.parse(stagedReview.stdout).reviewGate.adjudicated, 1);
    assert.equal(JSON.parse(stagedReview.stdout).reviewGate.unjudged, 0);
    git(["add", "tests/proof.test.cjs"]);
    assert.equal(verify(["--json"]).status, 1, "a staged test change reopens evidence");
  });

  it("reports missing generated test inputs as unavailable after isolating dirty work", async () => {
    await put(".gitignore", ".codument/\ndist/\n");
    await put(".codument-meta.json", JSON.stringify({testCommand:"node --test {file}"}));
    await put("dist/value.cjs", "module.exports=1;\n");
    await put("tests/proof.test.cjs", 'const value=require("../dist/value.cjs"); require("node:test").test("value",()=>require("node:assert/strict").equal(value,1));\n');
    await put("note.txt", "original\n");
    git(["add", "."]); git(["commit", "-qm", "test with generated environment"]);
    await put("src/a.ts", "export function a(value: string): string { return value; }\n");
    await put("docs/features/alpha.md", "# Alpha\n\n## Invariants & boundaries\n- Returns a string. *(test: tests/proof.test.cjs)*\n");
    git(["add", "src/a.ts", "docs/features/alpha.md"]);
    verify();
    const worksheet=JSON.parse(await readFile(join(repo,".codument/review-worksheet.json"),"utf8"));
    worksheet.invariantsChecked=["Selected source checked"]; worksheet.signer="fixture reviewer";
    worksheet.findings=[{citation:"src/a.ts:1",detail:"Fixture finding",failingTest:"tests/proof.test.cjs",status:"resolved"}];
    await put(".codument/review-worksheet.json",JSON.stringify(worksheet));
    assert.equal(verify(["--record",".codument/review-worksheet.json"]).status,0);
    await put("note.txt","unrelated dirty note\n");
    const result=JSON.parse(verify(["--json"]).stdout);
    assert.equal(result.review.blockingFindings.length,0,"missing generated input is not a reproduced bug");
    assert.equal(result.review.unjudged,1);
    assert.match(result.review.confirmUnavailable,/unjudged|advisory|could not|unavailable/i);
  });

  it("passes a trivial staged step in one compact command and writes an exact receipt", async () => {
    await put("src/a.ts", "export function a(): number { return 2; }\n");
    git(["add", "src/a.ts"]);
    await put("scratch.txt", "unrelated dirty work\n");

    const first = verify();
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /^codument verify: PASS — staged · [a-f0-9]{12}\r?\n$/);
    const receipt = JSON.parse(await readFile(receiptPath(), "utf8"));
    assert.equal(receipt.version, 1);
    assert.equal(receipt.boundary.mode, "staged");

    const one = verify(["--json"]);
    const two = verify(["--json"]);
    assert.equal(one.status, 0);
    assert.equal(one.stdout, two.stdout, "machine output is deterministic for the same boundary");
    const report = JSON.parse(one.stdout);
    assert.equal(report.gate, "ok");
    assert.equal(report.passed, true);
    assert.equal(report.ignoredDirtyCount, 1);
    assert.equal(report.boundary.fingerprint, receipt.boundary.fingerprint);
    assert.equal(report.receipt, ".git/codument/verify-receipt.json");
  });

  it("writes a ready worksheet for an uncovered change, then records and verifies it", async () => {
    await put("src/a.ts", "export function a(): number { return 2; }\n");
    await put("settings.json", '{"enabled":true}\n');
    git(["add", "src/a.ts", "settings.json"]);

    const first = verify();
    assert.equal(first.status, 1);
    assert.match(first.stdout, /^codument verify: REVIEW REQUIRED/m);
    assert.match(first.stdout, /codument verify --record \.codument\/review-worksheet\.json/);
    assert.doesNotMatch(first.stdout, /High-fanout|Dependents that may need re-review/);

    const worksheetPath = join(repo, ".codument", "review-worksheet.json");
    const original = await readFile(worksheetPath, "utf8");
    const worksheet = JSON.parse(original);
    assert.deepEqual(worksheet.invariantsChecked, []);
    assert.deepEqual(worksheet.findings, []);
    assert.equal(worksheet.signer, "");
    assert.equal(worksheet.bundleStamp, worksheet.reviewContext.stamp);
    assert.deepEqual(worksheet.reviewContext.boundary.paths, ["settings.json", "src/a.ts"]);

    const tampered = structuredClone(worksheet);
    tampered.reviewContext.changedFiles = [];
    tampered.invariantsChecked = ["A context that was not actually supplied"];
    tampered.signer = "fixture-reviewer";
    await writeFile(worksheetPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const refused = verify(["--record", ".codument/review-worksheet.json"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /generated review context was modified/);
    await writeFile(worksheetPath, original, "utf8");

    const repeated = verify();
    assert.equal(repeated.status, 1);
    assert.equal(await readFile(worksheetPath, "utf8"), original, "worksheet is deterministic");

    worksheet.invariantsChecked = ["Alpha's numeric contract and the settings change"];
    worksheet.signer = "fixture-reviewer";
    const completed = `${JSON.stringify(worksheet, null, 2)}\n`;
    await writeFile(worksheetPath, completed, "utf8");
    const preserved = verify();
    assert.equal(preserved.status, 1);
    assert.equal(
      await readFile(worksheetPath, "utf8"),
      completed,
      "ordinary verification preserves a worksheet being completed",
    );
    const recorded = verify(["--record", ".codument/review-worksheet.json"]);
    assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
    assert.match(recorded.stdout, /^codument verify: PASS — staged · [a-f0-9]{12}\r?\n$/);
    assert.equal(JSON.parse(await readFile(receiptPath(), "utf8")).boundary.fingerprint.length, 64);

    await rm(join(repo, ".codument", "reviews"), { recursive: true, force: true });
    const cached = verify();
    assert.equal(cached.status, 0, cached.stderr || cached.stdout);
    assert.match(cached.stdout, /^codument verify: PASS — staged · [a-f0-9]{12}\r?\n$/);
    const forced = verify(["--details"]);
    assert.equal(forced.status, 1, "details deliberately recomputes instead of trusting the cache");
    assert.match(forced.stdout, /REVIEW REQUIRED/);
  });

  it("replays a concurrent-dirty staged test step within the two-invocation budget", async () => {
    await put("src/a.ts", "export function a(): number { return 2; }\n");
    await put("tests/alpha.test.ts", 'import { a } from "../src/a.js";\nassert(a() === 2);\n');
    await put("settings.json", '{"enabled":true}\n');
    git(["add", "src/a.ts", "tests/alpha.test.ts", "settings.json"]);
    await put("src/unrelated.ts", "export const unfinished = true;\n");

    let invocations = 0;
    const run = (args: string[] = []) => {
      invocations += 1;
      return verify(args);
    };
    const first = run();
    assert.equal(first.status, 1);
    assert.match(first.stdout, /^codument verify: REVIEW REQUIRED/m);

    const worksheetPath = join(repo, ".codument", "review-worksheet.json");
    const worksheet = JSON.parse(await readFile(worksheetPath, "utf8"));
    assert.deepEqual(worksheet.reviewContext.boundary.paths, [
      "settings.json",
      "src/a.ts",
      "tests/alpha.test.ts",
    ]);
    assert.deepEqual(worksheet.reviewContext.testImpact.changedTests, ["tests/alpha.test.ts"]);
    assert.deepEqual(worksheet.reviewContext.testImpact.attributed, [
      { test: "tests/alpha.test.ts", feature: "alpha", via: "invariant-pin" },
    ]);
    assert.ok(!worksheet.reviewContext.boundary.paths.includes("src/unrelated.ts"));

    worksheet.invariantsChecked = ["Alpha's staged implementation and pinned test"];
    worksheet.signer = "field-proof-reviewer";
    await writeFile(worksheetPath, `${JSON.stringify(worksheet, null, 2)}\n`, "utf8");
    const recorded = run(["--record", ".codument/review-worksheet.json"]);
    assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
    assert.equal(invocations, 2, "worksheet generation and record-and-verify are the whole loop");
  });

  it("prints only actionable failures by default and keeps the full report on demand", async () => {
    await put("src/a.ts", "export function a(value: number): number { return value; }\n");
    git(["add", "src/a.ts"]);

    const compact = verify();
    assert.equal(compact.status, 1);
    assert.match(compact.stdout, /^codument verify: BLOCKED/m);
    assert.match(compact.stdout, /stale doc → docs\/features\/alpha\.md/);
    assert.match(compact.stdout, /codument verify --details/);
    assert.doesNotMatch(compact.stdout, /High-fanout|Docs changed without source/);

    const machine = verify(["--json"]);
    assert.equal(machine.status, 1);
    const machineReport = JSON.parse(machine.stdout);
    assert.equal(machineReport.documentation.passed, false);
    assert.deepEqual(machineReport.review, {
      status: "not-run",
      reason: "documentation synchronization failed",
    });

    const detailed = verify(["--details"]);
    assert.equal(detailed.status, 1);
    assert.match(detailed.stdout, /Changed by feature/);
    assert.match(detailed.stdout, /Stale docs/);
    assert.match(detailed.stdout, /Review reports repo facts/);
  });

  it("cannot mint a receipt for an explicit subset of the staged boundary", async () => {
    await put("src/a.ts", "export function a(): number { return 2; }\n");
    await put("settings.json", '{"enabled":true}\n');
    git(["add", "src/a.ts", "settings.json"]);

    const result = verify(["--paths", "src/a.ts", "--json"]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.gate, "ok");
    assert.equal(report.passed, false);
    assert.equal(report.boundary.complete, false);
    assert.deepEqual(report.failures.unselectedStagedPaths, ["settings.json"]);
    await assert.rejects(readFile(receiptPath(), "utf8"), { code: "ENOENT" });
  });
});
