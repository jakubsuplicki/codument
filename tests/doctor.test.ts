import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, cp } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildReport, doctor, writeCoverageArtifacts } from "../src/commands/doctor.js";

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

// The CLI suites run doctor with cwd at a project root. The in-repo fixture
// cannot be that cwd anymore: it sits inside the codument work tree, so the
// toplevel assertion (correctly) refuses it. Run them against a standalone copy.
let fixtureCwd: string;
before(async () => {
  fixtureCwd = join(await mkdtemp(join(tmpdir(), "codument-doctor-cli-")), "project");
  await cp(FIXTURE, fixtureCwd, { recursive: true });
});
after(async () => {
  await rm(dirname(fixtureCwd), { recursive: true, force: true });
});

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
      cwd: fixtureCwd,
      encoding: "utf-8",
    });
    const report = JSON.parse(out);
    assert.equal(report.version, 1);
    assert.equal(report.coverage.percent, 83);
    assert.ok(Array.isArray(report.lint.findings));
  });

  it("human output leads with documentation coverage", () => {
    const out = execFileSync("node", [CLI, "doctor"], {
      cwd: fixtureCwd,
      encoding: "utf-8",
    });
    assert.ok(out.includes("Documentation coverage"));
    assert.ok(out.includes("ownership"));
  });

  it("runs green over a Python repo — the symbol heuristics warm their grammar instead of going blind", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "codument-doctor-py-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      await mkdir(join(dir, "app"), { recursive: true });
      await mkdir(join(dir, "docs", "features"), { recursive: true });
      await writeFile(join(dir, "app", "settings.py"), "DEBUG = True\n");
      await writeFile(
        join(dir, "docs", "features", "settings.md"),
        "# settings\n\nRuntime flags for the app.\n",
      );
      await writeFile(
        join(dir, "docs", ".registry.json"),
        JSON.stringify(
          {
            features: {
              settings: {
                doc: "docs/features/settings.md",
                type: "feature",
                primary_sources: ["app/settings.py"],
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
      // A cold python adapter would crash doctor (rethrown, never swallowed);
      // a green run proves the command warms before its symbol heuristics.
      const out = execFileSync("node", [CLI, "doctor"], { cwd: dir, encoding: "utf-8" });
      assert.ok(out.includes("Documentation coverage"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The two field repros the test above did NOT cover: it git-inits and leaves
  // the .py untracked, and `git status -uall` reports untracked files — so git's
  // view happened to contain it. Both cases below hide the mapped .py from git
  // entirely, which is what crashed `codument doctor` in the wild.
  for (const variant of [
    {
      name: "under a NON-repo root (no git view at all)",
      init: async (_dir: string) => {},
      source: join("src", "app.py"),
    },
    {
      name: "when the mapped source is gitignored inside a real repo",
      init: async (dir: string) => {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dir, ".gitignore"), "src/\n");
      },
      source: join("src", "app.py"),
    },
  ]) {
    it(`does not crash on a registry-mapped Python source ${variant.name}`, async () => {
      const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "codument-doctor-invisible-py-"));
      try {
        await variant.init(dir);
        await mkdir(join(dir, "src"), { recursive: true });
        await mkdir(join(dir, "docs", "features"), { recursive: true });
        await writeFile(join(dir, variant.source), "def hello():\n    return 1\n");
        await writeFile(
          join(dir, "docs", "features", "app.md"),
          "# app\n\nWhat the app promises its callers.\n",
        );
        await writeFile(
          join(dir, "docs", ".registry.json"),
          JSON.stringify({
            features: {
              app: {
                doc: "docs/features/app.md",
                type: "feature",
                primary_sources: ["src/app.py"],
                related_sources: [],
                docs: [],
                depends_on: [],
                risk: [],
                status: "current",
              },
            },
          }),
        );
        // Before the warm set unioned in the registry's own sources, this exited
        // nonzero with an unhandled TreeSitterError and produced no report at all.
        const out = execFileSync("node", [CLI, "doctor"], { cwd: dir, encoding: "utf-8" });
        assert.ok(out.includes("Documentation coverage"));
        assert.doesNotMatch(out, /grammar not loaded/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
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
    assert.equal(run(["doctor", "--strict"], fixtureCwd).status, 1);
  });

  it("leaves bare doctor at exit 0 on the same dirty fixture", () => {
    assert.equal(run(["doctor"], fixtureCwd).status, 0);
  });

  it("exits 0 with --strict on a clean repo (no findings)", () => {
    assert.equal(run(["doctor", "--strict"], clean).status, 0);
  });

  it("exits 1 with --strict --json but keeps the JSON contract byte-identical", () => {
    const plain = run(["doctor", "--json"], fixtureCwd);
    const strict = run(["doctor", "--json", "--strict"], fixtureCwd);
    assert.equal(plain.status, 0);
    assert.equal(strict.status, 1);
    // --strict must not change stdout: same JSON either way, only the exit differs.
    assert.equal(strict.stdout, plain.stdout);
    assert.ok(JSON.parse(strict.stdout).lint.count > 0);
  });

  it("exits 1 with --strict on a missing-registry repo", () => {
    assert.equal(run(["doctor", "--strict"], missing).status, 1);
  });

  it("nudges once, dim and human-only, when the project was scaffolded by an older codument", async () => {
    // read the running version straight from package.json (version.ts resolves
    // the BUNDLE layout and cannot be imported from unbundled tests)
    const version = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")).version;
    await writeFile(
      join(clean, ".codument-meta.json"),
      JSON.stringify({ version: "0.1.0", initialized: "2026-01-01", project: {} }),
    );
    const human = run(["doctor"], clean);
    assert.equal(human.status, 0, "a nudge is never an exit-code input");
    assert.match(human.stdout, /scaffolded at 0\.1\.0/);
    assert.match(human.stdout, /codument update/);
    assert.ok(human.stdout.includes(`codument ${version} installed`));

    // --json contract stays byte-identical: no nudge text in machine output
    const json = run(["doctor", "--json"], clean);
    assert.doesNotMatch(json.stdout, /scaffolded at/);
    JSON.parse(json.stdout);
  });

  it("stays silent when versions are in sync or nothing was scaffolded", async () => {
    const version = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")).version;
    assert.doesNotMatch(run(["doctor"], clean).stdout, /scaffolded at/, "no meta, no nudge");
    await writeFile(
      join(clean, ".codument-meta.json"),
      JSON.stringify({ version, initialized: "2026-01-01", project: {} }),
    );
    assert.doesNotMatch(run(["doctor"], clean).stdout, /scaffolded at/, "in sync, no nudge");
  });

  it("a corrupt meta file cannot crash the advisory surface — the nudge names the repair", async () => {
    await writeFile(join(clean, ".codument-meta.json"), "{ not json");
    const r = run(["doctor"], clean);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\.codument-meta\.json is unreadable/);
  });

  it("errors loudly from a subdirectory of a git repo (never a wrong-root score)", async () => {
    const repo = await mkdtemp(join(tmpdir(), "codument-doctor-subdir-"));
    try {
      const g = (args: string[]) =>
        execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      g(["init"]);
      await mkdir(join(repo, "packages", "app"), { recursive: true });
      const sub = run(["doctor"], join(repo, "packages", "app"));
      assert.equal(sub.status, 1);
      assert.match(sub.stdout, /subdirectory/);
      assert.match(sub.stdout, /gate could not run/);
      // Names both paths: the offending root and the toplevel to run from.
      const top = realpathSync.native(repo);
      assert.ok(sub.stdout.includes(join(top, "packages", "app")));
      assert.ok(sub.stdout.includes(`run it from ${top}`));

      // --json stays machine-readable: a discriminated shape, never human text
      // a JSON consumer would crash on.
      const json = run(["doctor", "--json"], join(repo, "packages", "app"));
      assert.equal(json.status, 1);
      const shape = JSON.parse(json.stdout);
      assert.equal(shape.gate, "unavailable");
      assert.match(shape.reason, /subdirectory/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("scores normally at a genuine git toplevel (the assertion pass-path)", async () => {
    // Every other doctor CLI test runs in a non-git tmp dir and so takes the
    // assertion's non-git short-circuit; this pins the toplevel pass-path with
    // real git present — same golden number as the non-git copy.
    const wrap = await mkdtemp(join(tmpdir(), "codument-doctor-toplevel-"));
    try {
      const repo = join(wrap, "project");
      await cp(FIXTURE, repo, { recursive: true });
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      const out = run(["doctor", "--json"], repo);
      assert.equal(out.status, 0);
      assert.equal(JSON.parse(out.stdout).coverage.percent, 83);
    } finally {
      await rm(wrap, { recursive: true, force: true });
    }
  });

  it("fails loud on a corrupt registry — even bare, and never touches the file", async () => {
    const corrupt = await mkdtemp(join(tmpdir(), "codument-corrupt-"));
    try {
      const registryPath = join(corrupt, "docs", ".registry.json");
      // Valid intent, invalid JSON (trailing comma).
      const original = '{ "features": { "auth": { "doc": "docs/features/auth.md", } } }';
      await mkdir(join(corrupt, "docs"), { recursive: true });
      await writeFile(registryPath, original);

      // A corrupt registry is a hard read error, not a soft finding: bare doctor
      // fails closed too (unlike lint findings, which only fail under --strict).
      const bare = run(["doctor"], corrupt);
      assert.equal(bare.status, 1);
      assert.match(bare.stdout, /unreadable/);
      assert.equal(run(["doctor", "--strict"], corrupt).status, 1);

      // The tool refused to read it as empty; it must not have rewritten it.
      assert.equal(readFileSync(registryPath, "utf-8"), original);
    } finally {
      await rm(corrupt, { recursive: true, force: true });
    }
  });
});

describe("doctor --verify-invariants (opt-in; bare mode untouched)", () => {
  let tmp: string;
  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-doctor-inv-"));
    await mkdir(join(tmp, "docs"), { recursive: true });
    await writeFile(join(tmp, "docs", ".registry.json"), JSON.stringify({ features: {} }));
  });
  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // The load-bearing non-goal: without the flag, --json is byte-identical to
  // before this plan — no invariants block, so a CI consumer never breaks and the
  // report stays deterministic.
  it("bare doctor --json carries NO invariants block", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      await doctor({ root: tmp, json: true });
    } finally {
      console.log = orig;
    }
    const out = JSON.parse(lines.join("\n"));
    assert.ok(!("invariants" in out), "no invariants key without --verify-invariants");
  });
});
