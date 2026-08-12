import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, cp, chmod } from "node:fs/promises";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
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

// The field: seventy findings on a maintained repo, sixty-nine of them inherited from
// upgrades and one just introduced, rendering identically — so the loop's only
// whole-repo health surface was unreadable at exactly the moment it had something new
// to say.
describe("doctor separates what this change produced from what the repo arrived with", () => {
  let dir: string;

  async function project(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "codument-attrib-"));
    await mkdir(join(dir, "docs", "features"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "old.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "src", "fresh.ts"), "export const b = 2;\n");
    // Two entries, each already carrying inherited debt: a mapped source that is
    // not on disk. Only one of them will be touched by the working tree.
    const entry = (k: string, extra: string) => ({
      doc: `docs/features/${k}.md`,
      type: "feature",
      primary_sources: [`src/${k}.ts`, extra],
      related_sources: [],
      docs: [],
      depends_on: ["core"],
      risk: [],
      status: "current",
    });
    await writeFile(
      join(dir, "docs", ".registry.json"),
      JSON.stringify({ features: { old: entry("old", "src/gone.ts"), fresh: entry("fresh", "src/vanished.ts") } }),
    );
    for (const k of ["old", "fresh"]) {
      await writeFile(join(dir, "docs", "features", `${k}.md`), `# ${k}\n\nWhat it is.\n`);
    }
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: dir });
  }

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("attributes a finding to this change only when its own subject file was touched", async () => {
    await project();
    // Add the missing source under `fresh` — its finding is now this change's,
    // while `old`'s identical finding is not.
    await writeFile(join(dir, "src", "vanished.ts"), "export const c = 3;\n");
    await writeFile(join(dir, "src", "gone.ts"), "export const d = 4;\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "both exist"], { cwd: dir });
    // Now delete one of them in the working tree: that is what THIS change did.
    await rm(join(dir, "src", "vanished.ts"));

    const report = JSON.parse(
      execFileSync("node", [CLI, "doctor", "--json"], { cwd: dir, encoding: "utf-8" }),
    );
    assert.deepStrictEqual(
      report.lint.attribution.fromThisChange.map((f: { file: string }) => f.file),
      ["src/vanished.ts"],
      "the path this working tree removed",
    );
    assert.ok(
      !report.lint.attribution.inherited.some((f: { file: string }) => f.file === "src/vanished.ts"),
      "and it is not also counted as inherited",
    );
  });

  it("the human surface leads with what this change produced, and says which is which", async () => {
    await project();
    await rm(join(dir, "src", "old.ts"));

    const out = execFileSync("node", [CLI, "doctor"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(out, /from this change, \d+ the repo arrived with/);
    assert.match(out, /From this change/);
    assert.match(out, /Inherited — not this change/);
    // The one it just caused comes before the pile it did not.
    assert.ok(
      out.indexOf("src/old.ts") < out.indexOf("src/gone.ts"),
      `what this change produced must lead:\n${out}`,
    );
  });

  it("no repository to ask is not 'nothing is new' — the split is absent, not empty", async () => {
    await project();
    await rm(join(dir, ".git"), { recursive: true, force: true });

    const report = JSON.parse(
      execFileSync("node", [CLI, "doctor", "--json"], { cwd: dir, encoding: "utf-8" }),
    );
    assert.equal(report.lint.attribution, null);
    assert.ok(report.lint.count > 0, "the findings themselves are unaffected");
    const out = execFileSync("node", [CLI, "doctor"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.doesNotMatch(out, /the repo arrived with/, "no split is drawn over an answer it lacks");
  });

  // The split shipped as a rendering change while the exit code went on failing
  // over everything, so the surface said "nothing here gates anything" directly
  // above a red gate. `review` settled the same argument for inherited registry
  // rot; this is doctor finally getting the rule.
  function strictRun(cwd: string): { status: number; stdout: string } {
    try {
      return {
        status: 0,
        stdout: execFileSync("node", [CLI, "doctor", "--strict"], {
          cwd,
          encoding: "utf-8",
          env: { ...process.env, NO_COLOR: "1" },
        }),
      };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
  }

  it("--strict passes on a repo carrying only inherited findings", async () => {
    await project();
    // Untouched tree: `old` and `fresh` both dangle, and neither is this change's.
    const { status, stdout } = strictRun(dir);
    assert.ok(/the repo arrived with/.test(stdout), "the findings are still reported");
    assert.equal(status, 0, `inherited debt must never gate:\n${stdout}`);
  });

  it("--strict fails as soon as this change produces one", async () => {
    await project();
    await rm(join(dir, "src", "old.ts"));
    const { status, stdout } = strictRun(dir);
    assert.equal(status, 1);
    assert.match(stdout, /Strict: 1 finding from this change, failing \(exit 1\)/);
    // The number the exit code came from, and the pile it deliberately ignored.
    assert.match(stdout, /inherited — reported, never gated/);
  });

  it("no repository to ask fails closed — every finding gates rather than none", async () => {
    await project();
    await rm(join(dir, ".git"), { recursive: true, force: true });
    const { status } = strictRun(dir);
    assert.equal(status, 1, "cannot-tell must never resolve to a green nobody earned");
  });
});

// An agent pointed at seventy findings writes compaction theater — plan 42's own
// finding, almost word for word. So the mechanical subset is cleared in one command
// and everything that needs a decision is named and left.
describe("doctor --fix clears what needs no judgment, and says what it left", () => {
  let dir: string;
  const registryPath = () => join(dir, "docs", ".registry.json");
  const read = () => JSON.parse(readFileSync(registryPath(), "utf-8"));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codument-fix-"));
    await mkdir(join(dir, "docs", "features"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "real.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "docs", "features", "core.md"), "# core\n\nWhat it is.\n");
    await writeFile(
      registryPath(),
      JSON.stringify({
        features: {
          core: {
            doc: "docs/features/core.md",
            type: "feature",
            // Three claims: one true, one naming a path that is not there, and one
            // manifest — which is a real finding whose fix is a decision, not an edit.
            primary_sources: ["src/real.ts", "src/ghost.ts", "package.json"],
            related_sources: [],
            docs: [],
            depends_on: ["other"],
            risk: [],
            status: "current",
          },
        },
      }),
    );
    await writeFile(join(dir, "package.json"), "{}\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("drops the false pointer, keeps everything real, and leaves the judgment call alone", () => {
    const out = execFileSync("node", [CLI, "doctor", "--fix"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(out, /dropped 1 false registry pointer/);
    assert.match(out, /src\/ghost\.ts/);

    const after = read();
    assert.deepStrictEqual(
      [...after.features.core.primary_sources].sort(),
      ["package.json", "src/real.ts"],
      "only the path that was not there is gone",
    );
  });

  it("names what it deliberately left, so a partial clear never reads as a whole one", () => {
    const out = execFileSync("node", [CLI, "doctor", "--fix"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(out, /need a decision, which is not this command's to make/);
    assert.match(out, /manifest-owned × 1/);
  });

  it("touches no doc — an agent pointed at a doc-level finding writes compaction theater", async () => {
    await writeFile(join(dir, "docs", "features", "core.md"), "# core\n\nWhat it is.\n");
    const before = readFileSync(join(dir, "docs", "features", "core.md"), "utf-8");
    execFileSync("node", [CLI, "doctor", "--fix"], { cwd: dir, encoding: "utf-8" });
    assert.equal(readFileSync(join(dir, "docs", "features", "core.md"), "utf-8"), before);
  });

  it("is idempotent, and says plainly when there is nothing mechanical left", () => {
    execFileSync("node", [CLI, "doctor", "--fix"], { cwd: dir, encoding: "utf-8" });
    const first = read();
    const out = execFileSync("node", [CLI, "doctor", "--fix"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.deepStrictEqual(read(), first, "a second run changes nothing");
    assert.match(out, /Nothing mechanical to clear/);
  });

  it("the report that follows is the state the fix left, not the one it found", () => {
    const out = execFileSync("node", [CLI, "doctor", "--fix"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.doesNotMatch(
      out.slice(out.indexOf("codument doctor\n")),
      /mapped source no longer exists/,
      "the finding it just cleared must not still be listed below",
    );
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

// ── Scope confidence ────────────────────────────────────────────────────
//
// The field report's sharpest line: "The tool was most confident exactly where
// it was most wrong." A monorepo with no root git repo scored 100% coverage
// while 37% of the mapped "source" was compiled output. The ignore rules could
// not be read, so build output entered the denominator as first-party source —
// and because mapped build output lifts numerator and denominator together, the
// number read BETTER than the truth. These pin that the number now travels with
// the fact that its scope was never verified.

describe("doctor discloses an unverified scope", () => {
  let repo: string;
  let nonRepo: string;

  const scaffold = async (dir: string) => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", ".registry.json"), JSON.stringify({ features: {} }));
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codument-scope-repo-"));
    nonRepo = await mkdtemp(join(tmpdir(), "codument-scope-nonrepo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await scaffold(repo);
    await scaffold(nonRepo);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(nonRepo, { recursive: true, force: true });
  });

  it("reports scope applied, and says nothing extra, inside a real repo", () => {
    const report = buildReport(repo);
    assert.equal(report.scope.gitIgnore, "applied");
    assert.equal(report.scope.reason, undefined);

    const out = execFileSync("node", [CLI, "doctor"], { cwd: repo, encoding: "utf-8" });
    assert.doesNotMatch(out, /gitignore rules were not applied/i);
  });

  it("reports scope unavailable with a reason outside a repo", () => {
    const report = buildReport(nonRepo);
    assert.equal(report.scope.gitIgnore, "unavailable");
    assert.equal(report.scope.reason, "not a git repository");
  });

  it("prints the caveat beside the coverage number, never only the number", () => {
    const out = execFileSync("node", [CLI, "doctor"], { cwd: nonRepo, encoding: "utf-8" });
    assert.match(out, /Documentation coverage/);
    assert.match(out, /not a git repository/);
    assert.match(out, /\.gitignore rules were not applied/);
    assert.match(out, /may include build output/);
  });

  it("carries scope additively on the --json contract without a version bump", () => {
    const out = execFileSync("node", [CLI, "doctor", "--json"], {
      cwd: nonRepo,
      encoding: "utf-8",
    });
    const report = JSON.parse(out);
    // Additive: the version is untouched and every pre-existing key still reads
    // exactly as before, so a consumer that ignores `scope` is unaffected.
    assert.equal(report.version, 1);
    assert.ok("coverage" in report && "lint" in report);
    assert.deepStrictEqual(report.scope, {
      gitIgnore: "unavailable",
      reason: "not a git repository",
    });
  });

  it("reports scope unavailable when git itself fails, naming the failure", async () => {
    // The third branch: git says we ARE in a work tree, but the listing
    // subcommand fails (a broken/oversized invocation). An unreadable repository
    // must not read as a clean empty scope any more than a non-repo does.
    // Asserted through buildReport rather than the CLI on purpose: the command
    // layer's toplevel assertion refuses a broken git earlier and louder, which
    // is correct — this pins the analysis layer's own answer underneath it.
    const { chmod, writeFile: wf } = await import("node:fs/promises");
    const fakeBin = await mkdtemp(join(tmpdir(), "codument-fakegit-"));
    try {
      await wf(
        join(fakeBin, "git"),
        `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--is-inside-work-tree" ]; then echo true; exit 0; fi\ndone\nexit 3\n`,
      );
      await chmod(join(fakeBin, "git"), 0o755);
      const orig = process.env.PATH;
      process.env.PATH = `${fakeBin}:${orig ?? ""}`;
      try {
        const report = buildReport(nonRepo);
        assert.equal(report.scope.gitIgnore, "unavailable");
        // Matched, never compared exact: the tail is Node's child_process error
        // text, an internal detail that is not stable across Node majors.
        assert.match(report.scope.reason ?? "", /^git failed: /);
      } finally {
        process.env.PATH = orig;
      }
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("stays deterministic — the scope field is a pure function of repo state", () => {
    assert.deepStrictEqual(buildReport(nonRepo), buildReport(nonRepo));
    assert.deepStrictEqual(buildReport(repo), buildReport(repo));
  });
});

describe("doctor scores against the project's declared scope", () => {
  let root: string;

  // A documented source plus a build tree the project will declare. With nothing
  // declared the build tree is denominator; declaring it must remove it from BOTH
  // halves of the ratio, never just hide it from the display.
  const scaffold = async (exclude?: unknown) => {
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await mkdir(join(root, "app"), { recursive: true });
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(join(root, "app", "real.ts"), "export const a = 1;\n");
    await writeFile(join(root, "out", "gen.js"), "exports.g = 1;\n");
    await writeFile(join(root, "out", "gen2.js"), "exports.g = 2;\n");
    await writeFile(
      join(root, "docs", "features", "app.md"),
      "---\ntitle: App\nstatus: current\ntype: feature\n---\n\n## In plain terms\n\nThe app.\n",
    );
    await writeFile(
      join(root, "docs", ".registry.json"),
      JSON.stringify({
        features: {
          app: {
            doc: "docs/features/app.md",
            type: "feature",
            primary_sources: ["app/real.ts"],
            related_sources: [],
            docs: [],
            depends_on: [],
            risk: [],
            status: "current",
          },
        },
      }),
    );
    if (exclude !== undefined) {
      await writeFile(
        join(root, ".codument-meta.json"),
        JSON.stringify({
          version: "0.9.0",
          initialized: "2026-07-21",
          project: { srcDir: "." },
          exclude,
        }),
        "utf-8",
      );
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-doctor-exclude-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("counts an undeclared build tree against coverage (the bug)", async () => {
    await scaffold();
    const report = buildReport(root);
    assert.equal(report.inScopeSourceCount, 3, "app/real.ts + 2 build artifacts");
    const ownership = report.coverage.ratios.find((r) => r.id === "ownership");
    assert.equal(ownership?.denominator, 3, "build output inflates the denominator");
    assert.equal(ownership?.numerator, 1);
  });

  it("drops it from the denominator once the project declares it", async () => {
    await scaffold({ dirs: ["out"] });
    const report = buildReport(root);
    assert.equal(report.inScopeSourceCount, 1, "only the real source remains");
    const ownership = report.coverage.ratios.find((r) => r.id === "ownership");
    assert.equal(ownership?.denominator, 1);
    assert.equal(ownership?.numerator, 1);
    assert.equal(ownership?.ratio, 1);
  });

  it("declaring nothing leaves the report identical to no config at all", async () => {
    await scaffold();
    const without = buildReport(root);
    await writeFile(
      join(root, ".codument-meta.json"),
      JSON.stringify({
        version: "0.9.0",
        initialized: "2026-07-21",
        project: { srcDir: "." },
        exclude: {},
      }),
      "utf-8",
    );
    const withEmpty = buildReport(root);
    assert.deepEqual(withEmpty.coverage, without.coverage);
    assert.deepEqual(withEmpty.lint, without.lint);
    assert.equal(withEmpty.inScopeSourceCount, without.inScopeSourceCount);
  });

  // The other half of the honesty contract: an unreadable declaration does not
  // stop doctor (a score is not durable the way a registry entry is), but the
  // number must never be published as if the scope were verified.
  it("discloses that the declaration could not be read, in both surfaces", async () => {
    await scaffold();
    await writeFile(join(root, ".codument-meta.json"), "{ not json", "utf-8");

    const report = buildReport(root);
    assert.match(String(report.scope.declaredScope), /is unreadable/);
    // The git half is independent and stays applied — two distinct signals.
    assert.equal(report.scope.gitIgnore, "applied");

    const out = execFileSync("node", [CLI, "doctor"], { cwd: root, encoding: "utf-8" });
    assert.match(out, /wider than the project declared/);

    const json = JSON.parse(
      execFileSync("node", [CLI, "doctor", "--json"], { cwd: root, encoding: "utf-8" }),
    );
    assert.match(String(json.scope.declaredScope), /is unreadable/);
  });

  // A denominator narrowed by a project decision is not the defaults' denominator.
  // Two repositories' scores are only comparable if both scopes are visible.
  it("names the declared exclusions beside the score, in both surfaces", async () => {
    await scaffold({ dirs: ["out"], globs: ["**/*.gen.ts"] });
    const report = buildReport(root);
    assert.deepEqual(report.scope.configuredExclusions, {
      dirs: ["out"],
      globs: ["**/*.gen.ts"],
    });

    const out = execFileSync("node", [CLI, "doctor"], { cwd: root, encoding: "utf-8" });
    assert.match(out, /scope: also excluding/);
    assert.match(out, /1 dir\(s\): out/);
    assert.match(out, /1 glob\(s\): \*\*\/\*\.gen\.ts/);
    assert.match(out, /\.codument-meta\.json/);

    const json = JSON.parse(
      execFileSync("node", [CLI, "doctor", "--json"], { cwd: root, encoding: "utf-8" }),
    );
    assert.deepEqual(json.scope.configuredExclusions.dirs, ["out"]);
  });

  it("says nothing about a scope nobody narrowed", async () => {
    await scaffold();
    assert.equal(buildReport(root).scope.configuredExclusions, undefined);
    const out = execFileSync("node", [CLI, "doctor"], { cwd: root, encoding: "utf-8" });
    assert.doesNotMatch(out, /also excluding/);
    await scaffold({});
    assert.equal(buildReport(root).scope.configuredExclusions, undefined);
  });

  it("says nothing about the declaration when it read fine", async () => {
    await scaffold({ dirs: ["out"] });
    assert.equal(buildReport(root).scope.declaredScope, undefined);
    const out = execFileSync("node", [CLI, "doctor"], { cwd: root, encoding: "utf-8" });
    assert.doesNotMatch(out, /wider than the project declared/);
  });

  it("fails loud through the CLI rather than scoring on an invalid declaration", async () => {
    await scaffold({ dirs: ["out/nested"] });
    let stdout = "";
    let code = 0;
    try {
      stdout = execFileSync("node", [CLI, "doctor"], { cwd: root, encoding: "utf-8" });
    } catch (err) {
      stdout = (err as { stdout: string }).stdout;
      code = (err as { status: number }).status;
    }
    assert.equal(code, 1, "an invalid scope declaration must not produce a score");
    assert.match(stdout, /invalid exclude\.dirs/);
    assert.doesNotMatch(stdout, /Documentation coverage/);
  });
});

describe("doctor discloses a directory it could not read", () => {
  let root: string;
  let locked: string;

  const canLock = async (): Promise<boolean> => {
    const probe = await mkdtemp(join(tmpdir(), "codument-perm-probe-"));
    try {
      await chmod(probe, 0o000);
      readdirSync(probe);
      return false;
    } catch {
      return true;
    } finally {
      await chmod(probe, 0o755).catch(() => {});
      await rm(probe, { recursive: true, force: true });
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-doctor-unreadable-"));
    await mkdir(join(root, "src", "open"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "src", "open", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }));
    locked = join(root, "src", "locked");
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, "hidden.ts"), "export const h = 1;\n");
  });
  afterEach(async () => {
    await chmod(locked, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it("prints the note and carries it additively in --json", async (t) => {
    if (!(await canLock())) return t.skip("permission bits not enforced here (root?)");
    await chmod(locked, 0o000);

    const out = execFileSync("node", [CLI, "doctor"], { cwd: root, encoding: "utf-8" });
    assert.match(out, /1 directory could not be read/);
    assert.match(out, /a floor, not the count/);
    assert.match(out, /src\/locked/);

    const json = JSON.parse(
      execFileSync("node", [CLI, "doctor", "--json"], { cwd: root, encoding: "utf-8" }),
    );
    assert.deepEqual(json.scope.unreadableDirs, ["src/locked"]);
    assert.equal(json.version, 1, "additive: the contract version is unchanged");
  });

  it("says nothing when every directory is readable", () => {
    const out = execFileSync("node", [CLI, "doctor"], { cwd: root, encoding: "utf-8" });
    assert.doesNotMatch(out, /could not be read/);
    const json = JSON.parse(
      execFileSync("node", [CLI, "doctor", "--json"], { cwd: root, encoding: "utf-8" }),
    );
    assert.equal(json.scope.unreadableDirs, undefined);
  });
});

// Plan 42 / the 2026-08-09 field report. A `needs-review` entry is exempt from the
// dependency ratio and two lint rules so a fresh scan does not open at 0%. That
// reasoning says "seconds old"; the code says "forever". The field registry had sat
// at `needs-review` since a scan four months earlier, outside every ratio, reading as
// in-flight — and `lastScan` still recorded 292 source files against 404 on disk.
describe("a scaffold the tree has moved past is disclosed, never scored (plan 42)", () => {
  let root: string;

  async function project(opts: { status: string; scannedFiles?: number }): Promise<void> {
    root = await mkdtemp(join(tmpdir(), "codument-scaffold-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");
    await writeFile(
      join(root, "docs", "features", "alpha.md"),
      "# alpha\n\n## In plain terms\nAlpha does a thing worth narrating.\n",
    );
    await writeFile(
      join(root, "docs", ".registry.json"),
      JSON.stringify(
        {
          features: {
            alpha: {
              doc: "docs/features/alpha.md",
              type: "feature",
              primary_sources: ["src/a.ts", "src/b.ts"],
              related_sources: [],
              docs: [],
              depends_on: [],
              risk: [],
              status: opts.status,
            },
          },
        },
        null,
        2,
      ),
    );
    if (opts.scannedFiles !== undefined) {
      await writeFile(
        join(root, ".codument-meta.json"),
        JSON.stringify({ version: "0.15.0", lastScan: { sourceFiles: opts.scannedFiles } }, null, 2),
      );
    }
  }

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("says nothing when the scan still describes the tree (a first run stays byte-identical)", async () => {
    await project({ status: "needs-review", scannedFiles: 2 });
    const report = buildReport(root);
    assert.equal(report.coverage.scaffolded, 1, "the entry IS a scaffold");
    assert.equal(report.coverage.scanLag, 0, "and the scan still describes the tree");
  });

  it("discloses the count once the tree has moved past the scan", async () => {
    await project({ status: "needs-review", scannedFiles: 1 });
    const report = buildReport(root);
    assert.equal(report.coverage.scaffolded, 1);
    assert.equal(report.coverage.scanLag, 1, "one source file added since the scan");
  });

  it("reads a shrinking tree as movement too, not as a negative count", async () => {
    await project({ status: "needs-review", scannedFiles: 5 });
    assert.equal(buildReport(root).coverage.scanLag, -3);
    const out = execFileSync("node", [CLI, "doctor"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(out, /3 source file\(s\) removed since/);
  });

  it("counts no scaffold once the entry is reviewed", async () => {
    await project({ status: "current", scannedFiles: 1 });
    assert.equal(buildReport(root).coverage.scaffolded, 0);
  });

  it("cannot tell without a recorded scan, and says so rather than guessing", async () => {
    await project({ status: "needs-review" });
    assert.equal(buildReport(root).coverage.scanLag, null);
  });

  it("is disclosure only — it never moves the strict exit code", async () => {
    await project({ status: "needs-review", scannedFiles: 1 });
    let status = 0;
    try {
      execFileSync("node", [CLI, "doctor", "--strict"], {
        cwd: root,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (err) {
      status = (err as { status?: number }).status ?? 1;
    }
    const out = execFileSync("node", [CLI, "doctor"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(out, /still `needs-review` from a scan the tree has moved past/);
    assert.equal(status, 0, "a scaffold disclosure is not an actionable finding");
  });
});
