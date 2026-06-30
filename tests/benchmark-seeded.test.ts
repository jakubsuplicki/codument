import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { classifyDetectorRun } from "../src/lib/detector-result.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIXTURE = join(ROOT, "fixtures", "benchmarks", "seeded-bugs");

function runCli(
  ...args: string[]
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [CLI, ...args], { encoding: "utf-8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// Fix a subset of the planted bugs the way a correct solution would: restore the
// two tidied files from the baseline, write the two new files from the answer key.
async function applyFixes(target: string, bugIds: string[]): Promise<void> {
  const fixes: Record<string, () => Promise<void>> = {
    "session-expiry-dropped": () =>
      cp(
        join(FIXTURE, "project", "src", "auth", "authorize.js"),
        join(target, "src", "auth", "authorize.js"),
      ),
    "negative-amount-accepted": () =>
      cp(
        join(FIXTURE, "project", "src", "wallet", "account.js"),
        join(target, "src", "wallet", "account.js"),
      ),
    "off-by-one-pagination": () =>
      cp(
        join(FIXTURE, "fixed", "src", "util", "pagination.js"),
        join(target, "src", "util", "pagination.js"),
      ),
    "silent-parse-default": () =>
      cp(
        join(FIXTURE, "fixed", "src", "util", "parse-amount.js"),
        join(target, "src", "util", "parse-amount.js"),
      ),
  };
  for (const id of bugIds) {
    await fixes[id]();
  }
}

const ALL_BUGS = [
  "session-expiry-dropped",
  "negative-amount-accepted",
  "off-by-one-pagination",
  "silent-parse-default",
];

describe("seeded-bugs benchmark", () => {
  it("packages the answer key and detectors as shipped files", async () => {
    const manifest = JSON.parse(
      await readFile(join(FIXTURE, "bugs.json"), "utf-8"),
    );
    assert.equal(manifest.fixture, "seeded-bugs");
    assert.equal(manifest.bugs.length, ALL_BUGS.length);
    for (const bug of manifest.bugs) {
      assert.ok(
        existsSync(join(FIXTURE, bug.detector)),
        `detector exists for ${bug.id}`,
      );
    }
  });

  it("lays a seeded scenario as an uncommitted feature diff", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-init-"));
    const target = join(tmp, "scenario");
    try {
      const init = runCli("benchmark", "init", target, "--seeded");

      assert.equal(init.status, 0);
      assert.ok(init.stdout.includes("Fixture: seeded-bugs"));
      assert.ok(init.stdout.includes("Baseline commit: created"));

      // The workflow scaffolding and buggy feature work are present.
      assert.ok(existsSync(join(target, "package.json")));
      assert.ok(existsSync(join(target, "BENCHMARK_TASK.md")));
      assert.ok(existsSync(join(target, "AGENTS.md")));
      assert.ok(existsSync(join(target, "src", "util", "pagination.js")));
      assert.ok(existsSync(join(target, "src", "report", "transactions.js")));

      // The baseline is a git commit; the feature work is the working-tree diff.
      assert.ok(existsSync(join(target, ".git")));
      const status = spawnSync("git", ["status", "--short"], {
        cwd: target,
        encoding: "utf-8",
      });
      assert.match(status.stdout, /src\/auth\/authorize\.js/);
      assert.match(status.stdout, /src\/util\//);

      const scenario = JSON.parse(
        await readFile(join(target, ".codument", "benchmark.json"), "utf-8"),
      );
      assert.equal(scenario.fixture, "seeded-bugs");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("never copies the answer key into the scenario", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-leak-"));
    const target = join(tmp, "scenario");
    try {
      assert.equal(runCli("benchmark", "init", target, "--seeded").status, 0);

      assert.ok(!existsSync(join(target, "bugs.json")), "no bug manifest");
      assert.ok(!existsSync(join(target, "detectors")), "no detectors");
      assert.ok(!existsSync(join(target, "fixed")), "no answer key");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("never reveals which bugs are planted inside the scenario", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-noreveal-"));
    const target = join(tmp, "scenario");
    try {
      assert.equal(runCli("benchmark", "init", target, "--seeded").status, 0);

      const manifest = JSON.parse(
        await readFile(join(FIXTURE, "bugs.json"), "utf-8"),
      );
      const forbidden = [
        ...manifest.bugs.map((b: { id: string }) => b.id),
        "PLANTED BUG",
      ];

      // Read every file the scenario hands the agent (skip the committed git
      // objects, which are not human-readable working files).
      const entries = await readdir(target, { recursive: true });
      const leaks: string[] = [];
      for (const rel of entries) {
        if (rel.split(/[\\/]/).includes(".git")) continue;
        const abs = join(target, rel);
        if (!(await stat(abs)).isFile()) continue;
        const content = await readFile(abs, "utf-8").catch(() => "");
        for (const term of forbidden) {
          if (content.includes(term)) leaks.push(`${rel} contains "${term}"`);
        }
      }

      assert.deepEqual(leaks, [], `answer key leaked into scenario:\n${leaks.join("\n")}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("scores the raw buggy diff as 0% caught", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-raw-"));
    const target = join(tmp, "scenario");
    try {
      assert.equal(runCli("benchmark", "init", target, "--seeded").status, 0);

      const score = runCli("benchmark", "score", target, "--mode", "no-loop");

      assert.equal(score.status, 0);
      assert.ok(score.stdout.includes("Mode: no-loop"));
      assert.ok(score.stdout.includes("Catch rate: 0/4 (0%)"));
      assert.equal((score.stdout.match(/SURVIVED/g) ?? []).length, 4);
      assert.ok(!score.stdout.includes("CAUGHT"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("scores a fully fixed solution as 100% caught", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-fixed-"));
    const target = join(tmp, "scenario");
    try {
      assert.equal(runCli("benchmark", "init", target, "--seeded").status, 0);
      await applyFixes(target, ALL_BUGS);

      const score = runCli("benchmark", "score", target, "--mode", "loop");

      assert.equal(score.status, 0);
      assert.ok(score.stdout.includes("Catch rate: 4/4 (100%)"));
      assert.equal((score.stdout.match(/CAUGHT/g) ?? []).length, 4);
      assert.ok(!score.stdout.includes("SURVIVED"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("scores a partial fix as the correct fraction", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-partial-"));
    const target = join(tmp, "scenario");
    try {
      assert.equal(runCli("benchmark", "init", target, "--seeded").status, 0);
      await applyFixes(target, [
        "session-expiry-dropped",
        "silent-parse-default",
      ]);

      const score = runCli("benchmark", "score", target);

      assert.equal(score.status, 0);
      assert.ok(score.stdout.includes("Catch rate: 2/4 (50%)"));
      assert.ok(score.stdout.includes("CAUGHT   session-expiry-dropped"));
      assert.ok(score.stdout.includes("SURVIVED off-by-one-pagination"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("is deterministic — scoring twice yields the same result", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-determ-"));
    const target = join(tmp, "scenario");
    try {
      assert.equal(runCli("benchmark", "init", target, "--seeded").status, 0);
      await applyFixes(target, ["off-by-one-pagination"]);

      const first = runCli("benchmark", "score", target).stdout;
      const second = runCli("benchmark", "score", target).stdout;

      const bugLines = (out: string) =>
        out
          .split("\n")
          .filter((line) => /CAUGHT|SURVIVED/.test(line))
          .join("\n");
      assert.equal(bugLines(first), bugLines(second));
      assert.ok(first.includes("Catch rate: 1/4 (25%)"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails the score when the locked scenario identity is tampered", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-tamper-"));
    const target = join(tmp, "scenario");
    try {
      assert.equal(runCli("benchmark", "init", target, "--seeded").status, 0);
      await applyFixes(target, ALL_BUGS);
      await writeFile(
        join(target, ".codument", "benchmark.json"),
        '{"schemaVersion":1,"fixture":"seeded-bugs","taskId":"HACKED"}\n',
      );

      const score = runCli("benchmark", "score", target, "--mode", "loop");

      assert.equal(score.status, 1);
      assert.ok(score.stdout.includes("Result: FAIL"));
      assert.ok(score.stdout.includes("FAIL locked-files"));
      assert.ok(score.stdout.includes(".codument/benchmark.json"));
      // A tampered run must not record a result others could compare against.
      assert.ok(!existsSync(join(target, ".codument", "seeded-result.json")));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("compares a loop run against a no-loop baseline", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-compare-"));
    const noLoop = join(tmp, "noloop");
    const loop = join(tmp, "loop");
    try {
      assert.equal(runCli("benchmark", "init", noLoop, "--seeded").status, 0);
      assert.equal(runCli("benchmark", "init", loop, "--seeded").status, 0);

      // no-loop ships the diff as-is; score and record it.
      assert.equal(
        runCli("benchmark", "score", noLoop, "--mode", "no-loop").status,
        0,
      );

      // loop fixes everything, then compares against the recorded baseline.
      await applyFixes(loop, ALL_BUGS);
      const score = runCli(
        "benchmark",
        "score",
        loop,
        "--mode",
        "loop",
        "--baseline",
        noLoop,
      );

      assert.equal(score.status, 0);
      assert.ok(score.stdout.includes("Comparison vs no-loop baseline:"));
      assert.ok(
        score.stdout.includes("no-loop: 0%   loop: 100%   delta: +100%"),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("ignores ambient NODE_OPTIONS when running detectors", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-nodeopts-"));
    const target = join(tmp, "scenario");
    try {
      assert.equal(runCli("benchmark", "init", target, "--seeded").status, 0);

      // --test-name-pattern with no match makes `node --test` exit 0 even when
      // assertions would fail; a detector that inherited it would misreport a
      // present bug as caught. The scorer must strip it (cleanNodeTestEnv).
      const score = spawnSync(
        "node",
        [CLI, "benchmark", "score", target, "--mode", "no-loop"],
        {
          encoding: "utf-8",
          env: { ...process.env, NODE_OPTIONS: "--test-name-pattern=NOMATCH_ZZZ" },
        },
      );

      // Older Node (the CI matrix's 18/20) rejects --test-name-pattern in
      // NODE_OPTIONS at startup (exit 9), so the scoring node never even runs — the
      // exact leak this guards against cannot be set up there. Verify the strip on
      // the Node versions that do accept the flag; elsewhere it is unreachable.
      if (score.status !== 0 && /not allowed in NODE_OPTIONS/.test(score.stderr ?? "")) {
        return;
      }

      assert.equal(score.status, 0);
      assert.ok(
        score.stdout.includes("Catch rate: 0/4 (0%)"),
        `ambient NODE_OPTIONS leaked into detectors:\n${score.stdout}`,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not let a tampered directory be reused as a trusted baseline", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-stalebase-"));
    const noLoop = join(tmp, "noloop");
    const loop = join(tmp, "loop");
    try {
      assert.equal(runCli("benchmark", "init", noLoop, "--seeded").status, 0);
      assert.equal(runCli("benchmark", "init", loop, "--seeded").status, 0);

      // Score the baseline clean (records a result), then tamper and re-score.
      await applyFixes(noLoop, ALL_BUGS);
      assert.equal(runCli("benchmark", "score", noLoop, "--mode", "loop").status, 0);
      assert.ok(existsSync(join(noLoop, ".codument", "seeded-result.json")));
      await writeFile(
        join(noLoop, ".codument", "benchmark.json"),
        '{"schemaVersion":1,"fixture":"seeded-bugs","taskId":"HACKED"}\n',
      );
      assert.equal(runCli("benchmark", "score", noLoop).status, 1);
      // The stale clean result must be gone, not left for --baseline to trust.
      assert.ok(!existsSync(join(noLoop, ".codument", "seeded-result.json")));

      const score = runCli("benchmark", "score", loop, "--baseline", noLoop);
      assert.equal(score.status, 1);
      assert.ok(score.stderr.includes("Baseline result not found"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("classifies detector process results (caught/survived/non-completion)", () => {
    assert.equal(classifyDetectorRun({ status: 0, signal: null }, "b"), "caught");
    assert.equal(
      classifyDetectorRun({ status: 1, signal: null }, "b"),
      "survived",
    );
    // A timeout or kill carries no information about the bug → error, never a miss.
    assert.throws(() => classifyDetectorRun({ status: null, signal: "SIGTERM" }, "b"));
    assert.throws(() =>
      classifyDetectorRun(
        { status: null, signal: null, error: new Error("ETIMEDOUT") },
        "b",
      ),
    );
  });

  it("errors clearly when a baseline directory was never scored", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-seeded-nobaseline-"));
    const noLoop = join(tmp, "noloop");
    const loop = join(tmp, "loop");
    try {
      assert.equal(runCli("benchmark", "init", noLoop, "--seeded").status, 0);
      assert.equal(runCli("benchmark", "init", loop, "--seeded").status, 0);

      const score = runCli(
        "benchmark",
        "score",
        loop,
        "--baseline",
        noLoop,
      );

      assert.equal(score.status, 1);
      assert.ok(score.stderr.includes("Baseline result not found"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
