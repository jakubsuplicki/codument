import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Anchor } from "../src/lib/fingerprint.js";
import { classifyPyFile, pyAdapter, warmPythonAdapter } from "../src/lib/py-adapter.js";
import { TreeSitterError } from "../src/lib/tree-sitter.js";
import { type AdapterHarness, checkAdapterConformance } from "./adapter-conformance.js";

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

  it("a CHAINED assignment anchors every target; a later-target rename is never ackable body churn", () => {
    const as = anchors("x = y = 1\n");
    assert.ok(named(as, "x"), "x anchored");
    assert.ok(named(as, "y"), "y anchored — a chained target must never vanish");
    // The value is the shared ackable body: editing it moves both, sigs hold.
    const valueEdit = anchors("x = y = 2\n");
    assert.notEqual(named(valueEdit, "x")?.fingerprint, named(as, "x")?.fingerprint);
    assert.equal(named(valueEdit, "x")?.signature, named(as, "x")?.signature);
    // Renaming the LATER target is a contract event: y's anchor disappears and
    // x's SIGNATURE moves (the chain is x's contract), never a body-only move.
    const renamed = anchors("x = z = 1\n");
    assert.equal(named(renamed, "y"), undefined);
    assert.ok(named(renamed, "z"));
    assert.notEqual(named(renamed, "x")?.signature, named(as, "x")?.signature);
  });

  it("splatted and nested unpacking targets are all anchored", () => {
    const as = anchors("a, *rest = [1, 2, 3]\n(b, c), d = (4, 5), 6\n");
    for (const name of ["a", "rest", "b", "c", "d"]) {
      assert.ok(named(as, name), `${name} must be anchored`);
    }
  });

  it("a chained __all__ is dynamic — the surface is never guessed through a chain", () => {
    assert.equal(classifyPyFile(P, 'X = __all__ = ["a"]\n\ndef a():\n    return 1\n').mode, "coarse");
    assert.equal(classifyPyFile(P, '__all__ = X = ["a"]\n\ndef a():\n    return 1\n').mode, "coarse");
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

describe("python conformance battery — full", () => {
  before(async () => {
    await warmPythonAdapter();
  });

  it("the Python adapter passes all eight behaviors", () => {
    const pyHarness: AdapterHarness = {
      adapter: pyAdapter,
      classify: (path, content) => classifyPyFile(path, content).mode,
      fixtures: {
        path: P,
        base: BASE,
        formatted: BASE.replace("# area is clamped", "# reworded, same code").replace(
          "import math\n",
          "import math\n\n\n",
        ),
        bodyEdit: {
          symbol: "perimeter",
          content: BASE.replace("return 2 * (w + h)", "return (w + h) * 2"),
        },
        signatureEdit: {
          symbol: "perimeter",
          content: BASE.replace("def perimeter(w, h):", "def perimeter(w, h, pad=0):"),
        },
        helperEdit: {
          symbol: "area",
          content: BASE.replace("return 0 if n < 0 else n", "return 0 if n <= 0 else n"),
        },
        residualEdit: BASE.replace(
          'register_shapes("area", "perimeter")',
          'register_shapes("area")',
        ),
        reordered: BASE.replace(
          "def perimeter(w, h):\n    return 2 * (w + h)\n\ndef _hidden_but_public(x):\n    return x\n",
          "def _hidden_but_public(x):\n    return x\n\ndef perimeter(w, h):\n    return 2 * (w + h)\n",
        ),
        parseError: "def broken((:\n",
      },
    };
    assert.deepEqual(checkAdapterConformance(pyHarness), []);
  });
});

describe("python signature/body split — language-specific contract cases", () => {
  before(async () => {
    await warmPythonAdapter();
  });

  const pairOf = (content: string, name: string) => {
    const a = named(anchors(content), name);
    assert.ok(a, `${name} must be anchored`);
    assert.ok(a.signature, `${name} must carry a signature`);
    return a;
  };

  it("a decorator edit is a signature move", () => {
    const src = "@cache\ndef handler(x):\n    return x\n";
    const after = src.replace("@cache", "@lru_cache(maxsize=8)");
    assert.notEqual(pairOf(after, "handler").signature, pairOf(src, "handler").signature);
  });

  it("a default-value change is a signature move", () => {
    const src = "def f(x=1):\n    return x\n";
    const after = src.replace("x=1", "x=2");
    assert.notEqual(pairOf(after, "f").signature, pairOf(src, "f").signature);
  });

  it("a return-annotation change is a signature move", () => {
    const src = "def f(x) -> int:\n    return x\n";
    const after = src.replace("-> int", "-> str");
    assert.notEqual(pairOf(after, "f").signature, pairOf(src, "f").signature);
  });

  it("a docstring-only edit is body: fingerprint moves, signature holds", () => {
    const src = 'def f(x):\n    """Adds nothing."""\n    return x\n';
    const after = src.replace("Adds nothing.", "Reworded doc.");
    const was = pairOf(src, "f");
    const now = pairOf(after, "f");
    assert.notEqual(now.fingerprint, was.fingerprint);
    assert.equal(now.signature, was.signature);
  });

  it("a parameter rename is a signature move (no canonicalization in v1 — the plan-11 analog is a named follow-up)", () => {
    assert.notEqual(
      pairOf("def f(b):\n    return b\n", "f").signature,
      pairOf("def f(a):\n    return a\n", "f").signature,
    );
  });

  it("class: a method suite edit is body; a method signature edit is contract", () => {
    const base = pairOf(BASE, "Greeter");
    const suiteEdit = pairOf(BASE.replace('return f"hi {name}"', 'return f"yo {name}"'), "Greeter");
    assert.notEqual(suiteEdit.fingerprint, base.fingerprint);
    assert.equal(suiteEdit.signature, base.signature);
    const sigEdit = pairOf(
      BASE.replace("def greet(self, name):", "def greet(self, name, shout=False):"),
      "Greeter",
    );
    assert.notEqual(sigEdit.signature, base.signature);
  });

  it("class: a class-level assignment change is contract; the class docstring is body", () => {
    const base = pairOf(BASE, "Greeter");
    const attrEdit = pairOf(BASE.replace('unit = "m2"', 'unit = "ft2"'), "Greeter");
    assert.notEqual(attrEdit.signature, base.signature);
    const withDoc = BASE.replace("class Greeter:\n", 'class Greeter:\n    """Greets."""\n');
    const docBase = pairOf(withDoc, "Greeter");
    const docEdit = pairOf(withDoc.replace("Greets.", "Greets, reworded."), "Greeter");
    assert.notEqual(docEdit.fingerprint, docBase.fingerprint);
    assert.equal(docEdit.signature, docBase.signature);
  });

  it("module assignment: the VALUE is ackable body, the target and annotation are contract (the settings-file calibration)", () => {
    const src = "DEBUG = True\nTIMEOUT: int = 30\n";
    const valueEdit = pairOf(src.replace("True", "False"), "DEBUG");
    const base = pairOf(src, "DEBUG");
    assert.notEqual(valueEdit.fingerprint, base.fingerprint);
    assert.equal(valueEdit.signature, base.signature);
    const annBase = pairOf(src, "TIMEOUT");
    const annEdit = pairOf(src.replace("TIMEOUT: int", "TIMEOUT: float"), "TIMEOUT");
    assert.notEqual(annEdit.signature, annBase.signature);
  });

  it("sig wins ties: a helper reachable from a default value moves the SIGNATURE", () => {
    const src = "_DEFAULT = 5\n\ndef f(x=_DEFAULT):\n    return x\n";
    const after = src.replace("_DEFAULT = 5", "_DEFAULT = 6");
    assert.notEqual(pairOf(after, "f").signature, pairOf(src, "f").signature);
  });

  it("the helper closure is transitive", () => {
    const src =
      "def _b(n):\n    return n + 1\n\ndef _a(n):\n    return _b(n)\n\ndef g(n):\n    return _a(n)\n";
    const after = src.replace("return n + 1", "return n + 2");
    assert.notEqual(pairOf(after, "g").fingerprint, pairOf(src, "g").fingerprint);
  });

  it("a covered private leaves the residual; editing it never wakes the residual", () => {
    const base = anchors(BASE);
    const after = anchors(BASE.replace("_SCALE = 3", "_SCALE = 4"));
    assert.notEqual(named(after, "area")?.fingerprint, named(base, "area")?.fingerprint);
    assert.equal(residual(after)?.fingerprint, residual(base)?.fingerprint);
    assert.equal(named(after, "perimeter")?.fingerprint, named(base, "perimeter")?.fingerprint);
  });
});
