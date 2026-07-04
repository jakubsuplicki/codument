import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getWorkingTreeChanges } from "../src/lib/git.js";
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
