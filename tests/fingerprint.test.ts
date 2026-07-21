import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  adapterFor,
  coarseAdapter,
  contentChangedFiles,
  fileContentChange,
  fileContentTransition,
  warmAdaptersForRepo,
  warmPathsForRepo,
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
  it("resolves each language to its precise adapter and everything else to coarse", () => {
    assert.equal(adapterFor("src/foo.ts").language, "typescript");
    assert.equal(adapterFor("src/foo.tsx").language, "typescript");
    assert.equal(adapterFor("src/foo.d.ts").language, "coarse");
    assert.equal(adapterFor("README.md").language, "coarse");
    assert.equal(adapterFor("script.py").language, "python");
    assert.equal(adapterFor("stubs.pyi").language, "python");
    assert.equal(adapterFor("script.pyc").language, "coarse");
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

describe("fileContentTransition (base ref vs working tree)", () => {
  let tmp: string;
  let sha: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-fct-"));
    git(tmp, ["init", "-b", "main"]);
    git(tmp, ["config", "core.autocrlf", "false"]);
    await writeFile(join(tmp, "keep.ts"), "export const x = 1;\n");
    await writeFile(join(tmp, "cos.ts"), "a\nb\n");
    await writeFile(join(tmp, "gone.ts"), "bye\n");
    git(tmp, ["add", "."]);
    git(tmp, ["commit", "-m", "A"]);
    sha = git(tmp, ["rev-parse", "HEAD"]);
    // Mutate the WORKING TREE (not committed) — this is the head the ack binds.
    await writeFile(join(tmp, "keep.ts"), "export const x = 2;\n"); // real change
    await writeFile(join(tmp, "cos.ts"), "a\r\nb\r\n"); // CRLF-only cosmetic churn
    await writeFile(join(tmp, "added.ts"), "fresh\n"); // absent at base
    await rm(join(tmp, "gone.ts")); // deleted from the tree
  });
  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns distinct from/to coarse fingerprints for a real working-tree change", () => {
    const t = fileContentTransition(tmp, sha, "keep.ts");
    assert.ok(t.from && t.to);
    assert.notEqual(t.from, t.to, "a real content change moves the fingerprint");
  });

  it("returns from === to for a cosmetic-only (CRLF/BOM) change — nothing to ack", () => {
    const t = fileContentTransition(tmp, sha, "cos.ts");
    assert.equal(t.from, t.to, "byte-normalized so cosmetic churn does not move it");
  });

  it("reports a null side for an added (no base) or deleted (no head) file", () => {
    const added = fileContentTransition(tmp, sha, "added.ts");
    assert.equal(added.from, null);
    assert.ok(added.to);
    const gone = fileContentTransition(tmp, sha, "gone.ts");
    assert.ok(gone.from);
    assert.equal(gone.to, null);
  });
});

// ── Warm completeness ───────────────────────────────────────────────────
//
// The reported crash: `codument doctor` died with
//   TreeSitterError: python grammar not loaded — the command layer must warm
//   adapters before the sync gate path runs
// on any registry naming a `.py` git could not see. doctor DID warm; the warm
// set was derived from git's view (`ls-files` + `status`) while the analyzers
// consume the REGISTRY's view. Any path in the second set but not the first
// reached `adapterFor(p).anchors(...)` cold and took the whole command down.
//
// These assert the PATH SET, not the warm side effect: warming is process-wide
// state, so a test that only checks "can it parse python now" passes trivially
// once any earlier test in the file has warmed that grammar.

describe("warmPathsForRepo unions git's view with the registry's own sources", () => {
  let root: string;

  const writeRegistry = async (primary: string[], related: string[] = []) => {
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(
      join(root, "docs", ".registry.json"),
      JSON.stringify({
        version: 1,
        features: {
          app: {
            doc: "docs/features/app.md",
            type: "feature",
            primary_sources: primary,
            related_sources: related,
            depends_on: [],
            risk: "low",
          },
        },
      }),
    );
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-warm-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("includes a registry-named source under a NON-repo root (the field repro)", async () => {
    // No `git init`: every git listing answers ok:false, so git's view is empty
    // and the registry is the ONLY thing that knows a .py is in play.
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.py"), "def hello():\n    return 1\n");
    await writeRegistry(["src/app.py"]);

    assert.ok(
      warmPathsForRepo(root).includes("src/app.py"),
      "a non-repo root must still warm from the registry",
    );
  });

  it("includes a registry-named source that is gitignored inside a real repo", async () => {
    // The second, independent trigger: a normal repo where the mapped file is
    // gitignored, so `ls-files` never reports it. Proves this was never
    // exclusively a non-repo bug.
    git(root, ["init"]);
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "out/\n");
    await writeFile(join(root, "out", "gen.py"), "def gen():\n    return 1\n");
    await writeRegistry(["out/gen.py"]);

    assert.ok(warmPathsForRepo(root).includes("out/gen.py"));
  });

  it("includes related_sources, not just primary_sources", async () => {
    await writeRegistry(["src/a.ts"], ["src/b.py"]);
    const paths = warmPathsForRepo(root);
    assert.ok(paths.includes("src/a.ts"));
    assert.ok(paths.includes("src/b.py"));
  });

  it("keeps git's view too — a tracked file absent from the registry still warms", async () => {
    // The union runs both ways: registry-only would miss unmapped files, which
    // the gate still evaluates for unmapped-source findings.
    git(root, ["init"]);
    await writeFile(join(root, "tracked.py"), "def t():\n    return 1\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "a"]);
    await writeRegistry([]);

    assert.ok(warmPathsForRepo(root).includes("tracked.py"));
  });

  it("is deduped and sorted (a file both tracked and registered appears once)", async () => {
    git(root, ["init"]);
    await writeFile(join(root, "dup.py"), "def d():\n    return 1\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "a"]);
    await writeRegistry(["dup.py"]);

    const paths = warmPathsForRepo(root);
    assert.equal(paths.filter((p) => p === "dup.py").length, 1);
    assert.deepStrictEqual(paths, [...paths].sort());
  });

  it("stays advisory: no repo and no registry yields no paths and no throw", () => {
    assert.deepStrictEqual(warmPathsForRepo(root), []);
  });

  it("stays advisory: an unparseable registry does not throw", async () => {
    // The warm must never open a failure channel ahead of the verdict path's own
    // guarded error — the command layer reports a corrupt registry in its own right.
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), "{ not json");
    assert.doesNotThrow(() => warmPathsForRepo(root));
    await assert.doesNotReject(() => warmAdaptersForRepo(root));
  });
});
