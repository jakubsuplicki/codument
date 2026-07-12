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

describe("tsAdapter signature/body split", () => {
  // name -> { fp (composite), sig (signature hash, undefined for module/coarse) }
  const amap = (content: string, path = "src/x.ts") =>
    new Map(tsAdapter.anchors(path, content).map((a) => [a.name, { fp: a.fingerprint, sig: a.signature }]));
  const get = (m: ReturnType<typeof amap>, name: string) => {
    const v = m.get(name);
    assert.ok(v, `anchor ${name} present`);
    return v;
  };
  // A "sig move" is a signature change; a "body move" keeps the signature but
  // moves the composite. These two predicates are exactly Step 2's classifier.
  const sigMoved = (a: string, b: string, name: string) => {
    assert.notEqual(get(amap(a), name).sig, get(amap(b), name).sig, `${name}: signature moved`);
    assert.notEqual(get(amap(a), name).fp, get(amap(b), name).fp, `${name}: composite moved`);
  };
  const bodyOnly = (a: string, b: string, name: string) => {
    assert.equal(get(amap(a), name).sig, get(amap(b), name).sig, `${name}: signature held`);
    assert.notEqual(get(amap(a), name).fp, get(amap(b), name).fp, `${name}: composite still moved`);
  };
  // Canonicalized: a pure local/parameter rename moves NEITHER hash (no fire).
  const unchanged = (a: string, b: string, name: string) => {
    assert.equal(get(amap(a), name).sig, get(amap(b), name).sig, `${name}: signature identical`);
    assert.equal(get(amap(a), name).fp, get(amap(b), name).fp, `${name}: composite identical (no fire)`);
  };

  it("a parameter rename AND a local rename are invariant; a real body change still fires", () => {
    // Both the parameter and the block local are bound within the declaration, so
    // renaming either (and its uses) canonicalizes to the same fingerprint — the
    // #1 measured false-fire, now structurally gone.
    unchanged(
      "export function f(a: number): number { const x = a; return x; }\n",
      "export function f(b: number): number { const x = b; return x; }\n",
      "f",
    );
    unchanged(
      "export function f(a: number): number { const x = a; return x; }\n",
      "export function f(a: number): number { const y = a; return y; }\n",
      "f",
    );
    // A genuine implementation change (not a rename) still moves the body hash.
    bodyOnly(
      "export function f(a: number): number { const x = a; return x; }\n",
      "export function f(a: number): number { const x = a; return x + 1; }\n",
      "f",
    );
    // A parameter TYPE change is still a signature move — only the NAME canonicalizes.
    sigMoved(
      "export function f(a: number): number { return a; }\n",
      "export function f(a: string): number { return a; }\n",
      "f",
    );
  });

  it("a return-type change and a modifier change are sig-moves", () => {
    sigMoved(
      "export function f(a: number): number { return a; }\n",
      "export function f(a: number): string { return String(a); }\n",
      "f",
    );
    sigMoved(
      "export function f(): void {}\n",
      "export async function f(): Promise<void> {}\n",
      "f",
    );
  });

  it("arrow const: a param rename is invariant, a body edit is body-only", () => {
    unchanged(
      "export const f = (a: number): number => a + 1;\n",
      "export const f = (b: number): number => b + 1;\n",
      "f",
    );
    bodyOnly(
      "export const f = (a: number): number => a + 1;\n",
      "export const f = (a: number): number => a + 2;\n",
      "f",
    );
  });

  it("a wrapped (non-direct-function) initializer is all-signature — the documented boundary", () => {
    // `memoize(() => ...)` is a CallExpression initializer, so there is no
    // separable body: any change is a sig-move (conservative, never launders).
    sigMoved(
      "export const f = memoize((a: number) => a + 1);\n",
      "export const f = memoize((a: number) => a + 2);\n",
      "f",
    );
  });

  it("interface / type alias / enum are all-signature (any member change is a sig-move)", () => {
    sigMoved("export interface I { a: number; }\n", "export interface I { a: string; }\n", "I");
    sigMoved("export type T = number;\n", "export type T = string;\n", "T");
    sigMoved("export enum E { A, B }\n", "export enum E { A, B, C }\n", "E");
  });

  it("class members are all-signature (a method signature OR body change is a sig-move)", () => {
    sigMoved(
      "export class C { m(a: number): number { return a; } }\n",
      "export class C { m(a: string): string { return a; } }\n",
      "C",
    );
    sigMoved(
      "export class C { m(a: number): number { return a; } }\n",
      "export class C { m(a: number): number { return a + 1; } }\n",
      "C",
    );
  });

  it("overloads: an overload-signature-only change is a sig-move and moves the composite (never last-wins shadowed)", () => {
    sigMoved(
      "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any { return a; }\n",
      "export function f(a: string): string;\nexport function f(a: boolean): boolean;\nexport function f(a: any): any { return a; }\n",
      "f",
    );
  });

  it("overloads: unexported signatures with an exported impl are still folded into the sig (no residual leak)", () => {
    const base = amap(
      "function f(a: string): string;\nfunction f(a: number): number;\nexport function f(a: any): any { return a; }\n",
    );
    assert.ok(base.has("f"));
    assert.ok(!base.has("<module>"), "unexported overload signatures do not leak into the residual backstop");
    sigMoved(
      "function f(a: string): string;\nfunction f(a: number): number;\nexport function f(a: any): any { return a; }\n",
      "function f(a: string): string;\nfunction f(a: boolean): boolean;\nexport function f(a: any): any { return a; }\n",
      "f",
    );
  });

  it("overloads: an implementation-body-only change is body-only", () => {
    bodyOnly(
      "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any { return a; }\n",
      "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any { return String(a); }\n",
      "f",
    );
  });

  it("a private helper referenced from the signature is a sig-move; from the body only, body-only; from both, sig-move", () => {
    // signature position (a parameter default value)
    sigMoved(
      "function d(): number { return 1; }\nexport function f(a: number = d()): number { return a; }\n",
      "function d(): number { return 2; }\nexport function f(a: number = d()): number { return a; }\n",
      "f",
    );
    // body only
    bodyOnly(
      "function h(): number { return 1; }\nexport function g(): number { return h(); }\n",
      "function h(): number { return 2; }\nexport function g(): number { return h(); }\n",
      "g",
    );
    // referenced in both → sig wins the tie
    sigMoved(
      "function d(): number { return 1; }\nexport function f(a: number = d()): number { return a + d(); }\n",
      "function d(): number { return 2; }\nexport function f(a: number = d()): number { return a + d(); }\n",
      "f",
    );
  });

  it("inferred-return-type widening is body-only — the documented type-checker boundary", () => {
    // No explicit return annotation: widening the returned shape is a real
    // contract change but reads as a body edit without a type checker. Pinned so
    // the boundary is deliberate, not an accidental regression.
    bodyOnly(
      "export function f() { return { a: 1 }; }\n",
      "export function f() { return { a: 1, b: 2 }; }\n",
      "f",
    );
  });

  it("is deterministic and order-independent; reordering overload signatures moves the fingerprint", () => {
    const src =
      "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any { return a; }\nexport const c = 1;\n";
    assert.deepEqual([...amap(src)], [...amap(src)]);
    const reordered =
      "export const c = 1;\nexport function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any { return a; }\n";
    assert.equal(get(amap(src), "f").fp, get(amap(reordered), "f").fp, "reordering unrelated decls is a no-op");
    assert.equal(get(amap(src), "c").fp, get(amap(reordered), "c").fp);
    const swapped =
      "export function f(a: number): number;\nexport function f(a: string): string;\nexport function f(a: any): any { return a; }\n";
    assert.notEqual(get(amap(src), "f").sig, get(amap(swapped), "f").sig, "overload resolution order is contract");
  });

  it("a PRIVATE overloaded helper's whole surface is hashed — an overload-signature-only change wakes its caller", () => {
    // g is a private overloaded helper referenced from f's body. Changing g's
    // overload SIGNATURE (not its impl) must still move f — the helper's full
    // surface (every signature + the impl) is folded into f's closure, so the
    // change is never hashed nowhere and read as fresh.
    const base = "function g(x: number): number;\nfunction g(x: any): any { return x; }\nexport function f(): number { return g(1); }\n";
    const sigChanged = "function g(x: string): string;\nfunction g(x: any): any { return x; }\nexport function f(): number { return g(1); }\n";
    bodyOnly(base, sigChanged, "f"); // reached from f's body → f's composite moves, f's own signature holds
    // ...but an unrelated export must NOT move when g's signature changes (no over-firing).
    const twoExports = base + "export function h(): number { return 7; }\n";
    const twoExportsSig = sigChanged + "export function h(): number { return 7; }\n";
    assert.equal(get(amap(twoExports), "h").fp, get(amap(twoExportsSig), "h").fp, "an unrelated export stays put");
  });

  it("a malformed run with two implementations folds every body — the first body is not dropped", () => {
    // Two same-name exported functions each with a body is invalid TS (duplicate
    // implementation) but has no SYNTACTIC diagnostic, so the file stays precise.
    // Every body must be hashed, so editing the FIRST body is never invisible.
    bodyOnly(
      "export function f() { return 1; }\nexport function f() { return 2; }\n",
      "export function f() { return 99; }\nexport function f() { return 2; }\n",
      "f",
    );
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

  it("an `export =` module is precise (a default anchor, like `export default`)", () => {
    const c = classifyTsFile("src/legacy.ts", "const x = 1;\nexport = x;\n");
    assert.equal(c.mode, "precise");
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

// Plan 17: `export default <expr>` / `export = <expr>` (ExportAssignment) is a
// precise `default.` anchor with a call-aware signature/body split (ADR 014) —
// the fix for config files (nuxt.config.ts et al) degrading to coarse and firing
// on every byte.
describe("ExportAssignment anchors (config-file grain)", () => {
  const CONFIG = [
    "// site config",
    "export default defineNuxtConfig({",
    "  modules: ['@nuxt/content'],",
    "  css: ['~/assets/tokens.css'],",
    "})",
    "",
  ].join("\n");

  function anchor(content: string, path = "nuxt.config.ts") {
    const anchors = tsAdapter.anchors(path, content);
    const a = anchors.find((x) => x.name === "default");
    assert.ok(a, "default anchor must exist");
    return a;
  }

  it("a defineNuxtConfig-shaped file is precise with one default anchor", () => {
    assert.equal(classifyTsFile("nuxt.config.ts", CONFIG).mode, "precise");
    const anchors = tsAdapter.anchors("nuxt.config.ts", CONFIG);
    assert.deepEqual(
      anchors.map((a) => a.id),
      ["nuxt.config.ts::default."],
    );
  });

  it("a comment-only edit moves nothing (token-stream invariance)", () => {
    const edited = CONFIG.replace("// site config", "// totally reworded comment");
    assert.equal(anchor(CONFIG).fingerprint, anchor(edited).fingerprint);
  });

  it("an edit inside the config object is a body-only move (ackable)", () => {
    const edited = CONFIG.replace("'@nuxt/content'", "'@nuxt/content', '@nuxt/image'");
    const before = anchor(CONFIG);
    const after = anchor(edited);
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.equal(before.signature, after.signature);
  });

  it("swapping the producing callee is a signature move (contract, not ackable)", () => {
    const edited = CONFIG.replace("defineNuxtConfig", "defineSomethingElse");
    const before = anchor(CONFIG);
    const after = anchor(edited);
    assert.notEqual(before.signature, after.signature);
  });

  it("a non-call default export is wholly body under the export frame", () => {
    const obj = "export default { retries: 3 };\n";
    const edited = "export default { retries: 5 };\n";
    const before = anchor(obj, "settings.ts");
    const after = anchor(edited, "settings.ts");
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.equal(before.signature, after.signature);
  });

  it("`export = <identifier>` closes over the private value it exports", () => {
    const v1 = "const api = { a: 1 };\nexport = api;\n";
    const v2 = "const api = { a: 2 };\nexport = api;\n";
    // The private const is closure-covered: exactly one anchor, no residual…
    assert.deepEqual(
      tsAdapter.anchors("legacy.ts", v1).map((a) => a.id),
      ["legacy.ts::default."],
    );
    // …and editing the private value moves the default anchor, never reads fresh.
    assert.notEqual(anchor(v1, "legacy.ts").fingerprint, anchor(v2, "legacy.ts").fingerprint);
  });

  it("anonymous `export default function` keeps its split (unchanged behavior)", () => {
    const fn = "export default function () { return 1; }\n";
    const bodyEdit = "export default function () { return 2; }\n";
    const before = anchor(fn, "handler.ts");
    const after = anchor(bodyEdit, "handler.ts");
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.equal(before.signature, after.signature);
  });
});

// Extension-spec broadening: module-flavored TS is precise, declaration
// artifacts of ANY flavor are coarse, and module-flavored JS never reaches the
// precise adapter (it is coarse-gated like .js).
describe("module-flavored extensions", () => {
  it(".mts/.cts are precise; .d.mts/.d.cts classify as declaration files", () => {
    const code = "export function f(x: number) { return x + 1; }\n";
    assert.equal(classifyTsFile("src/loader.mts", code).mode, "precise");
    assert.equal(classifyTsFile("src/loader.cts", code).mode, "precise");
    assert.equal(classifyTsFile("src/types.d.mts", code).reason, "declaration file");
    assert.equal(classifyTsFile("src/types.d.cts", code).reason, "declaration file");
  });

  it("the adapter matches .mts/.cts but never a declaration variant or JS flavor", () => {
    assert.equal(tsAdapter.matches("src/loader.mts"), true);
    assert.equal(tsAdapter.matches("src/loader.cts"), true);
    assert.equal(tsAdapter.matches("src/types.d.mts"), false);
    assert.equal(tsAdapter.matches("src/types.d.cts"), false);
    assert.equal(tsAdapter.matches("src/types.d.ts"), false);
    assert.equal(tsAdapter.matches("next.config.mjs"), false);
    assert.equal(tsAdapter.matches("scripts/build.cjs"), false);
  });
});
