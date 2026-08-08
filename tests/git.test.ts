import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRootIsRepoToplevel,
  getWorkingTreeChanges,
  getWorkingTreeDeletions,
  getWorkingTreeRenames,
  listIgnoredPaths,
  listTrackedFiles,
  movesOnly,
  NOT_A_REPO,
  forgetWorkspace,
  repoFor,
  resolveWorkspace,
} from "../src/lib/git.js";
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
  // The workspace shape is memoized per root for the life of a process; a suite
  // that rebuilds fixtures at the same path must not inherit the previous shape.
  forgetWorkspace();
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

describe("path listings distinguish 'could not determine' from 'determined: none'", () => {
  // The conflation this pins out of existence: before typing these results, a
  // non-repo root and a repo that genuinely ignores nothing both answered `[]`.
  // The first produced a coverage denominator full of build output reported as
  // 100% covered; the second is a correct empty answer. They are now different
  // values, and no caller can read one as the other by accident.

  it("listIgnoredPaths reports ok:false with a reason outside a repo", () => {
    const listing = listIgnoredPaths(tmp);
    assert.equal(listing.ok, false);
    assert.equal(listing.ok === false && listing.reason, NOT_A_REPO);
  });

  it("listTrackedFiles reports ok:false with a reason outside a repo", () => {
    const listing = listTrackedFiles(tmp);
    assert.equal(listing.ok, false);
    assert.equal(listing.ok === false && listing.reason, NOT_A_REPO);
  });

  it("a repo that ignores nothing reports ok:true with an empty list", () => {
    // The other side of the distinction: an empty answer is still an ANSWER.
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    const listing = listIgnoredPaths(tmp);
    assert.equal(listing.ok, true);
    assert.deepStrictEqual(listing.ok && listing.paths, []);
  });

  it("both listings report ok:false naming the git failure when git is broken", () => {
    // isGitRepo passes (the fake answers --is-inside-work-tree) but the listing
    // subcommand fails: an unreadable repo must not read as a clean empty scope.
    const orig = process.env.PATH;
    process.env.PATH = `${fakeBin}:${orig ?? ""}`;
    try {
      for (const listing of [listIgnoredPaths(tmp), listTrackedFiles(tmp)]) {
        assert.equal(listing.ok, false);
        assert.match(listing.ok === false ? listing.reason : "", /^git failed: /);
      }
    } finally {
      process.env.PATH = orig;
    }
  });
});

// Plan 41: a rename is neither a bare add nor a bare delete. The destination
// already travelled as a change; the ORIGIN travelled nowhere, which is how a
// `git mv` left the registry pointing at a vanished path with nothing to notice.
describe("renames are reported as pairs, not as a bare add", () => {
  async function repoWith(files: Record<string, string>): Promise<void> {
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "T"], { cwd: tmp });
    for (const [p, c] of Object.entries(files)) {
      await mkdir(dirname(join(tmp, p)), { recursive: true });
      await writeFile(join(tmp, p), c);
    }
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: tmp });
  }

  it("a git mv yields the pair, and neither a deletion nor a dropped origin", async () => {
    await repoWith({ "a.ts": "export const a = 1;\n" });
    execFileSync("git", ["mv", "a.ts", "b.ts"], { cwd: tmp });

    assert.deepEqual(getWorkingTreeRenames(tmp), [{ from: "a.ts", to: "b.ts" }]);
    // The destination still counts as a change (unchanged behavior)…
    assert.ok(getWorkingTreeChanges(tmp).includes("b.ts"));
    // …and a rename is still NOT a deletion, so the deletion wake does not fire.
    assert.deepEqual(getWorkingTreeDeletions(tmp), []);
  });

  it("a plain deletion is not a rename, and a plain edit is neither", async () => {
    await repoWith({ "a.ts": "export const a = 1;\n", "keep.ts": "export const k = 1;\n" });
    execFileSync("git", ["rm", "-q", "a.ts"], { cwd: tmp });
    assert.deepEqual(getWorkingTreeRenames(tmp), []);
    assert.deepEqual(getWorkingTreeDeletions(tmp), ["a.ts"]);
  });

  it("a COPY is not a move, even with git's copy detection turned on", async () => {
    // `status.renames copies` is a supported setting, and under it git reports `C`
    // with an origin path exactly like a rename. Reading that as a move says a
    // file still sitting on disk was removed, and makes the copy's base content
    // the ORIGINAL's — laundering an entirely new file's contract as unchanged.
    const body = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
    await repoWith({ "a.ts": body });
    execFileSync("git", ["config", "status.renames", "copies"], { cwd: tmp });
    await writeFile(join(tmp, "copy.ts"), body);
    // git only considers MODIFIED files as copy sources, so the original has to
    // move for the copy to be detected at all — which is also the realistic shape:
    // you copy a file and then edit one of the two.
    await writeFile(join(tmp, "a.ts"), `${body}export const d = 4;\n`);
    execFileSync("git", ["add", "-A"], { cwd: tmp });

    // Guard the fixture: prove git really did classify it as a copy, so this test
    // fails loudly if a future git stops emitting `C` rather than passing vacuously.
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.ok(/^C/m.test(porcelain), `expected a copy entry, got:\n${porcelain}`);
    assert.deepEqual(getWorkingTreeRenames(tmp), []);
  });

  it("movesOnly drops a pair whose origin is still present — the file-split refactor", () => {
    // `git mv a b` then re-create `a` as a re-export shim: git reports the rename
    // AND an untracked `a`. Judged as a move it demands the registry stop naming a
    // path that exists, which nothing can satisfy — dropping the entry only makes
    // the shim unmapped.
    const pairs = [
      { from: "src/format.ts", to: "src/dateFormat.ts" },
      { from: "src/gone.ts", to: "src/moved.ts" },
    ];
    assert.deepEqual(movesOnly(pairs, new Set(["src/format.ts", "src/dateFormat.ts"])), [
      { from: "src/gone.ts", to: "src/moved.ts" },
    ]);
    // A genuine move survives untouched: only the destination is in the change set.
    assert.deepEqual(movesOnly(pairs, new Set(["src/dateFormat.ts", "src/moved.ts"])), pairs);
  });

  it("a path with spaces and non-ASCII survives the pair intact", async () => {
    // NUL framing is what makes this work; a quoted/escaped path would arrive
    // mangled and silently fail to match any registry entry — the same hazard the
    // change listing already guards, now on the origin half too.
    await repoWith({ "src/föo bar.ts": "export const a = 1;\n" });
    execFileSync("git", ["mv", "src/föo bar.ts", "src/bäz qux.ts"], { cwd: tmp });
    assert.deepEqual(getWorkingTreeRenames(tmp), [
      { from: "src/föo bar.ts", to: "src/bäz qux.ts" },
    ]);
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

describe("workspace discovery sees the repositories nested inside a tree", () => {
  const g = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

  const makeRepo = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    g(dir, ["init", "-q"]);
    await writeFile(join(dir, "seed.txt"), "seed\n");
    g(dir, ["add", "-A"]);
    g(dir, ["commit", "-m", "init"]);
  };

  const prefixes = (root: string): string[] => {
    forgetWorkspace();
    return resolveWorkspace(root).members.map((m) => m.prefix);
  };

  it("finds both members of a non-repo root (the field shape)", async () => {
    await makeRepo(join(tmp, "applications-service"));
    await makeRepo(join(tmp, "apply-exp"));
    forgetWorkspace();
    const ws = resolveWorkspace(tmp);
    assert.deepEqual(ws.members.map((m) => m.prefix), ["applications-service", "apply-exp"]);
    assert.equal(ws.isWorkspace, true);
  });

  it("treats a plain repository at the root as NOT a workspace", async () => {
    await makeRepo(tmp);
    forgetWorkspace();
    const ws = resolveWorkspace(tmp);
    assert.deepEqual(ws.members.map((m) => m.prefix), [""]);
    assert.equal(
      ws.isWorkspace,
      false,
      "a single-repo root must keep taking the pre-workspace path",
    );
  });

  it("includes the root repo alongside a member embedded in it", async () => {
    await makeRepo(tmp);
    await makeRepo(join(tmp, "child"));
    forgetWorkspace();
    const ws = resolveWorkspace(tmp);
    assert.deepEqual(ws.members.map((m) => m.prefix), ["", "child"]);
    assert.equal(ws.isWorkspace, true);
  });

  it("finds a submodule of a super-repo (the same opacity, a different cause)", async () => {
    const upstream = join(tmp, "upstream");
    await makeRepo(upstream);
    const superRepo = join(tmp, "super");
    await makeRepo(superRepo);
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "vendor/lib"],
      { cwd: superRepo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } },
    );
    forgetWorkspace();
    const ws = resolveWorkspace(superRepo);
    assert.ok(ws.members.some((m) => m.prefix === "vendor/lib"), prefixes(superRepo).join(","));
    assert.equal(ws.isWorkspace, true);
  });

  it("names an uninitialized gitlink instead of inventing its contents", async () => {
    await makeRepo(tmp);
    await mkdir(join(tmp, "vendor"), { recursive: true });
    // A gitlink whose work tree was never checked out: the .git file exists,
    // the repository behind it does not.
    await writeFile(join(tmp, "vendor", ".git"), "gitdir: ../.git/modules/vendor\n");
    forgetWorkspace();
    const ws = resolveWorkspace(tmp);
    assert.deepEqual(ws.uninitialized, ["vendor"]);
    assert.ok(!ws.members.some((m) => m.prefix === "vendor"), "never a member");
  });

  it("does not descend into excluded directories", async () => {
    await makeRepo(join(tmp, "node_modules", "some-dep"));
    await makeRepo(join(tmp, "real"));
    forgetWorkspace();
    const ws = resolveWorkspace(tmp, ["node_modules"]);
    assert.deepEqual(ws.members.map((m) => m.prefix), ["real"]);
  });

  it("is deterministic and sorted regardless of filesystem order", async () => {
    await makeRepo(join(tmp, "zeta"));
    await makeRepo(join(tmp, "alpha"));
    await makeRepo(join(tmp, "mid"));
    assert.deepEqual(prefixes(tmp), ["alpha", "mid", "zeta"]);
    forgetWorkspace();
    const first = resolveWorkspace(tmp);
    forgetWorkspace();
    assert.deepEqual(resolveWorkspace(tmp), first);
  });

  it("finds nothing in a tree with no repositories at all", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    forgetWorkspace();
    const ws = resolveWorkspace(tmp);
    assert.deepEqual(ws.members, []);
    assert.equal(ws.isWorkspace, false);
  });

  // The third walker. A member repository can hide under a directory the process
  // cannot open, and a short member list presented as the whole workspace takes
  // the aggregated ignore rules down with it.
  it("reports a subtree it could not read instead of dropping it silently", async () => {
    const probe = await mkdtemp(join(tmpdir(), "codument-perm-probe-"));
    let enforced = true;
    try {
      await chmod(probe, 0o000);
      readdirSync(probe);
      enforced = false;
    } catch {
      /* permission bits are enforced */
    } finally {
      await chmod(probe, 0o755).catch(() => {});
      await rm(probe, { recursive: true, force: true });
    }
    if (!enforced) return;

    await makeRepo(tmp);
    const locked = join(tmp, "packages");
    await mkdir(locked, { recursive: true });
    await makeRepo(join(locked, "hidden-member"));
    try {
      await chmod(locked, 0o000);
      forgetWorkspace();
      const ws = resolveWorkspace(tmp);
      assert.deepEqual(ws.unreadable, ["packages"], "the subtree is NAMED");
      assert.ok(
        !ws.members.some((m) => m.prefix.startsWith("packages")),
        "and contributes no fabricated member",
      );
    } finally {
      await chmod(locked, 0o755).catch(() => {});
      forgetWorkspace();
    }
  });

  it("reports nothing unreadable in an ordinary tree", async () => {
    await makeRepo(tmp);
    await makeRepo(join(tmp, "child"));
    forgetWorkspace();
    assert.deepEqual(resolveWorkspace(tmp).unreadable, []);
  });

  it("drops a not-yet-added member gitlink even with git's trailing slash", async () => {
    // Before the outer repo `git add`s the embedded repo, `git status` reports
    // it as `?? child/` WITH a trailing slash. The gitlink drop must normalize
    // that off, or the extension-less placeholder leaks into the change set.
    await makeRepo(tmp);
    await makeRepo(join(tmp, "child"));
    // A change inside the member, and the member itself not yet added to root.
    await writeFile(join(tmp, "child", "seed.txt"), "changed\n");
    forgetWorkspace();
    const changes = getWorkingTreeChanges(tmp);
    assert.ok(
      !changes.includes("child") && !changes.includes("child/"),
      `gitlink placeholder leaked: ${changes.join(", ")}`,
    );
    assert.ok(
      changes.includes("child/seed.txt"),
      `member's own change should be present: ${changes.join(", ")}`,
    );
  });
});

describe("repoFor routes a workspace path to the member that owns it", () => {
  const ws = (members: Array<[string, string]>, uninitialized: string[] = []) => ({
    root: "/ws",
    members: members.map(([prefix, root]) => ({ prefix, root })),
    uninitialized,
    isWorkspace: true,
  });

  it("routes into the owning member and rewrites the path", () => {
    const w = ws([["applications-service", "/ws/applications-service"]]);
    const hit = repoFor(w, "applications-service/src/app.py");
    assert.equal(hit?.member.prefix, "applications-service");
    assert.equal(hit?.relPath, "src/app.py");
  });

  it("prefers the deepest member, so a submodule beats its container", () => {
    const w = ws([
      ["", "/ws"],
      ["vendor/lib", "/ws/vendor/lib"],
    ]);
    const hit = repoFor(w, "vendor/lib/src/x.ts");
    assert.equal(hit?.member.prefix, "vendor/lib");
    assert.equal(hit?.relPath, "src/x.ts");
  });

  it("falls back to a root repository for a path no member claims", () => {
    const w = ws([
      ["", "/ws"],
      ["child", "/ws/child"],
    ]);
    const hit = repoFor(w, "src/top.ts");
    assert.equal(hit?.member.prefix, "");
    assert.equal(hit?.relPath, "src/top.ts");
  });

  it("returns null when nothing owns the path (a non-repo workspace root)", () => {
    const w = ws([["child", "/ws/child"]]);
    assert.equal(repoFor(w, "loose/file.ts"), null);
  });

  it("does not let a prefix match a merely similar sibling name", () => {
    const w = ws([["app", "/ws/app"]]);
    assert.equal(repoFor(w, "apply-exp/src/x.ts"), null, "app must not claim apply-exp");
    assert.equal(repoFor(w, "app/src/x.ts")?.member.prefix, "app");
  });

  it("routes the member's own directory entry to the member", () => {
    const w = ws([["child", "/ws/child"]]);
    const hit = repoFor(w, "child");
    assert.equal(hit?.member.prefix, "child");
    assert.equal(hit?.relPath, "");
  });
});
