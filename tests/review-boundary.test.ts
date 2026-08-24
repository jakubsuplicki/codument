import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { forgetWorkspace } from "../src/lib/git.js";

process.env.NO_COLOR = "1";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
let repo: string;

async function put(path: string, content: string): Promise<void> {
  const full = join(repo, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function review(args: string[]): { status: number; stdout: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync("node", [CLI, "review", ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "" };
  }
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "codument-review-boundary-"));
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
          beta: {
            doc: "docs/features/beta.md",
            type: "feature",
            primary_sources: ["src/b.ts"],
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
  await put("docs/features/alpha.md", "# alpha\n");
  await put("docs/features/beta.md", "# beta\n");
  await put("src/a.ts", "export const a = 1;\n");
  await put("src/b.ts", "export const b = 1;\n");
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
});

afterEach(async () => {
  forgetWorkspace();
  await rm(repo, { recursive: true, force: true });
});

describe("review staged boundary", () => {
  it("analyzes only staged paths and reports unrelated dirty work without blocking on it", async () => {
    await put("src/a.ts", "export const a = (value: number) => value;\n");
    git(["add", "src/a.ts"]);
    await put("src/b.ts", "export const b = (value: string) => value;\n");
    const unrelatedRegistry = JSON.parse(await readFile(join(repo, "docs/.registry.json"), "utf8"));
    unrelatedRegistry.features.alpha.primary_sources = ["src/not-a.ts"];
    await put("docs/.registry.json", JSON.stringify(unrelatedRegistry, null, 2));
    await put(
      ".codument-meta.json",
      JSON.stringify({ version: "test", exclude: { globs: ["src/a.ts"] } }, null, 2),
    );
    await put(
      "docs/plans/unrelated.md",
      "---\nstatus: approved\n---\n\n## Scope\n\n- `src/b.ts`\n",
    );

    const focused = review(["--staged", "--json"]);
    assert.equal(focused.status, 0);
    const report = JSON.parse(focused.stdout);
    assert.equal(report.boundary.mode, "staged");
    assert.equal(report.boundary.complete, true);
    assert.deepEqual(report.boundary.dirtyOutside, [
      ".codument-meta.json",
      "docs/.registry.json",
      "docs/plans/unrelated.md",
      "src/b.ts",
    ]);
    assert.deepEqual(report.state.changedSources, ["src/a.ts"]);
    assert.deepEqual(report.state.unmapped, []);
    assert.equal(report.plan, null, "an unstaged plan cannot scope the staged boundary");
    assert.deepEqual(report.state.outOfPlan, []);
    assert.equal(
      report.state.staleDocs.some((doc: { feature: string }) => doc.feature === "beta"),
      false,
    );

    const legacy = JSON.parse(review(["--json"]).stdout);
    assert.deepEqual(legacy.state.changedSources, ["src/b.ts"]);
    assert.ok(legacy.state.excludedChanged.includes("src/a.ts"));
    assert.equal("boundary" in legacy, false, "legacy JSON stays byte-shape compatible");
  });

  it("keeps an explicit path selection diagnostic until it covers every staged path", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    await put("src/b.ts", "export const b = 2;\n");
    git(["add", "src/a.ts", "src/b.ts"]);

    const subset = JSON.parse(review(["--paths", "src/a.ts", "--json"]).stdout);
    assert.equal(subset.boundary.mode, "explicit-staged");
    assert.equal(subset.boundary.complete, false);
    assert.deepEqual(subset.boundary.unselectedStagedPaths, ["src/b.ts"]);
    assert.deepEqual(subset.state.changedSources, ["src/a.ts"]);

    const strict = review(["--paths", "src/a.ts", "--strict", "--json"]);
    assert.equal(strict.status, 1, "an incomplete subset cannot become an authoritative pass");
  });

  it("reads an approved plan from the selected index snapshot", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    await put("docs/plans/staged.md", "---\nstatus: approved\n---\n\n## Scope\n\n- `src/b.ts`\n");
    git(["add", "src/a.ts", "docs/plans/staged.md"]);

    const result = review(["--staged", "--json"]);
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.plan.plan, "docs/plans/staged.md");
    assert.deepEqual(report.state.outOfPlan, ["src/a.ts"]);
  });

  it("does not parse an unrelated invalid worktree config", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    git(["add", "src/a.ts"]);
    await put(".codument-meta.json", "{ this is not json\n");

    const result = review(["--staged", "--json"]);
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.state.changedSources, ["src/a.ts"]);
    assert.ok(report.boundary.dirtyOutside.includes(".codument-meta.json"));
  });

  it("fails before analysis when selected worktree content moved after staging", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    git(["add", "src/a.ts"]);
    await put("src/a.ts", "export const a = 3;\n");

    const result = review(["--staged", "--json"]);
    assert.equal(result.status, 1);
    const unavailable = JSON.parse(result.stdout);
    assert.equal(unavailable.gate, "unavailable");
    assert.equal(unavailable.kind, "worktree-overlap");
    assert.match(unavailable.reason, /src\/a\.ts/);
  });

  it("names the focused boundary and ignored dirty count in detailed human output", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    git(["add", "src/a.ts"]);
    await put("notes.txt", "outside\n");

    const result = review(["--staged"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /boundary: staged/);
    assert.match(result.stdout, /1 unrelated dirty path/);
  });
});
