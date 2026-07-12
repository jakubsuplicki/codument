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
  it("digests the bundled grammar set; an empty manifest carries no segment", () => {
    assert.ok(algoStamp().includes("grammars="), "python grammar is bundled → segment present");
    assert.ok(!algoStamp([]).includes("grammars="));
  });
  it("a grammar bump is an algo-visible event; entry order is not", () => {
    const python = { language: "python", sha256: "a".repeat(64) };
    const go = { language: "go", sha256: "b".repeat(64) };
    const stamp = algoStamp([python, go]);
    assert.ok(stamp.includes("grammars="));
    // Same manifest → same stamp, every call; either order (sorted segment,
    // caller-independent).
    assert.equal(stamp, algoStamp([python, go]));
    assert.equal(stamp, algoStamp([go, python]));
    // A bumped grammar hash → a different stamp: the simulated grammar upgrade.
    const bumped = { language: "python", sha256: "c".repeat(64) };
    assert.notEqual(stamp, algoStamp([bumped, go]));
    // Adding a language is equally visible.
    assert.notEqual(stamp, algoStamp([python]));
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

describe("changedPathsBetween: -z path decoding and rename ordering", () => {
  let tmp: string;
  let a: string;
  let b: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-tworef-z-"));
    git(tmp, ["init", "-b", "main"]);
    git(tmp, ["config", "core.autocrlf", "false"]);
    // Turn quotePath ON deliberately: octal-escaped non-ASCII paths are exactly
    // the failure mode `-z` framing must defeat regardless of this setting.
    git(tmp, ["config", "core.quotePath", "true"]);
    await writeFile(join(tmp, "föo.ts"), "export const a = 1;\n");
    await writeFile(join(tmp, "日本語.ts"), "export const b = 1;\n");
    await writeFile(join(tmp, "old-name.ts"), "export const c = 1;\n");
    git(tmp, ["add", "-A"]);
    git(tmp, ["commit", "-m", "A"]);
    a = git(tmp, ["rev-parse", "HEAD"]);

    // Modify a non-ASCII file; rename a file with content preserved so `-M`
    // detects it as a rename rather than an add+delete.
    await writeFile(join(tmp, "föo.ts"), "export const a = 2;\n");
    git(tmp, ["mv", "old-name.ts", "new-näme.ts"]);
    git(tmp, ["add", "-A"]);
    git(tmp, ["commit", "-m", "B"]);
    b = git(tmp, ["rev-parse", "HEAD"]);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("decodes non-ASCII paths verbatim even with core.quotePath on", () => {
    const changes = changedPathsBetween(tmp, a, b);
    assert.ok(
      changes.some((c) => c.path === "föo.ts" && c.status === "modified"),
      "non-ASCII modified path decoded verbatim",
    );
    for (const c of changes) {
      assert.doesNotMatch(
        c.path,
        /\\\d{3}|^"/,
        `path ${c.path} is octal-escaped or quoted`,
      );
    }
  });

  it("classifies a rename with base→head field order (diff -z, unlike status -z)", () => {
    const renamed = changedPathsBetween(tmp, a, b).find(
      (c) => c.status === "renamed",
    );
    assert.ok(renamed, "rename detected");
    assert.equal(renamed?.path, "new-näme.ts", "new path at head");
    assert.equal(renamed?.oldPath, "old-name.ts", "old path at base");
  });
});
