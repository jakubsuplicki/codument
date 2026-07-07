import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ts from "typescript";
import { canonicalizeDecls, renderWithCanon } from "../src/lib/ts-canonicalize.js";

// Canonicalize the first top-level statement and render it back to text with every
// locally-bound identifier replaced by its positional index. Two declarations that
// differ ONLY by a local rename render to the same string (⇒ the same token-stream
// hash once wired); any real difference renders differently. Whitespace is held
// identical across each compared pair, so a string compare is the token compare.
function canon(src: string): string {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const stmt = sf.statements[0];
  const map = canonicalizeDecls(sf, [stmt]);
  return renderWithCanon(src, stmt.getStart(sf), stmt.getEnd(), map);
}
const same = (a: string, b: string, msg?: string) => assert.equal(canon(a), canon(b), msg);
const diff = (a: string, b: string, msg?: string) => assert.notEqual(canon(a), canon(b), msg);

describe("canonicalize — rename invariance (the false-fire this kills)", () => {
  it("a local const/let rename is invariant", () => {
    same(
      "export function f() { const x = compute(); return x + 1; }",
      "export function f() { const total = compute(); return total + 1; }",
    );
  });

  it("a parameter rename and its uses are invariant", () => {
    same(
      "export function f(a: number): number { return a * a; }",
      "export function f(value: number): number { return value * value; }",
    );
  });

  it("an arrow-const parameter rename is invariant", () => {
    same(
      "export const f = (a: number) => a + 1;",
      "export const f = (n: number) => n + 1;",
    );
  });

  it("a closure capturing a sibling local is invariant under the local's rename", () => {
    same(
      "export function f() { const a = 1; return () => a; }",
      "export function f() { const seed = 1; return () => seed; }",
    );
  });

  it("a generic type-parameter rename is invariant", () => {
    same(
      "export function f<T>(x: T): T { return x; }",
      "export function f<Elem>(x: Elem): Elem { return x; }",
    );
  });

  it("a catch-clause binding rename is invariant", () => {
    same(
      "export function f() { try { go(); } catch (e) { return e; } }",
      "export function f() { try { go(); } catch (err) { return err; } }",
    );
  });

  it("an array-destructuring binding rename is invariant", () => {
    same(
      "export function f(pair: [number, number]) { const [a, b] = pair; return a + b; }",
      "export function f(pair: [number, number]) { const [lo, hi] = pair; return lo + hi; }",
    );
  });

  it("an explicit `{ key: local }` destructured local rename is invariant", () => {
    same(
      "export function f(o: any) { const { key: v } = o; return v; }",
      "export function f(o: any) { const { key: bound } = o; return bound; }",
    );
  });

  it("a for-loop variable rename is invariant", () => {
    same(
      "export function f(n: number) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }",
      "export function f(n: number) { let s = 0; for (let k = 0; k < n; k++) s += k; return s; }",
    );
  });

  it("a computed-key reference to a local is invariant under the local's rename", () => {
    same(
      "export function f() { const k = 'a'; return { [k]: 1 }; }",
      "export function f() { const prop = 'a'; return { [prop]: 1 }; }",
    );
  });
});

describe("canonicalize — soundness (renames that ARE real changes still differ)", () => {
  it("renaming a FREE (module/imported/global) reference still differs — never laundered", () => {
    diff(
      "export function f() { return helper(); }",
      "export function f() { return other(); }",
    );
  });

  it("a parameter TYPE change still differs (only the name canonicalizes)", () => {
    diff(
      "export function f(a: number): number { return a; }",
      "export function f(a: string): number { return a; }",
    );
  });

  it("a use pointing at a DIFFERENT local differs (not just any rename)", () => {
    diff(
      "export function f() { const a = 1; const b = 2; return a; }",
      "export function f() { const a = 1; const b = 2; return b; }",
    );
  });

  it("an object-literal key stays literal (a key rename is a real change)", () => {
    diff(
      "export const o = { alpha: 1 };",
      "export const o = { beta: 1 };",
    );
  });

  it("object-destructuring SHORTHAND stays literal (it selects a named member)", () => {
    diff(
      "export function f(o: any) { const { port } = o; return port; }",
      "export function f(o: any) { const { host } = o; return host; }",
    );
  });

  it("a property-access member name stays literal", () => {
    diff(
      "export function f(o: any) { return o.alpha; }",
      "export function f(o: any) { return o.beta; }",
    );
  });

  it("the anchored declaration's OWN exported name is never canonicalized", () => {
    // `f` vs `g` are the anchor identity / contract — they must NOT collapse.
    diff("export function f() { return 1; }", "export function g() { return 1; }");
    diff("export const f = 1;", "export const g = 1;");
  });
});

describe("canonicalize — block scoping (an inner binding never leaks to an outer use)", () => {
  it("an outer use of a name is FREE, not the inner block binding of the same name", () => {
    // `return x` sits OUTSIDE the block, so it references a free/global `x`, not the
    // dead block-scoped `x`. If the inner binding leaked, both of these would
    // canonicalize `return x` to the same index and collide — a false negative.
    // They must stay DIFFERENT because they return two DISTINCT globals (x vs z).
    diff(
      "export function f() { { let x = 1; } return x; }",
      "export function f() { { let z = 1; } return z; }",
    );
  });

  it("renaming a dead inner block local is still invariant (it is a true local)", () => {
    same(
      "export function f() { { let x = 1; } return globalThing; }",
      "export function f() { { let y = 1; } return globalThing; }",
    );
  });

  it("inner shadows outer: renaming the inner binding + its uses is invariant", () => {
    same(
      "export function f() { let x = 1; { let x = 2; return x; } }",
      "export function f() { let x = 1; { let inner = 2; return inner; } }",
    );
  });

  it("a param default cannot see a body local of the same name (stays free)", () => {
    // `a = x` is evaluated in the param scope; the body's `let x` is not visible
    // there, so `x` in the default is a free reference and a body-local rename must
    // not change it. These differ because the default references distinct frees.
    diff(
      "export function f(a: number = x) { let x = 1; return a; }",
      "export function f(a: number = z) { let z = 1; return a; }",
    );
  });
});

describe("canonicalize — soundness holes closed (adversarial review regressions)", () => {
  it("object-literal shorthand is a contract key — a rename that changes it still fires", () => {
    // `{ port }` desugars to `{ port: port }`; renaming the local renames the
    // emitted object's KEY (an externally-observable shape), so it must not collapse.
    diff(
      "export function f() { const port = 1; return { port }; }",
      "export function f() { const host = 1; return { host }; }",
    );
    diff(
      "export function f(port: number) { return { port }; }",
      "export function f(host: number) { return { host }; }",
    );
  });

  it("a `let` in a switch case does not leak to an outer binding of the same name", () => {
    // return-in-clause resolves to the inner case `let y`; the other returns a
    // distinct outer binding — different meaning, must not collide.
    diff(
      "export function f() { let y = 1; switch (g()) { case 1: let y = 2; return y; } }",
      "export function f() { let w = 1; switch (g()) { case 1: let y = 2; return w; } }",
    );
    // ...and renaming a case-clause local + its uses IS invariant (the fix also
    // makes the case block a real scope, so the rename now canonicalizes).
    same(
      "export function f() { switch (g()) { case 1: { let y = 2; return y; } } }",
      "export function f() { switch (g()) { case 1: { let z = 2; return z; } } }",
    );
  });

  it("a free identifier spelled like the sentinel ($0) never collides with a canonical index", () => {
    // reproB discards the local and returns an unrelated global named `$0`; the
    // local canonicalizes to `$0`, so without escaping these would collide.
    diff(
      "export function f() { const x = compute(); return x; }",
      "export function f() { const x = compute(); return $0; }",
    );
  });

  it("a constructor parameter property is a public member — its rename still fires", () => {
    diff(
      "export class C { constructor(public port: number) {} }",
      "export class C { constructor(public host: number) {} }",
    );
    diff(
      "export class C { constructor(readonly port: number) {} }",
      "export class C { constructor(readonly host: number) {} }",
    );
    // a PLAIN constructor parameter (no modifier) is a true local — still invariant.
    same(
      "export class C { m: number; constructor(port: number) { this.m = port; } }",
      "export class C { m: number; constructor(host: number) { this.m = host; } }",
    );
  });

  it("a block-scoped `using` binding is collected — it neither leaks nor fails to canonicalize", () => {
    // leak guard: the inner `using y` shadows the outer `let y`; a use resolving to
    // the inner resource must differ from a use resolving to the outer binding.
    diff(
      "export function f() { let y = 1; { using y = open(); return y; } }",
      "export function f() { let w = 1; { using y = open(); return w; } }",
    );
    // rename invariance: `using` is block-scoped like const, so renaming it is safe.
    same(
      "export function f() { using a = open(); return a; }",
      "export function f() { using res = open(); return res; }",
    );
  });

  it("a `for (using x of ...)` header binding is collected too (leak guard + invariance)", () => {
    diff(
      "export function f(it: any) { let y = 1; for (using y of it) { return y; } }",
      "export function f(it: any) { let w = 1; for (using y of it) { return w; } }",
    );
    same(
      "export function f(it: any) { for (using a of it) { use(a); } }",
      "export function f(it: any) { for (using r of it) { use(r); } }",
    );
  });
});

describe("canonicalize — determinism", () => {
  it("is idempotent for the same input", () => {
    const src = "export function f<T>(a: T, b: T) { const t = a; return [t, b]; }";
    assert.equal(canon(src), canon(src));
  });

  it("a `var` is left literal (hoisting is not modelled — the sound choice)", () => {
    // `var` rename still fires: documented narrow guarantee, not a bug.
    diff(
      "export function f() { var x = 1; return x; }",
      "export function f() { var y = 1; return y; }",
    );
  });
});
