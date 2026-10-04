import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

const PLAN = `## Delivery Plan
Status: approved

- [x] Step 1: schema
- [ ] Step 2: tail with byte offset
- [ ] Step 3: tests
`;

/** Run the CLI, capturing stdout even on a non-zero exit. */
function runCli(args: string[], cwd: string): { out: string; code: number } {
  try {
    const out = execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8" });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: err.stdout ?? "", code: err.status ?? 1 };
  }
}

describe("codument steps (CLI, temp repo)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-steps-cli-"));
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("prints a machine-readable checklist with per-step to-do status for mirroring", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    const { out, code } = runCli(["steps", "--json", "--dir", tmp], tmp);
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.plan, "docs/features/feed.md");
    assert.equal(parsed.planName, "feed");
    assert.equal(parsed.active.n, 2);
    assert.deepEqual(
      parsed.steps.map((s: { status: string }) => s.status),
      ["completed", "in_progress", "pending"],
    );
  });

  it("renders an awaiting-approval plan via --plan (the plan-approval summary path)", async () => {
    // plan-with-docs writes this exact status before the approval gate.
    const awaiting = `## Delivery Plan
Status: draft, awaiting approval before source edits.

- [ ] Step 1: red regression test
- [ ] Step 2: green implementation
`;
    await writeFile(join(tmp, "docs", "features", "recipe.md"), awaiting);
    const { out, code } = runCli(
      ["steps", "--json", "--plan", "docs/features/recipe.md", "--dir", tmp],
      tmp,
    );
    assert.equal(code, 0); // explicit --plan does not require approval
    const parsed = JSON.parse(out);
    assert.equal(parsed.active.n, 1);
    assert.equal(parsed.approved, false);
    assert.deepEqual(
      parsed.steps.map((s: { status: string }) => s.status),
      ["in_progress", "pending"],
    );
    // …while auto-discovery correctly refuses it (not approved yet)
    const auto = runCli(["steps", "--dir", tmp], tmp);
    assert.equal(auto.code, 1);
    assert.match(auto.out, /no approved plan/i);
    const preview = runCli(["steps", "--plan", "docs/features/recipe.md", "--dir", tmp], tmp);
    assert.match(preview.out, /preview only.*not approved/i);
    const emitted = runCli(["steps", "--json", "--emit", "--plan", "docs/features/recipe.md", "--dir", tmp], tmp);
    assert.equal(emitted.code, 0);
    assert.equal(JSON.parse(emitted.out).emitted, false);
    await assert.rejects(readFile(join(tmp, ".codument/events.jsonl")), { code: "ENOENT" });
  });

  it("prints a human checklist marking the active step", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    const { out, code } = runCli(["steps", "--dir", tmp], tmp);
    assert.equal(code, 0);
    assert.match(out, /Plan: feed/);
    assert.match(out, /Step 2: tail with byte offset/);
    assert.match(out, /Mirror these into your native to-do list/);
  });

  it("shares a checked but undelivered milestone and pending gate with status and context", async () => {
    const path = "docs/features/delivery.md";
    const plan = "## Delivery Plan\nStatus: approved\nPlan-ID: selected-delivery\n- [ ] Demonstrate the value\n- [ ] Broaden the fixture\n\n### Scope\n- `src/value.ts`\n";
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, path), plan);
    await writeFile(join(tmp, "src/value.ts"), "export const value = 1;\n");
    await writeFile(join(tmp, ".gitignore"), ".codument/\n");
    await writeFile(join(tmp, "docs/.registry.json"), JSON.stringify({ features: { delivery: { doc: path, type: "feature", primary_sources: ["src/value.ts"], related_sources: [], docs: [], depends_on: [], risk: [], status: "current" } } }));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    git("add", "."); git("commit", "-qm", "baseline");
    assert.equal(runCli(["work", "approve", "--plan", path], tmp).code, 0);
    assert.equal(runCli(["work", "start", "--plan", path], tmp).code, 0);
    await writeFile(join(tmp, path), (await readFile(join(tmp, path), "utf8")).replace("- [ ] Demonstrate", "- [x] Demonstrate"));
    const status = JSON.parse(runCli(["work", "status", "--json"], tmp).out);
    const steps = JSON.parse(runCli(["steps", "--json", "--emit"], tmp).out);
    const context = JSON.parse(runCli(["context", "--json"], tmp).out);
    assert.equal(status.progress.step, 1);
    assert.equal(status.progress.nextGate, "verify");
    assert.equal(status.progress.canExecute, false);
    assert.deepEqual(steps.progress, status.progress);
    assert.deepEqual(context.progress, status.progress);
    assert.deepEqual(steps.steps.map((step: { status: string }) => step.status), ["in_progress", "pending"]);
    assert.equal(steps.current.n, 1);
    assert.equal(steps.active, null);
    assert.equal(steps.emitted, false);
    assert.equal(runCli(["work", "pause", "--gate", "review", "--reason", "Waiting for external evidence"], tmp).code, 0);
    const pausedStatus = JSON.parse(runCli(["work", "status", "--json"], tmp).out);
    const pausedSteps = JSON.parse(runCli(["steps", "--json", "--emit"], tmp).out);
    const pausedContext = JSON.parse(runCli(["context", "--json"], tmp).out);
    assert.deepEqual(pausedSteps.progress, pausedStatus.progress);
    assert.deepEqual(pausedContext.progress, pausedStatus.progress);
    assert.equal(pausedSteps.current.n, 1);
    assert.equal(pausedSteps.progress.nextGate, "review");
    assert.equal(pausedSteps.progress.interruption.reason, "Waiting for external evidence");
    assert.equal(pausedSteps.emitted, false);
    assert.ok(pausedSteps.steps.every((step: { status: string }) => step.status === "pending"));

    const replacementPath = "docs/features/replacement.md";
    await writeFile(join(tmp, replacementPath), plan.replace("selected-delivery", "replacement-delivery"));
    assert.equal(runCli(["work", "approve", "--plan", replacementPath], tmp).code, 0);
    assert.equal(runCli(["work", "supersede", "--plan", replacementPath, "--reason", "New priority"], tmp).code, 0);
    assert.equal(runCli(["work", "start", "--plan", replacementPath], tmp).code, 0);
    const preview = JSON.parse(runCli(["steps", "--plan", path, "--json", "--emit"], tmp).out);
    assert.equal(preview.progress.selection, "preview");
    assert.equal(preview.progress.status, "superseded");
    assert.equal(preview.emitted, false);
    assert.deepEqual(preview.steps.map((step: { status: string }) => step.status), preview.progress.steps.map((step: { status: string }) => step.status));
    assert.ok(preview.steps.every((step: { status: string }) => step.status === "pending"));
  });

  it("diagnoses qualified approval without granting it or changing the plan", async () => {
    const file = join(tmp, "docs/features/dated.md");
    const content = PLAN.replace("Status: approved", "Status: approved 2026-09-10");
    await writeFile(file, content);
    const result = runCli(["steps", "--dir", tmp], tmp);
    assert.equal(result.code, 1);
    assert.match(result.out, /docs\/features\/dated\.md/);
    assert.match(result.out, /Status: approved/);
    const map = runCli(["map", "route", "src/a.ts"], tmp);
    assert.equal(map.code, 1);
    assert.match(map.out, /docs\/features\/dated\.md/);
    assert.match(map.out, /Status: approved/);
    assert.equal(await readFile(file, "utf8"), content);
  });

  it("--emit writes a step event into .codument/events.jsonl", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    const { code } = runCli(["steps", "--emit", "--dir", tmp], tmp);
    assert.equal(code, 0);
    const log = await readFile(join(tmp, ".codument", "events.jsonl"), "utf-8");
    const events = log
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const steps = events.filter((e) => e.type === "step");
    assert.equal(steps.length, 1);
    assert.match(steps[0].message, /▶ Step 2: tail/);
    assert.equal(steps[0].data.n, 2);
  });

  it("exits non-zero with a message when no approved plan is found", async () => {
    await writeFile(
      join(tmp, "docs", "features", "draft.md"),
      "## Delivery Plan\nStatus: draft\n- [ ] Step 1: x\n",
    );
    const { out, code } = runCli(["steps", "--dir", tmp], tmp);
    assert.equal(code, 1);
    assert.match(out, /no approved plan/i);
  });

  it("reads a specific doc with --plan even when discovery would be ambiguous", async () => {
    await writeFile(join(tmp, "docs", "features", "a.md"), PLAN);
    await writeFile(join(tmp, "docs", "features", "b.md"), PLAN);
    // discovery alone is ambiguous (two approved plans)…
    const ambiguous = runCli(["steps", "--dir", tmp], tmp);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.out, /multiple approved plans/i);
    // …but --plan resolves it
    const picked = runCli(
      ["steps", "--json", "--plan", "docs/features/b.md", "--dir", tmp],
      tmp,
    );
    assert.equal(picked.code, 0);
    assert.equal(JSON.parse(picked.out).plan, "docs/features/b.md");
  });
});
