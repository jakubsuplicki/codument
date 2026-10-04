import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const doc = "docs/features/report.md";
const sources = ["src/report.js", "src/validate.js", "src/render.js"];
const baseline = "console.log('Pieces: ' + Number.parseInt(process.argv[2], 10));\n";
const plan = `## Delivery Plan
Status: approved
Plan-ID: working-report
Approval-Model: outcome-v1

- [ ] Demonstrate the report for valid and invalid input.

### Outcome
A local command displays a positive whole-number piece count; invalid input returns an actionable diagnostic.

### Constraints & non-goals
Keep execution local and synchronous, use Node without dependencies, preserve privacy and spending, and add no service or stored data.

### Acceptance evidence
Run the actual command with a valid count and a malformed count, inspecting output and exit status.

### Verification
Run the report integration tests, review exactly the staged change, and verify delivery before committing.

### Scope
- \`src/report.js\`
`;
const durable = `---
title: Piece report
status: current
type: feature
last_reviewed: 2026-10-04
---

# Piece report

## In plain terms

The local command displays a requested piece count.

## Design approach

Input validation and presentation stay local, with no persistence or network access.

## Invariants & boundaries

- Only positive safe whole-number counts produce a report. Invalid input names the expected format and fails. *(test: tests/report.test.js)*

## Decisions

- Keep execution synchronous and dependency-free.

## Key files

- \`src/report.js\` — command entry.
- \`src/validate.js\` — input contract.
- \`src/render.js\` — report presentation.

`;

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("NODE_TEST_")) delete env[key];
  return env;
}
function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: childEnv(),
  });
}
function success(root: string, ...args: string[]): string {
  const result = cli(root, ...args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}
function json(root: string, ...args: string[]) {
  return JSON.parse(success(root, ...args, "--json"));
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "codument-working-milestone-"));
  put(root, ".gitignore", ".codument/\n");
  put(root, "package.json", JSON.stringify({ name: "milestone-fixture", type: "module", private: true }));
  put(root, ".codument-meta.json", JSON.stringify({ testCommand: "node --test {file}" }));
  put(root, doc, "# Piece report\n\nThe local command displays a count.\n\n" + plan);
  put(root, sources[0], baseline);
  put(root, "docs/.registry.json", JSON.stringify({ features: {
    report: { doc, type: "feature", primary_sources: [sources[0]], related_sources: [], docs: [], depends_on: [], risk: [], status: "current" },
  } }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Milestone fixture");
  git(root, "config", "user.email", "fixture@example.com");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  success(root, "work", "approve", "--plan", doc, "--signer", "fixture approval recorder");
  success(root, "work", "start", "--plan", doc);
  return root;
}
function discover(root: string): void {
  put(root, sources[0], `import { validateCount } from "./validate.js";
import { renderCount } from "./render.js";
try { console.log(renderCount(validateCount(process.argv[2]))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  put(root, sources[1], `export function validateCount(raw) {
  const count = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw ?? "") || !Number.isSafeInteger(count)) {
    throw new Error("Count must be a positive whole number.");
  }
  return count;
}
`);
  put(root, sources[2], "export function renderCount(count) { return 'Pieces: ' + (count + 1); }\n");
  put(root, doc, readFileSync(join(root, doc), "utf8") +
    "- `src/validate.js`\n- `src/render.js`\n\n### Implementation notes\nValidation and presentation need local helpers discovered during implementation.\n");
}

it("delivers an observed milestone after discovery and routine repair, with scoped bookkeeping evidence", { timeout: 180_000 }, (t) => {
  const old = fixture();
  const batch = fixture();
  try {
    // Both routes use the same current executable and equivalent fixture inputs.
    // This compares the previous administration sequence, not a historical binary.
    discover(old);
    for (const path of sources) success(old, "--observe-timing", "context", "--file", path, "--owner");
    for (const path of sources.slice(1)) success(old, "--observe-timing", "map", "materialize", path, "--feature", "report");
    for (const path of sources) success(old, "--observe-timing", "context", "--file", path, "--owner");

    const digest = json(batch, "steps", "--plan", doc).approval.digest;
    assert.match(digest, /^[a-f0-9]{64}$/);
    success(batch, "--observe-timing", "context", "--paths", sources[0], "--owner");
    discover(batch);
    const discovered = json(batch, "steps", "--plan", doc);
    assert.equal(discovered.approved, true);
    assert.equal(discovered.approval.digest, digest, "advisory routing discovery preserves permission");
    success(batch, "--observe-timing", "context", "--paths", ...sources, "--owner");
    success(batch, "--observe-timing", "map", "materialize", ...sources.slice(1), "--feature", "report");
    const ownership = success(batch, "context", "--paths", ...sources, "--owner");
    for (const path of sources) assert.ok(ownership.includes(`${path}: report`));

    put(batch, "tests/report.test.js", `import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const run = (input) => spawnSync(process.execPath, ["src/report.js", input], { encoding: "utf8" });
test("valid input reaches the actual report", () => {
  const result = run("3"); assert.equal(result.status, 0); assert.equal(result.stdout, "Pieces: 3\\n");
});
test("malformed input fails with the promised diagnostic", () => {
  const result = run("3x"); assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr, /Count must be a positive whole number/);
});
`);
    const test = () => spawnSync(process.execPath, ["--test", "tests/report.test.js"], { cwd: batch, encoding: "utf8", windowsHide: true, env: childEnv() });
    const red = test();
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stdout, /not ok.*valid input/);
    put(batch, sources[2], "export function renderCount(count) { return 'Pieces: ' + count; }\n");
    const green = test();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    const valid = spawnSync(process.execPath, [sources[0], "3"], { cwd: batch, encoding: "utf8", windowsHide: true, env: childEnv() });
    const invalid = spawnSync(process.execPath, [sources[0], "3x"], { cwd: batch, encoding: "utf8", windowsHide: true, env: childEnv() });
    assert.deepEqual([valid.status, valid.stdout], [0, "Pieces: 3\n"]);
    assert.deepEqual([invalid.status, invalid.stdout], [1, ""]);
    assert.match(invalid.stderr, /Count must be a positive whole number/);
    assert.equal(json(batch, "steps", "--plan", doc).approval.digest, digest);

    const completed = readFileSync(join(batch, doc), "utf8").replace("- [ ]", "- [x]");
    // This is a recovery snapshot; the tracked approval remains the authority.
    put(batch, `.codument/pending-plans/${doc}`, completed);
    put(batch, doc, durable);
    git(batch, "add", ".");
    success(batch, "work", "finish", "--repo", ".", "--prepare-final");
    git(batch, "add", "docs/.approvals.json");
    const review = json(batch, "review", "--repo", ".", "--staged");
    assert.deepEqual(review.state.outOfPlan, []);
    assert.equal(review.plan.approvalModel, "outcome-v1");
    assert.ok(review.state.changedSources.includes(sources[1]));
    const required = cli(batch, "verify", "--repo", ".");
    assert.equal(required.status, 1);
    assert.match(required.stdout, /REVIEW REQUIRED/);
    const worksheetPath = ".codument/review-worksheet.json";
    const worksheet = JSON.parse(readFileSync(join(batch, worksheetPath), "utf8"));
    worksheet.invariantsChecked = ["Actual valid/invalid command evidence matches the approved outcome; new helpers are owned; routine report correction has green integration evidence."];
    worksheet.findings = [{ citation: "src/render.js:1", detail: "An extra piece violated the promised report and was repaired.", failingTest: "tests/report.test.js", status: "resolved" }];
    worksheet.signer = "scripted fixture reviewer; host independence is not authenticated";
    put(batch, worksheetPath, JSON.stringify(worksheet));
    success(batch, "verify", "--repo", ".", "--record", worksheetPath);
    assert.equal(json(batch, "work", "finish", "--repo", ".").selected.status, "ready");
    git(batch, "commit", "-qm", "feat: deliver working report");
    assert.equal(json(batch, "work", "finish", "--repo", ".").selected.status, "completed");

    const unbatched = json(old, "cost", "--timing");
    const batched = json(batch, "cost", "--timing");
    // The assertion uses raw ledger records, avoiding dependence on presentation.
    const observations = (root: string) => readFileSync(join(root, ".codument/events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "workflow-command");
    const before = observations(old);
    const after = observations(batch);
    assert.equal(before.length, 8);
    assert.equal(after.length, 3);
    for (const event of [...before, ...after]) {
      assert.ok(Number.isFinite(event.data.durationMs) && event.data.durationMs >= 0);
      assert.equal(event.data.exitCode, 0);
      assert.ok(["context", "map materialize"].includes(event.data.command));
    }
    const sum = (events: ReturnType<typeof observations>) => events.reduce((total, event) => total + event.data.durationMs, 0);
    t.diagnostic(JSON.stringify({
      evidence: "Same-build procedural comparison of ownership grounding and registration only; approval, implementation, tests, review and commit are outside this comparison.",
      unbatched: { commands: before.length, observedActionDurationMs: sum(before), report: unbatched },
      batched: { commands: after.length, observedActionDurationMs: sum(after), report: batched },
      implementationDuration: null,
      limitations: "Action timing excludes startup, host thinking and user waits. Scripted review exercises CLI evidence binding, not autonomous agent behavior or authenticated independence.",
    }));
  } finally {
    rmSync(old, { recursive: true, force: true, maxRetries: 10 });
    rmSync(batch, { recursive: true, force: true, maxRetries: 10 });
  }
});
