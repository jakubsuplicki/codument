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
  put(".gitignore", ".codument/\n");
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
  it("keeps working-tree views available after an unstaged final correction", () => {
    assert.equal(cli("work", "approve", "--plan", path).status, 0);
    git("add", path, "docs/.approvals.json");
    git("commit", "-qm", "approval");
    assert.equal(cli("work", "start", "--plan", path).status, 0);
    put(`.codument/pending-plans/${path}`, readFileSync(join(root, path), "utf8").replace("[ ]", "[x]"));
    put(path, "# Alpha\n\n## In plain terms\nReturns the updated value.\n");
    put("src/alpha.ts", "export const alpha = 2;\n");
    git("add", path, "src/alpha.ts");
    assert.equal(cli("work", "finish", "--prepare-final").status, 0);
    git("add", "docs/.approvals.json");
    put("src/alpha.ts", "export const alpha = 3;\n");
    const review = cli("review", "--json");
    assert.equal(JSON.parse(review.stdout).plan, null, review.stdout + review.stderr);
    for (const args of [["report", "--json"], ["watch", "--once", "--no-feed"]]) {
      const projected = cli(...args);
      assert.equal(projected.status, 0, projected.stdout + projected.stderr);
    }
    const verified = cli("verify");
    assert.equal(verified.status, 1);
    assert.match(verified.stdout + verified.stderr, /working-tree bytes differ/);
  });
  it("compacts one selected plan while preserving sibling plans and their context identity", () => {
    const map =
      "\n### Feature Map\n```feature-map\nsrc/alpha.ts | alpha | feature | return a value\n```\n";
    const first = plan.replace("Status: approved", "Plan-ID: first\nStatus: approved") + map;
    const second = plan.replace("Status: approved", "Plan-ID: second\nStatus: approved") + map;
    put(path, first + "\n" + second);
    for (const id of ["first", "second"])
      assert.equal(cli("work", "approve", "--plan", path, "--plan-id", id).status, 0);
    git("add", path, "docs/.approvals.json");
    git("commit", "-qm", "two approved plans");
    assert.equal(cli("work", "start", "--plan", path, "--plan-id", "first").status, 0);
    assert.equal(cli("work", "pause", "--reason", "Review pending").status, 0);
    const preview = cli("context", "--plan", path, "--plan-id", "second", "--json");
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).work, undefined);
    assert.equal(cli("work", "resume").status, 0);
    put(
      `.codument/pending-plans/${path}`,
      first.replace("- [ ] Implement", "- [x] Implement") + "\n" + second,
    );
    put(path, second);
    git("add", path);
    const prepared = cli("work", "finish", "--prepare-final");
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    git("add", "docs/.approvals.json");
    let verified = cli("verify");
    if (/REVIEW REQUIRED/.test(verified.stdout)) {
      const worksheet = JSON.parse(
        readFileSync(join(root, ".codument/review-worksheet.json"), "utf8"),
      );
      worksheet.invariantsChecked = ["Selected plan completes while its sibling remains unchanged"];
      worksheet.signer = "fixture reviewer";
      put(".codument/review-worksheet.json", JSON.stringify(worksheet));
      verified = cli("verify", "--record", ".codument/review-worksheet.json");
    }
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.equal(cli("work", "finish").status, 0);
    git("commit", "-qm", "complete first plan");
    assert.equal(cli("work", "finish").status, 0);
    assert.equal(cli("work", "start", "--plan", path, "--plan-id", "second").status, 0);
    assert.equal(JSON.parse(cli("steps", "--json").stdout).planId, "second");
  });
  it("routes handoffs through selected state and keeps paused work from starting", () => {
    put(
      path,
      plan +
        "\n### Feature Map\n```feature-map\nsrc/alpha.ts | alpha | feature | return a value\n```\n",
    );
    assert.equal(cli("work", "approve", "--plan", path).status, 0);
    const other = "docs/features/beta.md";
    put(other, plan);
    assert.equal(cli("work", "approve", "--plan", other).status, 0);
    assert.equal(cli("work", "start", "--plan", path).status, 0);
    assert.equal(JSON.parse(cli("steps", "--json").stdout).plan, path);
    assert.equal(cli("work", "pause", "--reason", "Review pending", "--gate", "review").status, 0);
    const paused = JSON.parse(cli("steps", "--json", "--emit").stdout);
    assert.equal(paused.emitted, false);
    assert.equal(paused.work.status, "paused");
    assert.equal(paused.active, null);
    assert.equal(paused.steps[0].status, "pending");
    const context = cli("context", "--json");
    assert.equal(context.status, 0, context.stdout + context.stderr);
    assert.equal(JSON.parse(context.stdout).work.status, "paused");
    assert.equal(cli("map", "route", "src/alpha.ts", "--json").status, 0);
    const report = cli("report", "--json");
    assert.equal(
      JSON.parse(report.stdout).work.selected.status,
      "paused",
      report.stdout + report.stderr,
    );
    assert.match(cli("watch", "--once", "--no-feed").stdout, /paused/);
    assert.equal(
      JSON.parse(cli("steps", "--plan", other, "--json", "--emit").stdout).emitted,
      false,
    );
    assert.match(cli("verify").stdout, /interrupted/);
  });

  it("binds compacted final delivery and verifies it without local recovery state", () => {
    put(
      path,
      plan +
        "\n### Feature Map\n```feature-map\nsrc/alpha.ts | alpha | feature | return a value\n```\n",
    );
    put(".codument-meta.json", '{"requireBoundApproval":true}\n');
    assert.equal(cli("work", "approve", "--plan", path).status, 0);
    git("add", path, "docs/.approvals.json", ".codument-meta.json");
    git("commit", "-qm", "approval");
    const base = git("rev-parse", "HEAD").trim();
    assert.equal(cli("work", "start", "--plan", path).status, 0);
    const approved = readFileSync(join(root, path), "utf8");
    put(path, readFileSync(join(root, path), "utf8").replace("- [ ] Implement", "- [x] Implement"));
    put(`.codument/pending-plans/${path}`, readFileSync(join(root, path), "utf8"));
    put(path, "# Alpha\n\n## In plain terms\nReturns the updated value.\n");
    put("src/alpha.ts", "export const alpha = 2;\n");
    git("add", path, "src/alpha.ts");
    assert.equal(
      cli("work", "pause", "--reason", "Interrupted before final preparation", "--gate", "review")
        .status,
      0,
    );
    const recovery = readFileSync(join(root, `.codument/pending-plans/${path}`), "utf8");
    put(
      `.codument/pending-plans/${path}`,
      recovery.replace("Return the value.", "Change the approved interface."),
    );
    assert.equal(cli("work", "resume", "--plan", path).status, 1);
    put(`.codument/pending-plans/${path}`, recovery);
    const resumed = cli("work", "resume", "--plan", path);
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(cli("context", "--json").status, 0);
    const approvalBefore = readFileSync(join(root, "docs/.approvals.json"), "utf8");
    assert.equal(cli("work", "finish", "--prepare-final", "--expect-revision", "0").status, 1);
    assert.equal(
      cli("work", "finish", "--prepare-final", "--plan", "docs/features/other.md").status,
      1,
    );
    assert.equal(cli("work", "finish", "--prepare-final", "--plan-id", "other").status, 1);
    assert.equal(readFileSync(join(root, "docs/.approvals.json"), "utf8"), approvalBefore);
    const prepared = cli("work", "finish", "--prepare-final");
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    git("add", "docs/.approvals.json");
    assert.equal(cli("work", "pause", "--reason", "Interrupted after final preparation").status, 0);
    const resumedPrepared = cli("work", "resume", "--plan", path);
    assert.equal(resumedPrepared.status, 0, resumedPrepared.stdout + resumedPrepared.stderr);
    for (const args of [
      ["context", "--json"],
      ["report", "--json"],
      ["watch", "--once", "--no-feed"],
    ]) {
      const projected = cli(...args);
      assert.equal(projected.status, 0, projected.stdout + projected.stderr);
    }
    put("src/alpha.ts", "export const alpha = 999;\n");
    git("add", "src/alpha.ts");
    assert.equal(
      cli("verify").status,
      1,
      "a change after final preparation invalidates its binding",
    );
    put("src/alpha.ts", "export const alpha = 2;\n");
    git("add", "src/alpha.ts");
    const verified = cli("verify");
    assert.match(verified.stdout, /REVIEW REQUIRED/, verified.stdout + verified.stderr);
    const worksheet = JSON.parse(
      readFileSync(join(root, ".codument/review-worksheet.json"), "utf8"),
    );
    worksheet.invariantsChecked = [
      "Final delivery retains the approved contract and exact staged changes",
    ];
    worksheet.signer = "fixture reviewer";
    put(".codument/review-worksheet.json", JSON.stringify(worksheet));
    const recorded = cli("verify", "--record", ".codument/review-worksheet.json");
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    const ready = cli("work", "finish", "--json");
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(JSON.parse(ready.stdout).selected.status, "ready");
    assert.equal(JSON.parse(cli("report", "--json").stdout).work.selected.status, "ready");
    git("commit", "-qm", "final delivery");
    assert.equal(JSON.parse(cli("work", "status", "--json").stdout).selected.status, "completed");
    assert.equal(cli("work", "finish").status, 0);
    assert.equal(JSON.parse(cli("report", "--json").stdout).work.selected.status, "completed");
    assert.equal(cli("context", "--json").status, 0);
    rmSync(join(root, ".codument"), { recursive: true, force: true });
    const independent = cli("review", "--base", base, "--json");
    assert.equal(
      JSON.parse(independent.stdout).plan?.approvalDigest,
      JSON.parse(readFileSync(join(root, "docs/.approvals.json"), "utf8")).records[0].digest,
      independent.stdout + independent.stderr,
    );
    const fresh = mkdtempSync(join(tmpdir(), "codument-final-checkout-"));
    try {
      execFileSync("git", ["clone", "--local", root, fresh], { stdio: "pipe" });
      const checked = spawnSync(process.execPath, [CLI, "review", "--base", `${base}^`, "--json"], {
        cwd: fresh,
        encoding: "utf8",
      });
      assert.equal(
        JSON.parse(checked.stdout).plan?.approvalDigest,
        JSON.parse(independent.stdout).plan.approvalDigest,
        checked.stdout + checked.stderr,
      );
      writeFileSync(join(fresh, path), approved);
      const restored = spawnSync(
        process.execPath,
        [CLI, "steps", "--plan", path, "--emit", "--json"],
        { cwd: fresh, encoding: "utf8" },
      );
      assert.equal(JSON.parse(restored.stdout).approved, false, restored.stdout + restored.stderr);
      assert.equal(JSON.parse(restored.stdout).emitted, false);
      assert.equal(
        spawnSync(process.execPath, [CLI, "work", "start", "--plan", path], { cwd: fresh }).status,
        1,
      );
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
    put("src/alpha.ts", "export const alpha = 3;\n");
    git("add", "src/alpha.ts");
    const stale = cli("verify");
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /approved plan|plan selection/);
  });
  it("keeps a verified step ready until its commit is observed, then resumes the next step", () => {
    put(path, plan.replace("- [ ] Implement", "- [ ] Implement\n- [ ] Follow up"));
    assert.equal(cli("work", "approve", "--plan", path).status, 0);
    git("add", path, "docs/.approvals.json");
    git("commit", "-qm", "approval");
    assert.equal(cli("work", "start", "--plan", path).status, 0);
    const revision = JSON.parse(cli("work", "status", "--json").stdout).state.revision;
    assert.equal(
      cli(
        "work",
        "pause",
        "--reason",
        "Break",
        "--gate",
        "review",
        "--expect-revision",
        String(revision),
      ).status,
      0,
    );
    assert.equal(cli("work", "resume").status, 0);
    put(
      path,
      readFileSync(join(root, path), "utf8") + "\n### Resume checkpoint\nVerification pending.\n",
    );
    git("add", path);
    const progressVerification = cli("verify");
    assert.equal(
      progressVerification.status,
      0,
      progressVerification.stdout + progressVerification.stderr,
    );
    put(path, readFileSync(join(root, path), "utf8").replace("- [ ] Implement", "- [x] Implement"));
    const unstagedProgress = cli("work", "finish");
    assert.equal(unstagedProgress.status, 1);
    assert.match(unstagedProgress.stdout + unstagedProgress.stderr, /working-tree bytes differ/);
    assert.doesNotMatch(unstagedProgress.stdout + unstagedProgress.stderr, /at verifiedDelivery/);
    git("add", path);
    const verified = cli("verify");
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    const ready = cli("work", "finish", "--json");
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.equal(JSON.parse(ready.stdout).selected.status, "ready");
    const status = cli("work", "status", "--json");
    assert.equal(JSON.parse(status.stdout).selected.status, "ready");
    git("commit", "-qm", "deliver step");
    put("README.md", "Unrelated later work.\n");
    git("add", "README.md");
    git("commit", "-qm", "later work");
    put(path, readFileSync(join(root, path), "utf8").replace("- [ ] Follow up", "- [x] Follow up"));
    const observed = cli("work", "status", "--json");
    assert.equal(JSON.parse(observed.stdout).selected.status, "active");
    assert.equal(JSON.parse(observed.stdout).selected.step, 2);
    assert.equal(
      JSON.parse(observed.stdout).state.records[0].status,
      "ready",
      "reads do not mutate saved state",
    );
    assert.equal(cli("work", "finish").status, 0);
    assert.equal(
      JSON.parse(cli("work", "status", "--json").stdout).state.records[0].status,
      "active",
    );
  });
  it("requires a new review when the selected approved plan changes on the same staged bytes", () => {
    put(
      path,
      plan.replace("Status: approved", "Plan-ID: first\nStatus: approved") +
        "\n" +
        plan.replace("Status: approved", "Plan-ID: second\nStatus: approved"),
    );
    for (const id of ["first", "second"])
      assert.equal(cli("work", "approve", "--plan", path, "--plan-id", id).status, 0);
    git("add", path, "docs/.approvals.json");
    git("commit", "-qm", "approvals");
    put("src/alpha.ts", "export const alpha = 2;\n");
    put("settings.json", '{"enabled":true}\n');
    put(
      path,
      readFileSync(join(root, path), "utf8") +
        "\n## Design approach\nThe source now returns the updated constant.\n",
    );
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
    for (const selected of [
      join(root, path),
      ...(process.platform === "win32" ? [path.replaceAll("/", "\\")] : []),
    ]) {
      const result = cli("review", "--staged", "--plan", selected, "--json");
      assert.equal(JSON.parse(result.stdout).plan?.plan, path, result.stdout + result.stderr);
    }
    const missing = cli("review", "--staged", "--plan", "docs/features/missing.md", "--json");
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /selected plan.*not found|unresolved explicit plan/);
  });
  it("diagnoses a malformed map in the explicitly selected section", () => {
    const first = plan.replace("Status: approved", "Plan-ID: first\nStatus: approved");
    const second =
      plan.replace("Status: approved", "Plan-ID: second\nStatus: approved") +
      "\n### Feature Map\n| source | owner |\n| src/alpha.ts | alpha |\n";
    put(path, first + "\n" + second);
    const result = cli("map", "check", "--plan", path, "--plan-id", "second", "--json");
    assert.equal(JSON.parse(result.stdout).malformedMap, true);
    assert.equal(JSON.parse(result.stdout).hasMap, false);
    for (const id of ["first", "second"])
      assert.equal(cli("work", "approve", "--plan", path, "--plan-id", id).status, 0);
    assert.equal(cli("work", "start", "--plan", path, "--plan-id", "second").status, 0);
    const selected = cli("map", "check", "--json");
    assert.equal(JSON.parse(selected.stdout).malformedMap, true, selected.stdout + selected.stderr);
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
