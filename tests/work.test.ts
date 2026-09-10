import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const path = "docs/features/alpha.md";
const plan =
  "## Delivery Plan\nStatus: approved\n\n- [ ] Implement\n\n### Scope\n- `src/alpha.ts`\n\n### Outcome\nReturn the value.\n";
let root: string;
const put = (file: string, content: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codument-work-"));
  put(path, plan);
  put("src/alpha.ts", "export const alpha = 1;\n");
  put(
    "docs/.registry.json",
    JSON.stringify({
      features: {
        alpha: {
          doc: path,
          type: "feature",
          primary_sources: ["src/alpha.ts"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current",
        },
      },
    }),
  );
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("add", ".");
  git("commit", "-qm", "baseline");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("work approval CLI", () => {
  it("requires a new review when the selected approved plan changes on the same staged bytes", () => {
    put(path, plan.replace("Status: approved", "Plan-ID: first\nStatus: approved") + "\n" + plan.replace("Status: approved", "Plan-ID: second\nStatus: approved"));
    for (const id of ["first", "second"]) assert.equal(cli("work", "approve", "--plan", path, "--plan-id", id).status, 0);
    git("add", path, "docs/.approvals.json"); git("commit", "-qm", "approvals");
    put("src/alpha.ts", "export const alpha = 2;\n");
    put("settings.json", '{"enabled":true}\n');
    put(path, readFileSync(join(root, path), "utf8") + "\n## Design approach\nThe source now returns the updated constant.\n");
    git("add", "src/alpha.ts", "settings.json", path);
    const prepare = cli("verify", "--plan", path, "--plan-id", "first");
    assert.match(prepare.stdout, /REVIEW REQUIRED/);
    const worksheetPath = ".codument/review-worksheet.json";
    const worksheet = JSON.parse(readFileSync(join(root, worksheetPath), "utf8"));
    worksheet.invariantsChecked = ["Selected approval and source contract inspected"];
    worksheet.signer = "independent fixture reviewer";
    put(worksheetPath, JSON.stringify(worksheet));
    const first = cli("verify", "--plan", path, "--plan-id", "first", "--record", worksheetPath);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const second = cli("verify", "--plan", path, "--plan-id", "second");
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.match(second.stdout, /REVIEW REQUIRED/);
  });

  it("normalizes explicit plan paths and refuses an unresolved selection", () => {
    assert.equal(cli("work", "approve", "--plan", path).status, 0);
    git("add", path, "docs/.approvals.json");
    for (const selected of [join(root, path), ...(process.platform === "win32" ? [path.replaceAll("/", "\\")] : [])]) {
      const result = cli("review", "--staged", "--plan", selected, "--json");
      assert.equal(JSON.parse(result.stdout).plan?.plan, path, result.stdout + result.stderr);
    }
    const missing = cli("review", "--staged", "--plan", "docs/features/missing.md", "--json");
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /selected plan.*not found|unresolved explicit plan/);
  });
  it("diagnoses a malformed map in the explicitly selected section", () => {
    const first = plan.replace("Status: approved", "Plan-ID: first\nStatus: approved");
    const second = plan.replace("Status: approved", "Plan-ID: second\nStatus: approved") + "\n### Feature Map\n| source | owner |\n| src/alpha.ts | alpha |\n";
    put(path, first + "\n" + second);
    const result = cli("map", "check", "--plan", path, "--plan-id", "second", "--json");
    assert.equal(JSON.parse(result.stdout).malformedMap, true);
    assert.equal(JSON.parse(result.stdout).hasMap, false);
  });
  it("records explicit approval and makes stale plans visible without emitting execution", () => {
    const recorded = cli("work", "approve", "--plan", path, "--json");
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    const id = JSON.parse(recorded.stdout).planId;
    const bound = cli("steps", "--plan", path, "--plan-id", id, "--json");
    assert.equal(JSON.parse(bound.stdout).approval.state, "bound");
    put(path, readFileSync(join(root, path), "utf8").replace("Implement", "Change the interface"));
    const stale = cli("steps", "--plan", path, "--emit", "--json");
    assert.equal(JSON.parse(stale.stdout).approved, false);
    assert.equal(JSON.parse(stale.stdout).emitted, false);
    const discovery = cli("steps");
    assert.equal(discovery.status, 1);
    assert.match(discovery.stdout, /scope changed/i);
  });

  it("reads only staged approval and rejects a missing active plan under bound policy", () => {
    put(".codument-meta.json", JSON.stringify({ requireBoundApproval: true }));
    put("src/alpha.ts", "export const alpha = 2;\n");
    git("add", ".codument-meta.json", "src/alpha.ts");
    assert.equal(cli("work", "approve", "--plan", path).status, 0);
    const unbound = cli("verify", "--json");
    assert.equal(unbound.status, 1);
    assert.match(unbound.stdout, /unbound|revision-bound/);
    git("add", path, "docs/.approvals.json");
    const bound = cli("review", "--staged", "--json");
    assert.equal(JSON.parse(bound.stdout).gate, "ok", bound.stdout + bound.stderr);
    put(path, "# Durable knowledge\n");
    git("add", path);
    const missing = cli("verify", "--json");
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /requires a revision-bound approved plan/);
  });

  it("does not refresh a stale staged approval from an unstaged rerecording", () => {
    assert.equal(cli("work", "approve", "--plan", path).status, 0);
    git("add", path, "docs/.approvals.json");
    git("commit", "-qm", "approve");
    put(
      path,
      readFileSync(join(root, path), "utf8").replace(
        "Return the value.",
        "Change the returned value.",
      ),
    );
    put("src/alpha.ts", "export const alpha = 2;\n");
    git("add", path, "src/alpha.ts");
    assert.equal(cli("work", "approve", "--plan", path).status, 0);
    const stale = cli("verify", "--json");
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /scope changed/);
  });
});
