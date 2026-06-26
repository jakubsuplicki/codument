import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  adapterFor,
  coarseAdapter,
  contentChangedFiles,
  fileContentChange,
} from "../src/lib/fingerprint.js";

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

describe("coarseAdapter", () => {
  const fp = (content: string) => coarseAdapter.anchors("x.txt", content)[0].fingerprint;
  it("emits a single whole-file anchor invariant to BOM/CRLF cosmetic churn", () => {
    const anchors = coarseAdapter.anchors("x.txt", "a\n");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].kind, "file");
    assert.equal(fp("export const x = 1;\n"), fp("﻿export const x = 1;\r\n"));
  });
  it("moves on a real content change and is deterministic", () => {
    assert.notEqual(fp("const x = 1;\n"), fp("const x = 2;\n"));
    assert.equal(fp("const x = 1;\n"), fp("const x = 1;\n"));
  });
});

describe("adapterFor", () => {
  it("resolves TS to the precise adapter and everything else to coarse", () => {
    assert.equal(adapterFor("src/foo.ts").language, "typescript");
    assert.equal(adapterFor("src/foo.tsx").language, "typescript");
    assert.equal(adapterFor("src/foo.d.ts").language, "coarse");
    assert.equal(adapterFor("README.md").language, "coarse");
    assert.equal(adapterFor("script.py").language, "coarse");
  });
});

describe("fileContentChange / contentChangedFiles (temp git repo)", () => {
  let tmp: string;
  let shaA: string;
  let shaB: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-fp-"));
    git(tmp, ["init", "-b", "main"]);
    git(tmp, ["config", "core.autocrlf", "false"]);

    await writeFile(join(tmp, "foo.ts"), "export const x = 1;\n");
    await writeFile(join(tmp, "bar.ts"), "keep\n");
    await writeFile(join(tmp, "cos.ts"), "a\nb\n");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "A"]);
    shaA = git(tmp, ["rev-parse", "HEAD"]);

    await writeFile(join(tmp, "foo.ts"), "export const x = 2;\n"); // real change
    await rm(join(tmp, "bar.ts")); // removed
    await writeFile(join(tmp, "baz.ts"), "new\n"); // added
    await writeFile(join(tmp, "cos.ts"), "a\r\nb\r\n"); // CRLF only — cosmetic
    git(tmp, ["add", "-A"]);
    git(tmp, ["commit", "-m", "B"]);
    shaB = git(tmp, ["rev-parse", "HEAD"]);
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("classifies added/removed/changed and ignores cosmetic-only churn", () => {
    assert.equal(fileContentChange(tmp, shaA, shaB, "foo.ts"), "changed");
    assert.equal(fileContentChange(tmp, shaA, shaB, "bar.ts"), "removed");
    assert.equal(fileContentChange(tmp, shaA, shaB, "baz.ts"), "added");
    // cos.ts differs byte-for-byte (CRLF) but is identical after normalization
    assert.equal(fileContentChange(tmp, shaA, shaB, "cos.ts"), "unchanged");
  });

  it("drops cosmetic churn from a candidate set", () => {
    const changed = contentChangedFiles(tmp, shaA, shaB, [
      "foo.ts",
      "bar.ts",
      "baz.ts",
      "cos.ts",
    ]);
    assert.deepStrictEqual(changed, ["bar.ts", "baz.ts", "foo.ts"]);
  });
});
