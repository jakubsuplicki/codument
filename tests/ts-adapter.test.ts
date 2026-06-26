import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { tsAdapter } from "../src/lib/ts-adapter.js";
import { changedAnchors } from "../src/lib/fingerprint.js";

function fpMap(content: string, path = "src/x.ts"): Map<string, string> {
  return new Map(tsAdapter.anchors(path, content).map((a) => [a.name, a.fingerprint]));
}

describe("tsAdapter.anchors", () => {
  it("emits one anchor per exported symbol, with kinds", () => {
    const anchors = tsAdapter.anchors(
      "src/x.ts",
      `export function a() { return 1; }
export class B {}
export const c = 3;
const internal = 4;
`,
    );
    assert.deepStrictEqual(
      anchors.map((a) => a.name).sort(),
      ["B", "a", "c"],
    );
    const kind = Object.fromEntries(anchors.map((a) => [a.name, a.kind]));
    assert.equal(kind.a, "function");
    assert.equal(kind.B, "class");
    assert.equal(kind.c, "variable");
  });

  it("dissolves the cascade: editing one symbol moves only its fingerprint", () => {
    const before = fpMap("export function a() { return 1; }\nexport function b() { return 2; }\n");
    const after = fpMap("export function a() { return 1; }\nexport function b() { return 99; }\n");
    assert.equal(before.get("a"), after.get("a"), "a is untouched");
    assert.notEqual(before.get("b"), after.get("b"), "b changed");
  });

  it("identity and fingerprints are order-independent (reordering is a no-op)", () => {
    const a = fpMap("export const x = 1;\nexport const y = 2;\n");
    const b = fpMap("export const y = 2;\nexport const x = 1;\n");
    assert.equal(a.get("x"), b.get("x"));
    assert.equal(a.get("y"), b.get("y"));
  });

  it("fingerprint is invariant to reformatting and comments (token stream)", () => {
    const a = fpMap("export function f(){return 1;}");
    const b = fpMap("export function f() {\n  // a comment\n  return 1;\n}\n");
    assert.equal(a.get("f"), b.get("f"));
  });

  it("distinguishes 0x10 from 16 and catches intra-string-literal changes", () => {
    assert.notEqual(fpMap("export const n = 0x10;").get("n"), fpMap("export const n = 16;").get("n"));
    assert.notEqual(fpMap('export const s = "a b";').get("s"), fpMap('export const s = "ab";').get("s"));
  });

  it("handles default exports and multi-declarator statements", () => {
    const anchors = tsAdapter.anchors(
      "src/x.ts",
      "export const a = 1, b = 2;\nexport default function () {}\n",
    );
    assert.deepStrictEqual(anchors.map((a) => a.name).sort(), ["a", "b", "default"]);
  });

  it("is precise for TS/TSX but not .d.ts or non-TS", () => {
    assert.equal(tsAdapter.matches("src/x.ts"), true);
    assert.equal(tsAdapter.matches("src/x.tsx"), true);
    assert.equal(tsAdapter.matches("src/x.d.ts"), false);
    assert.equal(tsAdapter.matches("README.md"), false);
  });
});

describe("changedAnchors per-symbol (temp git repo)", () => {
  let tmp: string;
  let shaA: string;
  let shaB: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-tsa-"));
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: tmp,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git(["init", "-b", "main"]);
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(
      join(tmp, "src/m.ts"),
      "export function a() { return 1; }\nexport function b() { return 2; }\n",
    );
    git(["add", "."]);
    git(["commit", "-m", "A"]);
    shaA = git(["rev-parse", "HEAD"]).trim();

    // edit only b, plus reorder (which must be a no-op for identity)
    await writeFile(
      join(tmp, "src/m.ts"),
      "export function b() { return 200; }\nexport function a() { return 1; }\n",
    );
    git(["add", "-A"]);
    git(["commit", "-m", "B"]);
    shaB = git(["rev-parse", "HEAD"]).trim();
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports only the edited symbol as changed (reorder is a no-op)", () => {
    const changes = changedAnchors(tmp, shaA, shaB, "src/m.ts");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].name, "b");
    assert.equal(changes[0].kind, "changed");
  });
});
