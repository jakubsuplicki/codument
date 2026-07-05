import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { assertRootIsRepoToplevel, getWorkingTreeChanges } from "../src/lib/git.js";
import { GateError } from "../src/lib/two-ref.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

// A stand-in `git` that answers `rev-parse --is-inside-work-tree` (so isGitRepo
// passes) but fails every other subcommand — the "git is broken / oversized
// output" condition. Prepending its directory to PATH shadows the real binary.
const FAKE_GIT = `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--is-inside-work-tree" ]; then echo true; exit 0; fi
done
exit 3
`;

let tmp: string;
let fakeBin: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-git-"));
  fakeBin = await mkdtemp(join(tmpdir(), "codument-fakegit-"));
  await writeFile(join(fakeBin, "git"), FAKE_GIT);
  await chmod(join(fakeBin, "git"), 0o755);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
});

describe("git change-listing fails closed", () => {
  it("getWorkingTreeChanges throws GateError, never [], when git fails", () => {
    const orig = process.env.PATH;
    process.env.PATH = `${fakeBin}:${orig ?? ""}`;
    try {
      assert.throws(
        () => getWorkingTreeChanges(tmp),
        (err: unknown) =>
          err instanceof GateError && err.kind === "git-failed",
      );
    } finally {
      process.env.PATH = orig;
    }
  });

  it("assertRootIsRepoToplevel maps an unresolvable toplevel to GateError(git-failed)", () => {
    // Inside a work tree per the fake git, but --show-toplevel fails: the
    // assertion must fail closed, not silently pass an unverifiable root.
    const orig = process.env.PATH;
    process.env.PATH = `${fakeBin}:${orig ?? ""}`;
    try {
      assert.throws(
        () => assertRootIsRepoToplevel(tmp),
        (err: unknown) => err instanceof GateError && err.kind === "git-failed",
      );
    } finally {
      process.env.PATH = orig;
    }
  });

  it("review --strict surfaces a broken git as 'gate could not run', never 'Working tree clean'", () => {
    let status = 0;
    let stdout = "";
    try {
      execFileSync("node", [CLI, "review", "--strict"], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    assert.equal(status, 1, "fails closed");
    assert.match(stdout, /gate could not run/);
    assert.doesNotMatch(stdout, /Working tree clean/);
  });
});

describe("assertRootIsRepoToplevel (real git repo)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "codument-toplevel-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    await mkdir(join(repo, "packages", "app"), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("accepts the toplevel even through a symlinked spelling", () => {
    // macOS mkdtemp returns the /var/folders symlink while git reports the
    // kernel-canonical /private/var path — the identities must compare equal,
    // never falsely refuse the actual toplevel. (On hosts without the symlink
    // the two spellings coincide, which still pins the pass-path.)
    assert.doesNotThrow(() => assertRootIsRepoToplevel(repo));
  });

  it("refuses a subdirectory with GateError(wrong-root) naming both canonical paths", () => {
    const sub = join(repo, "packages", "app");
    assert.throws(
      () => assertRootIsRepoToplevel(sub),
      (err: unknown) => {
        if (!(err instanceof GateError) || err.kind !== "wrong-root") return false;
        // The message must name BOTH paths (the plan's acceptance criterion):
        // the offending root and the toplevel to run from instead.
        const top = realpathSync.native(repo);
        assert.ok(err.message.includes(sub), "names the offending root");
        assert.ok(err.message.includes(top), "names the toplevel to run from");
        return true;
      },
    );
  });

  it("is silent for a non-git directory (each command keeps its own handling)", async () => {
    const plain = await mkdtemp(join(tmpdir(), "codument-nongit-"));
    try {
      assert.doesNotThrow(() => assertRootIsRepoToplevel(plain));
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
