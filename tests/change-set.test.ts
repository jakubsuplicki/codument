import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ChangeSetError,
  changeSetBinding,
  parseVerificationReceipt,
  resolveChangeSet,
  verificationReceiptCovers,
} from "../src/lib/change-set.js";
import { forgetWorkspace } from "../src/lib/git.js";

let repo: string;

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), content);
}

async function commitAll(message = "fixture"): Promise<void> {
  git(["add", "-A"]);
  git(["commit", "-qm", message]);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "codument-change-set-"));
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await put("src/a.ts", "export const a = 1;\n");
  await put("src/delete.ts", "export const gone = true;\n");
  await put("src/old.ts", "export const old = 1;\n");
  await commitAll("initial");
});

afterEach(async () => {
  forgetWorkspace();
  await rm(repo, { recursive: true, force: true });
});

describe("resolveChangeSet", () => {
  it("accepts a receipt only for the exact boundary and codument version", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    git(["add", "src/a.ts"]);
    const boundary = changeSetBinding(resolveChangeSet(repo, { mode: "staged" }));
    const receipt = parseVerificationReceipt({
      version: 1,
      codumentVersion: "1.2.3",
      boundary,
    });

    assert.ok(receipt);
    assert.equal(verificationReceiptCovers(receipt, boundary, "1.2.3"), true);
    assert.equal(
      verificationReceiptCovers(
        receipt,
        changeSetBinding(resolveChangeSet(repo, { mode: "explicit-staged", paths: ["src/a.ts"] })),
        "1.2.3",
      ),
      true,
    );
    assert.equal(verificationReceiptCovers(receipt, boundary, "1.2.4"), false);
    assert.equal(parseVerificationReceipt({ version: 1, codumentVersion: "1.2.3" }), null);
    const planApproval = { path: "docs/features/alpha.md", planId: "alpha", digest: "a".repeat(64) };
    const boundReceipt = parseVerificationReceipt({ ...receipt, planApproval });
    assert.ok(boundReceipt);
    assert.equal(verificationReceiptCovers(boundReceipt, boundary, "1.2.3", planApproval), true);
    assert.equal(verificationReceiptCovers(boundReceipt, boundary, "1.2.3", { ...planApproval, planId: "beta" }), false);
    assert.equal(verificationReceiptCovers(boundReceipt, boundary, "1.2.3", { ...planApproval, digest: "b".repeat(64) }), false);
    assert.equal(verificationReceiptCovers(boundReceipt, boundary, "1.2.3"), false);
    assert.equal(parseVerificationReceipt({ ...receipt, planApproval: { ...planApproval, digest: "invalid" } }), null);

    await put("src/a.ts", "export const a = 3;\n");
    git(["add", "src/a.ts"]);
    const moved = changeSetBinding(resolveChangeSet(repo, { mode: "staged" }));
    assert.equal(verificationReceiptCovers(receipt, moved, "1.2.3"), false);
  });

  it("projects the exact staged additions, edits, deletions, and renames", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    await put("src/new.ts", "export const fresh = true;\n");
    git(["mv", "src/old.ts", "src/moved.ts"]);
    git(["rm", "-q", "src/delete.ts"]);
    await put("notes.txt", "unrelated and unstaged\n");
    git(["add", "src/a.ts", "src/new.ts", "src/moved.ts"]);

    const set = resolveChangeSet(repo, { mode: "staged" });

    assert.equal(set.mode, "staged");
    assert.equal(set.complete, true);
    assert.deepEqual(set.changedFiles, ["src/a.ts", "src/moved.ts", "src/new.ts"]);
    assert.deepEqual(set.additions, ["src/new.ts"]);
    assert.deepEqual(set.deletions, ["src/delete.ts"]);
    assert.deepEqual(set.renames, [{ from: "src/old.ts", to: "src/moved.ts" }]);
    assert.deepEqual(set.dirtyOutside, ["notes.txt"]);
    assert.match(set.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(set.changes.every((change) => change.status === "deleted" || change.contentOid));
  });

  it("keeps an explicit staged subset diagnostic until it covers the complete index", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    await put("src/b.ts", "export const b = 1;\n");
    git(["add", "src/a.ts", "src/b.ts"]);

    const subset = resolveChangeSet(repo, {
      mode: "explicit-staged",
      paths: ["./src/a.ts"],
    });
    assert.equal(subset.complete, false);
    assert.deepEqual(subset.changedFiles, ["src/a.ts"]);
    assert.deepEqual(subset.unselectedStagedPaths, ["src/b.ts"]);

    const complete = resolveChangeSet(repo, {
      mode: "explicit-staged",
      paths: ["src/b.ts", "src/a.ts"],
    });
    assert.equal(complete.complete, true);
    assert.deepEqual(complete.changedFiles, ["src/a.ts", "src/b.ts"]);
    assert.equal(complete.fingerprint, resolveChangeSet(repo, { mode: "staged" }).fingerprint);
  });

  it("refuses an explicit path that is not staged", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    assert.throws(
      () => resolveChangeSet(repo, { mode: "explicit-staged", paths: ["src/a.ts"] }),
      (error: unknown) =>
        error instanceof ChangeSetError &&
        error.code === "path-not-staged" &&
        error.paths[0] === "src/a.ts",
    );
  });

  it("fails closed when worktree bytes differ from the selected index snapshot", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    git(["add", "src/a.ts"]);
    await put("src/a.ts", "export const a = 3;\n");

    assert.throws(
      () => resolveChangeSet(repo, { mode: "staged" }),
      (error: unknown) =>
        error instanceof ChangeSetError &&
        error.code === "worktree-overlap" &&
        error.paths[0] === "src/a.ts",
    );
  });

  it("fingerprints staged bytes and ignores unrelated unstaged churn", async () => {
    await put("src/a.ts", "export const a = 2;\n");
    git(["add", "src/a.ts"]);
    const first = resolveChangeSet(repo, { mode: "staged" });

    await put("notes.txt", "first\n");
    const withOutsideWork = resolveChangeSet(repo, { mode: "staged" });
    assert.equal(withOutsideWork.fingerprint, first.fingerprint);

    await put("notes.txt", "second\n");
    assert.equal(resolveChangeSet(repo, { mode: "staged" }).fingerprint, first.fingerprint);

    await put("src/a.ts", "export const a = 4;\n");
    git(["add", "src/a.ts"]);
    assert.notEqual(resolveChangeSet(repo, { mode: "staged" }).fingerprint, first.fingerprint);
  });

  it("resolves a committed range from its merge-base without consulting the index", async () => {
    const base = git(["rev-parse", "HEAD"]);
    await put("src/a.ts", "export const a = 2;\n");
    await put("src/range.ts", "export const range = true;\n");
    await commitAll("range head");
    await put("scratch.txt", "not part of the range\n");

    const set = resolveChangeSet(repo, { mode: "range", base, head: "HEAD" });

    assert.equal(set.mode, "range");
    assert.equal(set.complete, true);
    assert.deepEqual(set.changedFiles, ["src/a.ts", "src/range.ts"]);
    assert.deepEqual(set.additions, ["src/range.ts"]);
    assert.deepEqual(set.dirtyOutside, ["scratch.txt"]);
    assert.equal(set.bases[0]?.sha, base);
    assert.equal(await readFile(join(repo, "scratch.txt"), "utf8"), "not part of the range\n");
  });

  it("routes staged member-repository paths and bases through the workspace", async () => {
    const member = join(repo, "packages", "member");
    await mkdir(member, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: member });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: member });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: member });
    await writeFile(join(member, "member.ts"), "export const member = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: member });
    execFileSync("git", ["commit", "-qm", "member initial"], { cwd: member });
    await writeFile(join(member, "member.ts"), "export const member = 2;\n");
    execFileSync("git", ["add", "member.ts"], { cwd: member });
    forgetWorkspace();

    const set = resolveChangeSet(repo, { mode: "staged" });

    assert.deepEqual(set.changedFiles, ["packages/member/member.ts"]);
    assert.equal(set.bases.length, 1);
    assert.equal(set.bases[0]?.prefix, "packages/member");
    assert.equal(
      set.bases[0]?.sha,
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: member,
        encoding: "utf8",
      }).trim(),
    );
    assert.throws(
      () => resolveChangeSet(repo, { mode: "range", base: "HEAD" }),
      (error: unknown) => error instanceof ChangeSetError && error.code === "range-workspace",
    );
  });

  it("uses the canonical empty tree before a repository's first commit", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "codument-change-set-fresh-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: fresh });
      await writeFile(join(fresh, "first.ts"), "export const first = true;\n");
      execFileSync("git", ["add", "first.ts"], { cwd: fresh });
      forgetWorkspace();

      const set = resolveChangeSet(fresh, { mode: "staged" });

      assert.deepEqual(set.changedFiles, ["first.ts"]);
      assert.equal(set.bases[0]?.sha, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    } finally {
      forgetWorkspace();
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
