import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { changedAnchors } from "../src/lib/fingerprint.js";
import { classifyTsFile, tsAdapter } from "../src/lib/ts-adapter.js";

function fpMap(content: string, path = "src/x.ts"): Map<string, string> {
  return new Map(tsAdapter.anchors(path, content).map((a) => [a.name, a.fingerprint]));
}

describe("tsAdapter.anchors", () => {
  it("emits one anchor per exported symbol, with kinds, plus a residual backstop", () => {
    const anchors = tsAdapter.anchors(
      "src/x.ts",
      `export function a() { return 1; }
export class B {}
export const c = 3;
const internal = 4;
`,
    );
    // `internal` is referenced by no export -> it is residual, caught by the
    // module backstop, so it is never silently un-gated.
    assert.deepStrictEqual(anchors.map((a) => a.name).sort(), ["<module>", "B", "a", "c"]);
    const kind = Object.fromEntries(anchors.map((a) => [a.name, a.kind]));
    assert.equal(kind.a, "function");
    assert.equal(kind.B, "class");
    assert.equal(kind.c, "variable");
    assert.equal(kind["<module>"], "module");
  });

  it("emits no backstop when the file is pure exports (no residual)", () => {
    const anchors = tsAdapter.anchors("src/x.ts", "export const x = 1;\n");
    assert.deepStrictEqual(
      anchors.map((a) => a.name),
      ["x"],
    );
  });

  it("closes an export's fingerprint over the private helpers it references", () => {
    const before = fpMap(
      "function helper() { return 1; }\nexport function f() { return helper(); }\n",
    );
    const after = fpMap(
      "function helper() { return 2; }\nexport function f() { return helper(); }\n",
    );
    // editing the private helper moves its caller's fingerprint (no blindness)
    assert.notEqual(before.get("f"), after.get("f"));
  });

  it("closure is per-export: a helper used by f but not g wakes only f", () => {
    const before = fpMap(
      "function h() { return 1; }\nexport function f() { return h(); }\nexport function g() { return 2; }\n",
    );
    const after = fpMap(
      "function h() { return 9; }\nexport function f() { return h(); }\nexport function g() { return 2; }\n",
    );
    assert.notEqual(before.get("f"), after.get("f"), "f references h");
    assert.equal(before.get("g"), after.get("g"), "g does not reference h");
  });

  it("closure is transitive (f -> h1 -> h2)", () => {
    const before = fpMap(
      "function h2() { return 1; }\nfunction h1() { return h2(); }\nexport function f() { return h1(); }\n",
    );
    const after = fpMap(
      "function h2() { return 5; }\nfunction h1() { return h2(); }\nexport function f() { return h1(); }\n",
    );
    assert.notEqual(before.get("f"), after.get("f"));
  });

  it("a covered helper is not double-counted in the backstop", () => {
    // `helper` is referenced by `f`, so it is part of f's closure and NOT
    // residual; the file therefore has no module backstop at all.
    const anchors = tsAdapter.anchors(
      "src/x.ts",
      "function helper() { return 1; }\nexport function f() { return helper(); }\n",
    );
    assert.deepStrictEqual(anchors.map((a) => a.name).sort(), ["f"]);
  });

  it("backstop catches module side-effects no export covers", () => {
    const before = fpMap("setup({ port: 3000 });\nexport function f() { return 1; }\n");
    const after = fpMap("setup({ port: 4000 });\nexport function f() { return 1; }\n");
    assert.equal(before.get("f"), after.get("f"), "f is untouched");
    assert.notEqual(
      before.get("<module>"),
      after.get("<module>"),
      "the residual side-effect moved",
    );
  });

  it("backstop catches import changes (not covered by any symbol body)", () => {
    const before = fpMap('import { x } from "./a.js";\nexport function f() { return x; }\n');
    const after = fpMap('import { x } from "./b.js";\nexport function f() { return x; }\n');
    assert.equal(before.get("f"), after.get("f"), "f's token stream is unchanged");
    assert.notEqual(before.get("<module>"), after.get("<module>"));
  });

  it("backstop catches changes to unreferenced module state", () => {
    const before = fpMap("const dead = 1;\nexport function f() { return 1; }\n");
    const after = fpMap("const dead = 2;\nexport function f() { return 1; }\n");
    assert.equal(before.get("f"), after.get("f"));
    assert.notEqual(before.get("<module>"), after.get("<module>"));
  });

  it("a method call does not spuriously couple to a same-named top-level decl", () => {
    // `arr.map` is a property access, not a reference to the top-level `map`, so
    // `map` stays residual and editing it never moves `f`.
    const before = fpMap(
      "function map() { return 1; }\nexport function f() { return [1].map((x) => x); }\n",
    );
    const after = fpMap(
      "function map() { return 9; }\nexport function f() { return [1].map((x) => x); }\n",
    );
    assert.equal(before.get("f"), after.get("f"), "f only does arr.map, not map()");
    assert.notEqual(before.get("<module>"), after.get("<module>"));
  });

  it("a computed property name is a real reference (closure includes it)", () => {
    const before = fpMap('const key = "k";\nexport const obj = { [key]: 1 };\n');
    const after = fpMap('const key = "z";\nexport const obj = { [key]: 1 };\n');
    assert.notEqual(before.get("obj"), after.get("obj"));
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
    assert.notEqual(
      fpMap("export const n = 0x10;").get("n"),
      fpMap("export const n = 16;").get("n"),
    );
    assert.notEqual(
      fpMap('export const s = "a b";').get("s"),
      fpMap('export const s = "ab";').get("s"),
    );
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

describe("classifyTsFile (Phase 2d — precise|coarse|unevaluable)", () => {
  it("a file with exported declarations is precise", () => {
    const c = classifyTsFile("src/x.ts", "export function foo() {}\nexport const bar = 1;\n");
    assert.equal(c.mode, "precise");
  });

  it("a parse error is unevaluable (fail loud, never read as fresh)", () => {
    const c = classifyTsFile("src/x.ts", "export const a = ;\n");
    assert.equal(c.mode, "unevaluable");
    assert.match(c.reason, /parse error/);
  });

  it("git conflict markers are unevaluable", () => {
    const c = classifyTsFile(
      "src/x.ts",
      "export const a = 1;\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n",
    );
    assert.equal(c.mode, "unevaluable");
  });

  it("a .d.ts declaration file is coarse", () => {
    const c = classifyTsFile("src/x.d.ts", "export declare const a: number;\n");
    assert.equal(c.mode, "coarse");
    assert.match(c.reason, /declaration/);
  });

  it("an @generated banner makes a hand-written-looking file coarse", () => {
    const c = classifyTsFile(
      "src/api.ts",
      "// @generated by codegen — do not edit\nexport function foo() {}\n",
    );
    assert.equal(c.mode, "coarse");
    assert.match(c.reason, /generated/);
  });

  it("a re-export barrel (no own declarations) is coarse", () => {
    const c = classifyTsFile(
      "src/index.ts",
      'export { foo } from "./foo.js";\nexport * from "./bar.js";\n',
    );
    assert.equal(c.mode, "coarse");
    assert.match(c.reason, /no precise exports/);
  });

  it("an `export =` module is coarse", () => {
    const c = classifyTsFile("src/legacy.ts", "const x = 1;\nexport = x;\n");
    assert.equal(c.mode, "coarse");
  });

  it("a namespace-only export is coarse", () => {
    const c = classifyTsFile(
      "src/ns.ts",
      "export namespace NS {\n  export const x = 1;\n}\n",
    );
    assert.equal(c.mode, "coarse");
  });

  it("a side-effect-only module is coarse (gated whole-file via the backstop)", () => {
    const c = classifyTsFile("src/boot.ts", 'import "./polyfill.js";\nconsole.log("go");\n');
    assert.equal(c.mode, "coarse");
  });

  it("a comments-only file is coarse (no anchorable content, not an error)", () => {
    const c = classifyTsFile("src/notes.ts", "// just notes\n// nothing to export\n");
    assert.equal(c.mode, "coarse");
    assert.match(c.reason, /no anchorable content/);
  });

  it("a file that mixes precise exports with re-exports is still precise", () => {
    const c = classifyTsFile(
      "src/x.ts",
      'export { helper } from "./helper.js";\nexport function foo() {}\n',
    );
    assert.equal(c.mode, "precise");
  });
});
