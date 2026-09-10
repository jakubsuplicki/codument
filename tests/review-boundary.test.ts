import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

it("requires doc-only invariant review and preserves the removed contract in its staged bundle", async () => {
  const path = "docs/features/alpha.md";
  await put(
    path,
    "# Alpha\n\n## In plain terms\nStores records.\n\n## Invariants & boundaries\n- Never discard existing records. *(test: ledger.test.ts)*\n",
  );
  git(["add", path]);
  git(["commit", "-qm", "contract"]);
  await put(path, "# Alpha\n\n## In plain terms\nStores records.\n");
  git(["add", path]);
  const bundle = JSON.parse(review(["--staged", "--bundle"]).stdout);
  assert.match(bundle.features[0].before.invariants, /Never discard/);
  assert.deepEqual(bundle.contractChanges[0].testPointers, ["ledger.test.ts"]);
  assert.equal(review(["--staged", "--require-review"]).status, 1);
  assert.match(cli(["verify"]).stdout, /REVIEW REQUIRED/);
  await put(
    path,
    "# Alpha\n\n## In plain terms\nStores  records.\n\n## Invariants & boundaries\n- Never discard existing records. *(test: ledger.test.ts)*\n",
  );
  git(["add", path]);
  assert.equal(review(["--staged", "--require-review"]).status, 0);
});

it("reviews registered workflow policies while ignoring instruction formatting", async () => {
  const path = "skills/work-step/SKILL.md";
  const registryPath = join(repo, "docs/.registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.features.alpha.docs = [path];
  await put("docs/.registry.json", JSON.stringify(registry));
  await put(path, "Wait for human approval.\n");
  git(["add", "docs/.registry.json", path]);
  git(["commit", "-qm", "workflow"]);
  await put(path, "Start without approval.\n");
  git(["add", path]);
  const bundle = JSON.parse(review(["--staged", "--bundle"]).stdout);
  assert.equal(bundle.contractChanges[0].kind, "instruction");
  assert.equal(review(["--staged", "--require-review"]).status, 1);
  await put(path, "Wait  for human approval.\r\n");
  git(["add", path]);
  assert.equal(review(["--staged", "--require-review"]).status, 0);
});

it("retains member instruction history in working-tree bundles with or without a Git root", async () => {
  for (const gitRoot of [false, true]) {
    const workspace = await mkdtemp(join(tmpdir(), "codument-member-grounding-"));
    const member = join(workspace, "api");
    const runGit = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    try {
      await mkdir(join(member, "skills"), { recursive: true });
      await mkdir(join(workspace, "docs/features"), { recursive: true });
      await writeFile(
        join(workspace, "docs/.registry.json"),
        JSON.stringify({
          features: {
            alpha: {
              doc: "docs/features/alpha.md",
              type: "feature",
              primary_sources: [],
              related_sources: [],
              docs: ["api/skills/work-step/SKILL.md"],
              depends_on: [],
              risk: [],
              status: "current",
            },
          },
        }),
      );
      await writeFile(
        join(workspace, "docs/features/alpha.md"),
        "## In plain terms\nHuman-approved delivery.\n",
      );
      if (gitRoot) {
        runGit(workspace, "init", "-q");
        runGit(workspace, "config", "user.name", "Test");
        runGit(workspace, "config", "user.email", "test@example.com");
        runGit(workspace, "add", "docs");
        runGit(workspace, "commit", "-qm", "workspace docs");
      }
      runGit(member, "init", "-q");
      runGit(member, "config", "user.name", "Test");
      runGit(member, "config", "user.email", "test@example.com");
      await mkdir(join(member, "skills/work-step"));
      const instruction = join(member, "skills/work-step/SKILL.md");
      await writeFile(instruction, "Wait for human approval.\n");
      runGit(member, "add", ".");
      runGit(member, "commit", "-qm", "member contract");
      await writeFile(instruction, "Start without approval.\n");
      const bundle = JSON.parse(
        execFileSync(process.execPath, [CLI, "review", "--bundle"], {
          encoding: "utf8",
          cwd: workspace,
        }),
      );
      assert.equal(bundle.contractChanges[0].before.trim(), "Wait for human approval.");
    } finally {
      forgetWorkspace();
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

it("grounds a committed documentation-only range and retains removed source owners", async () => {
  const doc = "docs/features/alpha.md";
  await put(doc, "## Invariants & boundaries\n- Preserve records. *(test: alpha.test.ts)*\n");
  git(["add", doc]);
  git(["commit", "-qm", "contract"]);
  const base = git(["rev-parse", "HEAD"]);
  await put(doc, "# Alpha\n");
  git(["add", doc]);
  git(["commit", "-qm", "remove contract"]);
  const historical = JSON.parse(review(["--base", base, "--bundle"]).stdout);
  assert.match(historical.features[0].before.invariants, /Preserve records/);
  assert.ok(historical.contractChanges[0].testPointers.includes("alpha.test.ts"));
  const registry = JSON.parse(await readFile(join(repo, "docs/.registry.json"), "utf8"));
  delete registry.features.alpha;
  await put("docs/.registry.json", JSON.stringify(registry));
  await put("src/a.ts", "export const a = 2;\n");
  git(["add", "docs/.registry.json", "src/a.ts"]);
  const removed = JSON.parse(review(["--staged", "--bundle"]).stdout);
  assert.ok(removed.features.some((feature: { feature: string }) => feature.feature === "alpha"));
});

it("keeps doc-only review required beside excluded additions and deletions", async () => {
  await put("docs/features/alpha.md", "## Design approach\nKeep records immutable.\n");
  await put(".codument-meta.json", JSON.stringify({ exclude: { globs: ["generated/**"] } }));
  await put("generated/data.txt", "generated\n");
  git(["add", "docs/features/alpha.md", ".codument-meta.json", "generated/data.txt"]);
  git(["commit", "-qm", "contract and excluded output"]);
  await put("docs/features/alpha.md", "## Design approach\nAllow rewriting records.\n");
  await put("generated/added.txt", "new generated data\n");
  git(["add", "docs/features/alpha.md", "generated/added.txt"]);
  assert.equal(review(["--staged", "--require-review"]).status, 1);
  git(["rm", "generated/data.txt"]);
  const result = review(["--staged", "--require-review", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).contractChanges[0].requiresReview, true);
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

  for (const directory of ["features", "concepts", "plans"]) {
    it(`reads embedded approval and scope from the index under docs/${directory}`, async () => {
      const path = `docs/${directory}/delivery.md`;
      const draft =
        "---\nstatus: current\n---\n## Delivery Plan\nStatus: draft\n- [ ] next\n### Scope\n- `src/b.ts`\n";
      await put(path, draft);
      git(["add", path]);
      git(["commit", "-qm", "draft plan"]);
      await put(path, draft.replace("Status: draft", "Status: approved"));
      await put("src/a.ts", "export const a = 2;\n");
      git(["add", "src/a.ts"]);
      const unapproved = review(["--staged", "--json"]);
      assert.equal(unapproved.status, 0);
      assert.equal(
        JSON.parse(unapproved.stdout).plan,
        null,
        "unstaged approval cannot authorize a staged change",
      );
      git(["add", path]);
      const approved = review(["--staged", "--json"]);
      assert.equal(approved.status, 0);
      const report = JSON.parse(approved.stdout);
      assert.equal(report.plan.plan, path);
      assert.deepEqual(report.plan.scope, ["src/b.ts"]);
      assert.deepEqual(report.state.outOfPlan, ["src/a.ts"]);
    });
  }

  it("refuses ambiguous approved scope in machine and human output", async () => {
    for (const directory of ["features", "plans"]) {
      await put(
        `docs/${directory}/delivery.md`,
        "## Delivery Plan\nStatus: approved\n- [ ] next\n### Scope\n- `src/a.ts`\n",
      );
    }
    await put("src/a.ts", "export const a = 2;\n");
    git(["add", "src/a.ts", "docs/features/delivery.md", "docs/plans/delivery.md"]);
    const result = review(["--staged", "--json"]);
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.gate, "unavailable");
    assert.match(
      failure.reason,
      /multiple approved plans.*docs\/features\/delivery\.md.*docs\/plans\/delivery\.md/,
    );
    assert.match(failure.reason, /no scope selected/);
    const human = review(["--staged"]);
    assert.equal(human.status, 1);
    assert.match(human.stdout, /no scope selected/);
  });

  it("map and context retrieve the selected plan instead of a future draft", async () => {
    const path = "docs/features/delivery.md";
    await put(
      path,
      [
        "## Delivery Plan — current",
        "Status: approved",
        "- [ ] next",
        "### Feature Map",
        "```feature-map",
        "src/a.ts | alpha | feature | current work",
        "```",
        "## Delivery Plan — future",
        "Status: draft",
        "- [ ] later",
        "### Feature Map",
        "```feature-map",
        "src/a.ts | beta | feature | future work",
        "```",
      ].join("\n"),
    );
    const route = cli(["map", "route", "src/a.ts", "--plan", path, "--json"]);
    assert.equal(route.status, 0);
    assert.equal(JSON.parse(route.stdout).feature, "alpha");
    const context = cli(["context", "--plan", path, "--json"]);
    assert.equal(context.status, 0);
    assert.deepEqual(
      JSON.parse(context.stdout).entries.map((entry: { feature: string }) => entry.feature),
      ["alpha"],
    );
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

  it("treats staged tests as review evidence without creating doc ownership work", async () => {
    await put("tests/a.test.ts", 'import { a } from "../src/a.js";\n');
    await put("tests/mystery.test.ts", 'import external from "external-package";\n');
    git(["add", "tests/a.test.ts", "tests/mystery.test.ts"]);

    const report = JSON.parse(review(["--staged", "--json"]).stdout);
    assert.deepEqual(report.state.changedSources, []);
    assert.deepEqual(report.state.unmapped, []);
    assert.deepEqual(report.state.staleDocs, []);
    assert.deepEqual(report.testImpact, {
      changedTests: ["tests/a.test.ts", "tests/mystery.test.ts"],
      attributed: [{ test: "tests/a.test.ts", feature: "alpha", via: "direct-import" }],
      unattributed: ["tests/mystery.test.ts"],
      dependents: [],
      dependentsSummary: [],
    });
    const strict = review(["--staged", "--strict"]);
    assert.equal(strict.status, 0, "tests never create doc work");
    assert.match(strict.stdout, /Test evidence/);
    assert.match(strict.stdout, /alpha.*tests\/a\.test\.ts.*direct-import/);
    assert.match(strict.stdout, /unattributed.*tests\/mystery\.test\.ts/);

    const bundle = JSON.parse(review(["--staged", "--bundle"]).stdout);
    assert.deepEqual(bundle.testImpact, report.testImpact);
    assert.ok(bundle.features.some((feature: { feature: string }) => feature.feature === "alpha"));
    await put(
      "test-review-input.json",
      JSON.stringify({
        invariantsChecked: ["the selected tests still enforce the alpha boundary"],
        findings: [],
        signer: "test-reviewer",
        bundleStamp: bundle.stamp,
      }),
    );
    assert.equal(review(["--staged", "--record", "test-review-input.json"]).status, 0);

    const [artifactFile] = await readdir(join(repo, ".codument", "reviews"));
    const artifact = JSON.parse(
      await readFile(join(repo, ".codument", "reviews", artifactFile), "utf8"),
    );
    assert.deepEqual(
      artifact.files.map((file: { path: string }) => file.path),
      ["tests/a.test.ts", "tests/mystery.test.ts"],
    );
  });
});
