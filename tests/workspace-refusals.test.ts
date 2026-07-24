import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

// What codument cannot honestly answer over a workspace it refuses BY NAME rather
// than guessing (ADR-016). A ref names one repository; a workspace state is the
// tuple of its members' heads. Each refusal has a pinned exit code and, on --json,
// a machine-readable discriminant — a CI job must be able to tell "refused this
// topology" from "ran and passed".

const gitEnv = {
  ...process.env,
  NO_COLOR: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const g = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "ignore", env: gitEnv });

interface RunResult {
  status: number;
  stdout: string;
}
const run = (cwd: string, args: string[]): RunResult => {
  try {
    return { status: 0, stdout: execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8", env: gitEnv }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "" };
  }
};

let tmp: string;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

// A root repository with an embedded member repo — a workspace whose root IS a
// repo, so the commands reach the workspace check rather than the non-repo guard.
const rootWithMember = async (): Promise<string> => {
  tmp = await mkdtemp(join(tmpdir(), "codument-ws-refuse-"));
  await mkdir(join(tmp, "child", "src"), { recursive: true });
  await mkdir(join(tmp, "docs"), { recursive: true });
  await writeFile(join(tmp, "child", "src", "app.ts"), "export const x = 1;\n");
  await writeFile(join(tmp, "docs", ".registry.json"), JSON.stringify({ features: {} }));
  g(join(tmp, "child"), ["init", "-q"]);
  g(join(tmp, "child"), ["add", "-A"]);
  g(join(tmp, "child"), ["commit", "-m", "init"]);
  g(tmp, ["init", "-q"]);
  g(tmp, ["add", "-A"]);
  g(tmp, ["commit", "-m", "init"]);
  g(tmp, ["commit", "--allow-empty", "-m", "second"]);
  return tmp;
};

describe("a workspace refuses what a single ref cannot name", () => {
  it("refuses ref-ranged review, with a machine discriminant", async () => {
    const root = await rootWithMember();
    const human = run(root, ["review", "--base", "HEAD~1"]);
    assert.equal(human.status, 1, "ref-ranged review must fail closed in a workspace");
    assert.match(human.stdout, /workspace of member repositories/);
    assert.match(human.stdout, /inside the member repository/);

    const json = run(root, ["review", "--base", "HEAD~1", "--json"]);
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.gate, "unavailable");
    assert.equal(parsed.kind, "wrong-topology", "CI must tell topology-refused from passed");
  });

  it("still answers the WORKTREE gate in the same workspace (only ref-ranged is refused)", async () => {
    const root = await rootWithMember();
    // No --base: the working-tree gate runs and is green (nothing changed).
    const bare = run(root, ["review"]);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /member repositories/);
  });

  it("doctor names the workspace and exposes members in --json", async () => {
    const root = await rootWithMember();
    const human = run(root, ["doctor"]);
    assert.match(human.stdout, /workspace: \d+ member repositories/);
    const json = run(root, ["doctor", "--json"]);
    const parsed = JSON.parse(json.stdout);
    assert.ok(Array.isArray(parsed.scope.members), "scope.members is a workspace field");
    assert.ok(parsed.scope.members.includes("child"));
  });

  it("refuses a history audit range", async () => {
    const root = await rootWithMember();
    const res = run(root, ["audit", "HEAD~1..HEAD"]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /workspace of member repositories/);
    assert.match(res.stdout, /inside the member repository/);
  });

  it("refuses a pre-commit hook install at the workspace root", async () => {
    const root = await rootWithMember();
    const res = run(root, ["hooks", "install"]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /workspace of member repositories/);
    assert.match(res.stdout, /Install the pre-commit gate inside the member/);
  });

  // The silent-false-negative the refusal sweep initially missed: ack --base
  // resolves a base sha from the OUTER repo, which no member knows, so a symbol
  // that truly moved reads as "nothing to ack" and exits 1 with a misleading
  // message. Refuse by name instead, before resolveBase.
  it("refuses a --base ack rather than silently finding nothing", async () => {
    const root = await rootWithMember();
    for (const args of [
      ["ack", "child/src/app.ts::hello", "--base", "HEAD~1", "--reason", "x"],
      ["ack", "child/src/app.ts", "--base", "HEAD~1", "--reason", "x"],
    ]) {
      // ack writes to stderr, not stdout — capture combined via a failing run.
      let combined = "";
      let status = 0;
      try {
        execFileSync("node", [CLI, ...args], { cwd: root, encoding: "utf-8", env: gitEnv, stdio: "pipe" });
      } catch (err) {
        const e = err as { status?: number; stderr?: string; stdout?: string };
        status = e.status ?? 1;
        combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      assert.equal(status, 1, `${args.join(" ")} must refuse`);
      assert.match(combined, /workspace of member repositories/);
      assert.match(combined, /inside the member repository/);
    }
  });

  // A worktree ack (no --base) routes HEAD per member and must still work.
  it("allows a worktree-grain ack inside a workspace (only --base is refused)", async () => {
    const root = await rootWithMember();
    // Change an owned symbol in the member so there IS something to ack.
    await writeFile(join(root, "child", "src", "app.ts"), "export const x = 2;\n");
    let combined = "";
    let status = 0;
    try {
      combined = execFileSync(
        "node",
        [CLI, "ack", "child/src/app.ts", "--reason", "internal bump"],
        { cwd: root, encoding: "utf-8", env: gitEnv, stdio: "pipe" },
      );
    } catch (err) {
      const e = err as { status?: number; stderr?: string; stdout?: string };
      status = e.status ?? 1;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    // Either it acked, or it honestly reported no moved symbol — never the
    // wrong-topology refusal, which would mean the worktree path was blocked.
    assert.doesNotMatch(combined, /workspace of member repositories/);
  });
});
