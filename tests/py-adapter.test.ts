import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Anchor } from "../src/lib/fingerprint.js";
import { classifyPyFile, pyAdapter, warmPythonAdapter } from "../src/lib/py-adapter.js";
import { TreeSitterError } from "../src/lib/tree-sitter.js";

const P = "src/shapes.py";

const BASE = `"""Shape helpers."""
import math

__all__ = ["area", "perimeter", "Greeter", "_hidden_but_public"]

_SCALE = 3

def _clamp(n):
    return 0 if n < 0 else n

def area(w, h):
    # area is clamped
    return _clamp(w * h) * _SCALE

def perimeter(w, h):
    return 2 * (w + h)

def _hidden_but_public(x):
    return x

class Greeter:
    unit = "m2"

    def greet(self, name):
        return f"hi {name}"

register_shapes("area", "perimeter")
`;

function anchors(content: string): Anchor[] {
  return pyAdapter.anchors(P, content);
}

function named(as: Anchor[], name: string): Anchor | undefined {
  return as.find((a) => a.kind !== "module" && a.name === name);
}

function residual(as: Anchor[]): Anchor | undefined {
  return as.find((a) => a.kind === "module");
}

// Must run BEFORE any warm in this process: a cold adapter is a loud error,
// never a silent coarse verdict.
describe("cold adapter", () => {
  it("fails loud when the gate path runs before the grammar is warmed", () => {
    assert.throws(
      () => pyAdapter.anchors(P, "x = 1\n"),
      (err: unknown) => {
        assert.ok(err instanceof TreeSitterError);
        assert.match(err.message, /warm/);
        return true;
      },
    );
  });
});

describe("python anchor extraction", () => {
  before(async () => {
    await warmPythonAdapter();
  });

  it("matches .py and .pyi, nothing else", () => {
    assert.ok(pyAdapter.matches("src/app.py"));
    assert.ok(pyAdapter.matches("src/app.pyi"));
    assert.ok(!pyAdapter.matches("src/app.ts"));
    assert.ok(!pyAdapter.matches("src/app.pyc"));
  });

  it("emits SCIP-shaped anchors: def → name()., class → Name#, assignment → name.", () => {
    const as = anchors(BASE);
    assert.equal(named(as, "area")?.id, `${P}::area().`);
    assert.equal(named(as, "perimeter")?.id, `${P}::perimeter().`);
    assert.equal(named(as, "Greeter")?.id, `${P}::Greeter#`);
    assert.equal(residual(as)?.id, `${P}::<module>`);
  });

  it("a static __all__ IS the public surface — listed names public even underscore-prefixed, unlisted private", () => {
    const as = anchors(BASE);
    assert.ok(named(as, "_hidden_but_public"), "__all__ member must be anchored");
    assert.equal(named(as, "_SCALE"), undefined, "unlisted assignment is private");
    assert.equal(named(as, "_clamp"), undefined, "unlisted def is private");
  });

  it("without __all__, the underscore convention decides", () => {
    const as = anchors('def area(w, h):\n    return w * h\n\ndef _clamp(n):\n    return n\n\nunit = "m2"\n');
    assert.ok(named(as, "area"));
    assert.ok(named(as, "unit"));
    assert.equal(named(as, "_clamp"), undefined);
  });

  it("a class is ONE anchor — members are not separate anchors", () => {
    const as = anchors(BASE);
    assert.equal(named(as, "greet"), undefined);
    assert.equal(named(as, "unit"), undefined);
  });

  it("a multi-target assignment yields one anchor per name, spanning the whole statement", () => {
    const as = anchors("x, y = 1, 2\n");
    const x = named(as, "x");
    const y = named(as, "y");
    assert.ok(x && y);
    assert.equal(x.id, `${P}::x.`);
    // Same span → same fingerprint; identity differs.
    assert.equal(x.fingerprint, y.fingerprint);
    // Editing the statement moves both.
    const after = anchors("x, y = 1, 3\n");
    assert.notEqual(named(after, "x")?.fingerprint, x.fingerprint);
    assert.notEqual(named(after, "y")?.fingerprint, y.fingerprint);
  });

  it("same-name defs merge into one run (an @overload stack is one surface)", () => {
    const src =
      "from typing import overload\n\n@overload\ndef f(x: int) -> int: ...\n@overload\ndef f(x: str) -> str: ...\ndef f(x):\n    return x\n";
    const as = anchors(src);
    assert.equal(as.filter((a) => a.name === "f").length, 1);
    // Editing one overload stub moves the single anchor.
    const after = anchors(src.replace("def f(x: str) -> str", "def f(x: bytes) -> bytes"));
    assert.notEqual(named(after, "f")?.fingerprint, named(as, "f")?.fingerprint);
  });
});

describe("python battery behaviors (step-1 subset: 1, 5, 6, 7, 8)", () => {
  before(async () => {
    await warmPythonAdapter();
  });

  it("1 — comment and formatting churn moves NO fingerprint", () => {
    const formatted = BASE.replace("# area is clamped", "# reworded comment, same code")
      .replace("def perimeter(w, h):", "def perimeter(w, h):  # inline note")
      .replace("import math\n", "import math\n\n\n");
    const a = anchors(BASE);
    const b = anchors(formatted);
    assert.deepEqual(
      new Map(a.map((x) => [x.id, x.fingerprint])),
      new Map(b.map((x) => [x.id, x.fingerprint])),
    );
  });

  it("5 — uncovered content lands in the residual; editing it moves ONLY the residual", () => {
    const after = anchors(
      BASE.replace('register_shapes("area", "perimeter")', 'register_shapes("area")'),
    );
    const base = anchors(BASE);
    assert.notEqual(residual(after)?.fingerprint, residual(base)?.fingerprint);
    for (const a of base.filter((x) => x.kind !== "module")) {
      assert.equal(named(after, a.name)?.fingerprint, a.fingerprint, `${a.name} must hold`);
    }
  });

  it("5a — a module docstring edit is residual BODY: fingerprint moves, __all__ signature holds", () => {
    const base = anchors(BASE);
    const after = anchors(BASE.replace('"""Shape helpers."""', '"""Shape helpers, reworded."""'));
    assert.notEqual(residual(after)?.fingerprint, residual(base)?.fingerprint);
    assert.ok(residual(base)?.signature, "static __all__ must give the residual a signature side");
    assert.equal(residual(after)?.signature, residual(base)?.signature);
  });

  it("5b — an __all__ edit moves the residual SIGNATURE (contract)", () => {
    const base = anchors(BASE);
    const after = anchors(BASE.replace('"perimeter", ', ""));
    assert.notEqual(residual(after)?.signature, residual(base)?.signature);
    assert.notEqual(residual(after)?.fingerprint, residual(base)?.fingerprint);
  });

  it("6 — a parse error classifies unevaluable (tree-sitter is error-recovering; this is explicit)", () => {
    assert.equal(classifyPyFile(P, "def broken((:\n").mode, "unevaluable");
  });

  it("6a — classification: public symbols → precise; script/side-effect module → coarse; dynamic __all__ → coarse", () => {
    assert.equal(classifyPyFile(P, BASE).mode, "precise");
    assert.equal(classifyPyFile(P, 'print("hello")\n').mode, "coarse");
    assert.equal(classifyPyFile(P, "").mode, "coarse");
    const dynamicAll = '__all__ = ["a"] + _extra\n\ndef a():\n    return 1\n';
    const klass = classifyPyFile(P, dynamicAll);
    assert.equal(klass.mode, "coarse");
    assert.match(klass.reason, /dynamic __all__|no public/);
    // And the anchor set is residual-only: gated whole, never guessed at.
    const as = pyAdapter.anchors(P, dynamicAll);
    assert.equal(as.length, 1);
    assert.equal(as[0].kind, "module");
  });

  it("6b — a generated banner classifies coarse", () => {
    assert.equal(classifyPyFile(P, "# @generated by protoc\ndef a():\n    return 1\n").mode, "coarse");
  });

  it("7 — anchor identity is position-independent: reordering declarations moves nothing", () => {
    const reordered = `"""Shape helpers."""
import math

__all__ = ["area", "perimeter", "Greeter", "_hidden_but_public"]

_SCALE = 3

def _clamp(n):
    return 0 if n < 0 else n

def perimeter(w, h):
    return 2 * (w + h)

class Greeter:
    unit = "m2"

    def greet(self, name):
        return f"hi {name}"

def area(w, h):
    # area is clamped
    return _clamp(w * h) * _SCALE

def _hidden_but_public(x):
    return x

register_shapes("area", "perimeter")
`;
    const a = anchors(BASE);
    const b = anchors(reordered);
    for (const x of a.filter((n) => n.kind !== "module")) {
      assert.equal(named(b, x.name)?.fingerprint, x.fingerprint, `${x.name} must hold`);
    }
  });

  it("8 — byte-determinism: identical output across runs; CRLF + BOM re-encoding changes nothing", () => {
    const a = anchors(BASE);
    const b = anchors(BASE);
    assert.deepEqual(a, b);
    const crlfBom = "\uFEFF" + BASE.replace(/\n/g, "\r\n");
    assert.deepEqual(anchors(crlfBom), a);
  });
});
