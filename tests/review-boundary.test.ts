import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

function cli(args: string[]): { status: number; stdout: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync("node", [CLI, ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

function review(args: string[]): { status: number; stdout: string } {
  return cli(["review", ...args]);
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

  it("prints and records an acknowledgment against the exact staged boundary", async () => {
    await put("src/a.ts", "export const a = 1;\nexport const helper = 2;\n");
    git(["add", "src/a.ts"]);

    const first = review(["--staged"]);
    assert.equal(first.status, 0);
    const fingerprint = /boundary: staged · ([a-f0-9]+)/.exec(first.stdout)?.[1];
    assert.ok(fingerprint);
    assert.match(
      first.stdout,
      new RegExp(`codument ack src/a\\.ts --staged --boundary ${fingerprint}[a-f0-9]* --reason`),
    );

    const recorded = cli([
      "ack",
      "src/a.ts",
      "--staged",
      "--boundary",
      review(["--staged", "--json"]).stdout.match(/"fingerprint": "([a-f0-9]+)"/)?.[1] ?? "",
      "--reason",
      "the documented alpha contract is unchanged",
    ]);
    assert.equal(recorded.status, 0);
    assert.equal(JSON.parse(review(["--staged", "--json"]).stdout).state.staleDocs.length, 0);

    const [ackFile] = await readdir(join(repo, ".codument", "acks"));
    const ack = JSON.parse(await readFile(join(repo, ".codument", "acks", ackFile), "utf8"));
    assert.equal(ack.boundary.fingerprint.length, 64);
    assert.equal(ack.boundary.mode, "staged");

    await put("src/b.ts", "export const b = 2;\n");
    git(["add", "src/b.ts"]);
    const movedBoundary = JSON.parse(review(["--staged", "--json"]).stdout);
    assert.ok(
      movedBoundary.state.staleDocs.some((doc: { feature: string }) => doc.feature === "alpha"),
      "a decision from another staged boundary cannot clear this one",
    );
  });

  it("refuses a copied acknowledgment after its expected boundary moved", async () => {
    await put("src/a.ts", "export const a = 1;\nexport const helper = 2;\n");
    git(["add", "src/a.ts"]);
    const fingerprint = JSON.parse(review(["--staged", "--json"]).stdout).boundary.fingerprint;
    await put("src/b.ts", "export const b = 2;\n");
    git(["add", "src/b.ts"]);

    const result = cli([
      "ack",
      "src/a.ts",
      "--staged",
      "--boundary",
      fingerprint,
      "--reason",
      "the documented alpha contract is unchanged",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /boundary moved/i);
  });

  it("refuses competing acknowledgment boundary selectors", async () => {
    await put("src/a.ts", "export const a = 1;\nexport const helper = 2;\n");
    git(["add", "src/a.ts"]);

    const result = cli([
      "ack",
      "src/a.ts",
      "--staged",
      "--paths",
      "src/a.ts",
      "--reason",
      "the documented alpha contract is unchanged",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /pick one/i);
  });

  it("binds review bundles and recorded artifacts to the staged projection", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    await put("src/b.ts", "export const b = 2;\n");
    await put("docs/features/alpha.md", "# alpha\n\nReviewed for this delivery.\n");
    await put("docs/features/beta.md", "# beta\n\nReviewed for this delivery.\n");
    git(["add", "src/a.ts", "src/b.ts", "docs/features/alpha.md", "docs/features/beta.md"]);

    const bundle = JSON.parse(review(["--staged", "--bundle"]).stdout);
    assert.equal(bundle.boundary.mode, "staged");
    assert.equal(bundle.boundary.fingerprint.length, 64);
    await put("outside.txt", "unrelated worktree churn\n");
    const outsideChurn = JSON.parse(review(["--staged", "--bundle"]).stdout);
    assert.equal(
      outsideChurn.stamp,
      bundle.stamp,
      "unrelated unstaged diagnostics are not part of the attested oracle",
    );
    assert.deepEqual(outsideChurn.boundary, bundle.boundary);
    await put(
      "review-input.json",
      JSON.stringify({
        invariantsChecked: ["the staged alpha and beta contracts remain compatible"],
        findings: [],
        signer: "test-reviewer",
        bundleStamp: bundle.stamp,
      }),
    );
    assert.equal(review(["--staged", "--record", "review-input.json"]).status, 0);

    const [artifactFile] = await readdir(join(repo, ".codument", "reviews"));
    const artifact = JSON.parse(
      await readFile(join(repo, ".codument", "reviews", artifactFile), "utf8"),
    );
    assert.equal(artifact.boundary.fingerprint, bundle.boundary.fingerprint);

    await put("notes.txt", "another staged fact\n");
    git(["add", "notes.txt"]);
    const moved = JSON.parse(review(["--staged", "--bundle"]).stdout);
    assert.notEqual(moved.boundary.fingerprint, artifact.boundary.fingerprint);
  });
});
