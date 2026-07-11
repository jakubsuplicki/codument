import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

let tmp: string;

function run(cwd: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8" as const,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryCommit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): { ok: boolean; output: string } {
  const res = spawnSync("git", ["commit", ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", NO_COLOR: "1", ...env },
  });
  return { ok: res.status === 0, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** A codument-gated repo: baseline commit, empty registry, local CLI shim. */
function seedRepo(root: string): void {
  run(root, "git", ["init"]);
  run(root, "git", ["config", "user.email", "test@example.com"]);
  run(root, "git", ["config", "user.name", "Test"]);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }, null, 2));
  writeFileSync(join(root, "README.md"), "# fixture\n");
  // Project-local binary: the hook's preferred resolution. Absolute node path so
  // the shim does not depend on the hook environment's PATH.
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "codument");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(shim, 0o755);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  run(root, "git", ["add", "-A"]);
  run(root, "git", ["commit", "-m", "baseline"]);
  run(root, "node", [CLI, "hooks", "install"]);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-hookscmd-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("hooks command: end-to-end enforcement", { skip: process.platform === "win32" }, () => {
  it("a red strict gate blocks a real git commit; both escapes pass it", () => {
    seedRepo(tmp);
    // An unmapped new source: exactly the state --strict exists to catch.
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "orphan.ts"), "export const x = 1;\n");
    run(tmp, "git", ["add", "-A"]);

    const blocked = tryCommit(tmp, ["-m", "should be blocked"]);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.output.includes("commit blocked by a red strict gate"));
    assert.ok(blocked.output.includes("--no-verify"));

    const skipped = tryCommit(tmp, ["-m", "skip via env"], { CODUMENT_SKIP_GATE: "1" });
    assert.equal(skipped.ok, true);

    writeFileSync(join(tmp, "src", "orphan2.ts"), "export const y = 2;\n");
    run(tmp, "git", ["add", "-A"]);
    const noVerify = tryCommit(tmp, ["--no-verify", "-m", "skip via flag"]);
    assert.equal(noVerify.ok, true);
  });

  it("a green gate lets the commit through with the hook active", () => {
    seedRepo(tmp);
    writeFileSync(join(tmp, "README.md"), "# fixture\nchanged prose\n");
    run(tmp, "git", ["add", "-A"]);
    const committed = tryCommit(tmp, ["-m", "docs-only change"]);
    assert.equal(committed.ok, true);
  });

  it("a missing binary warns loudly and lets the commit pass", () => {
    seedRepo(tmp);
    rmSync(join(tmp, "node_modules"), { recursive: true, force: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "orphan.ts"), "export const x = 1;\n");
    run(tmp, "git", ["add", "-A"]);
    // A PATH with git and sh but no codument and no node.
    const committed = tryCommit(tmp, ["-m", "gate cannot run"], { PATH: "/usr/bin:/bin" });
    assert.equal(committed.ok, true);
    assert.ok(committed.output.includes("gate NOT run"));
  });

  it("status and uninstall round-trip through the CLI", () => {
    seedRepo(tmp);
    const installed = run(tmp, "node", [CLI, "hooks", "status"]);
    assert.ok(installed.includes("installed"));
    const removed = run(tmp, "node", [CLI, "hooks", "uninstall"]);
    assert.ok(removed.includes("removed"));
    const absent = run(tmp, "node", [CLI, "hooks", "status"]);
    assert.ok(absent.includes("not installed"));
  });

  it("install refuses to run from a repo subdirectory (wrong gate root)", () => {
    seedRepo(tmp);
    run(tmp, "node", [CLI, "hooks", "uninstall"]);
    const sub = join(tmp, "docs");
    assert.throws(() => run(sub, "node", [CLI, "hooks", "install"]));
  });

  it("init --hooks installs the gate; init without the flag does not", () => {
    seedRepo(tmp);
    run(tmp, "node", [CLI, "hooks", "uninstall"]);
    run(tmp, "node", [CLI, "init", "--agents", "claude"]);
    let status = run(tmp, "node", [CLI, "hooks", "status"]);
    assert.ok(status.includes("not installed"));
    run(tmp, "node", [CLI, "init", "--agents", "claude", "--hooks"]);
    status = run(tmp, "node", [CLI, "hooks", "status"]);
    assert.ok(status.includes("installed"));
  });
});
