import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ALGO_VERSION,
  algoStamp,
  byteNormalize,
  changedPathsBetween,
  EMPTY_TREE_SHA,
  GateError,
  readBlobAtRef,
  refReachable,
  resolveBase,
} from "../src/lib/two-ref.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

describe("byteNormalize", () => {
  it("strips a leading BOM and folds CRLF/CR to LF", () => {
    assert.equal(byteNormalize("﻿a\r\nb\rc\n"), "a\nb\nc\n");
  });
  it("leaves already-normalized content unchanged and is idempotent", () => {
    const s = "line1\nline2\n";
    assert.equal(byteNormalize(s), s);
    assert.equal(byteNormalize(byteNormalize(s)), s);
  });
  it("does not collapse interior whitespace", () => {
    assert.equal(byteNormalize("a  b\tc"), "a  b\tc");
  });
});

describe("algoStamp", () => {
  it("embeds the exact TS version and algo version, and is deterministic", () => {
    const stamp = algoStamp();
    assert.match(stamp, /ts=\d+\.\d+\.\d+/);
    assert.ok(stamp.includes(`algo=${ALGO_VERSION}`));
    assert.equal(stamp, algoStamp());
  });
});

describe("EMPTY_TREE_SHA", () => {
  it("is git's canonical empty tree object", () => {
    assert.equal(EMPTY_TREE_SHA, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});

describe("two-ref git plumbing", () => {
  let tmp: string;
  let shaA: string;
  let shaB: string;
  let orphanSha: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-tworef-"));
    git(tmp, ["init", "-b", "main"]);
    // keep the blob bytes exactly as written so the BOM/CRLF normalization test
    // is independent of the host's global core.autocrlf
    git(tmp, ["config", "core.autocrlf", "false"]);

    await writeFile(join(tmp, "foo.ts"), "export const x = 1;\n");
    await writeFile(join(tmp, "keep.ts"), "keep\n");
    // a file with a BOM + CRLF to prove readBlobAtRef normalizes
    await writeFile(join(tmp, "crlf.ts"), "﻿a\r\nb\r\n");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "A"]);
    shaA = git(tmp, ["rev-parse", "HEAD"]);

    await writeFile(join(tmp, "foo.ts"), "export const x = 2;\n");
    await writeFile(join(tmp, "bar.ts"), "new\n");
    await rm(join(tmp, "keep.ts"));
    git(tmp, ["add", "-A"]);
    git(tmp, ["commit", "-m", "B"]);
    shaB = git(tmp, ["rev-parse", "HEAD"]);

    // an orphan branch shares no history with main
    git(tmp, ["checkout", "--orphan", "orphan"]);
    git(tmp, ["rm", "-rf", "."]);
    await writeFile(join(tmp, "z.ts"), "z\n");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "orphan"]);
    orphanSha = git(tmp, ["rev-parse", "HEAD"]);
    git(tmp, ["checkout", "main"]);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads a blob's content at a specific ref", () => {
    assert.equal(readBlobAtRef(tmp, shaB, "foo.ts"), "export const x = 2;\n");
    assert.equal(readBlobAtRef(tmp, shaA, "foo.ts"), "export const x = 1;\n");
  });

  it("byte-normalizes blob content (BOM + CRLF stripped)", () => {
    assert.equal(readBlobAtRef(tmp, shaA, "crlf.ts"), "a\nb\n");
  });

  it("returns null for a path absent at a reachable ref", () => {
    // bar.ts exists at B but not at A
    assert.equal(readBlobAtRef(tmp, shaA, "bar.ts"), null);
  });

  it("throws GateError(bad-ref) for an unresolvable ref", () => {
    assert.throws(
      () => readBlobAtRef(tmp, "0000000000000000000000000000000000000000", "foo.ts"),
      (err: unknown) => err instanceof GateError && err.kind === "bad-ref",
    );
  });

  it("refReachable is true for a real ref and false for a bogus one", () => {
    assert.equal(refReachable(tmp, shaA), true);
    assert.equal(refReachable(tmp, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), false);
  });

  it("resolves the single merge-base of a linear history", () => {
    const r = resolveBase(tmp, shaA, shaB);
    assert.equal(r.sha, shaA);
    assert.equal(r.emptyTree, false);
    assert.equal(r.ambiguous, false);
  });

  it("falls back to the empty tree when refs share no common ancestor", () => {
    const r = resolveBase(tmp, orphanSha, shaB);
    assert.equal(r.sha, EMPTY_TREE_SHA);
    assert.equal(r.emptyTree, true);
  });

  it("fails closed (unreachable-base) when a ref is not reachable", () => {
    assert.throws(
      () => resolveBase(tmp, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", shaB),
      (err: unknown) => err instanceof GateError && err.kind === "unreachable-base",
    );
  });

  it("classifies changed paths with deletions and additions first-class", () => {
    const changes = changedPathsBetween(tmp, shaA, shaB);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
    assert.equal(byPath["bar.ts"], "added");
    assert.equal(byPath["foo.ts"], "modified");
    assert.equal(byPath["keep.ts"], "deleted");
    // sorted by path
    assert.deepStrictEqual(
      changes.map((c) => c.path),
      ["bar.ts", "foo.ts", "keep.ts"],
    );
  });
});
