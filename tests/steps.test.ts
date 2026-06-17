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
    assert.deepEqual(
      parsed.steps.map((s: { status: string }) => s.status),
      ["in_progress", "pending"],
    );
    // …while auto-discovery correctly refuses it (not approved yet)
    const auto = runCli(["steps", "--dir", tmp], tmp);
    assert.equal(auto.code, 1);
    assert.match(auto.out, /no approved plan/i);
  });

  it("prints a human checklist marking the active step", async () => {
    await writeFile(join(tmp, "docs", "features", "feed.md"), PLAN);
    const { out, code } = runCli(["steps", "--dir", tmp], tmp);
    assert.equal(code, 0);
    assert.match(out, /Plan: feed/);
    assert.match(out, /Step 2: tail with byte offset/);
    assert.match(out, /Mirror these into your native to-do list/);
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
