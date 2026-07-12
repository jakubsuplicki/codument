import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Anchor } from "../src/lib/fingerprint.js";
import {
  classifyCSharpFile,
  csharpAdapter,
  warmCSharpAdapter,
} from "../src/lib/csharp-adapter.js";
import { TreeSitterError } from "../src/lib/tree-sitter.js";
import { type AdapterHarness, checkAdapterConformance } from "./adapter-conformance.js";

const P = "src/Shapes.cs";

const BASE = `using System;

// helper stays internal to the file.
public class Shapes
{
    private static int Clamp(int n)
    {
        return n;
    }

    // Computes the clamped area.
    public int Area(int w, int h)
    {
        return Clamp(w * h);
    }

    public int Perimeter(int w, int h)
    {
        return 2 * (w + h);
    }
}

RegisterShapes("area", "perimeter");
`;

function anchors(content: string): Anchor[] {
  return csharpAdapter.anchors(P, content);
}

function byId(as: Anchor[], suffix: string): Anchor | undefined {
  return as.find((a) => a.id === `${P}::${suffix}`);
}

function residual(as: Anchor[]): Anchor | undefined {
  return as.find((a) => a.kind === "module");
}

describe("c# cold adapter", () => {
  it("fails loud when the gate path runs before the grammar is warmed", () => {
    assert.throws(
      () => csharpAdapter.anchors(P, "public class A {}\n"),
      (err: unknown) => {
        assert.ok(err instanceof TreeSitterError);
        assert.match(err.message, /warm/);
        return true;
      },
    );
  });
});

describe("c# anchor extraction", () => {
  before(async () => {
    await warmCSharpAdapter();
  });

  it("types anchor as frames; members individually; private members join the closure", () => {
    const as = anchors(BASE);
    assert.ok(byId(as, "Shapes#"), "type frame anchors");
    assert.ok(byId(as, "Shapes#Area()."), "public method anchors under its type");
    assert.ok(byId(as, "Shapes#Perimeter()."));
    assert.equal(byId(as, "Shapes#Clamp()."), undefined, "private member is the closure pool");
    // Private-helper edit wakes its public referencer.
    const after = anchors(BASE.replace("return n;", "return n + 0;"));
    assert.notEqual(byId(after, "Shapes#Area().")?.fingerprint, byId(anchors(BASE), "Shapes#Area().")?.fingerprint);
    assert.equal(byId(after, "Shapes#Perimeter().")?.fingerprint, byId(anchors(BASE), "Shapes#Perimeter().")?.fingerprint);
  });

  it("internal counts as public within the repo; nested types chain", () => {
    const src = `internal class Outer
{
    public class Inner
    {
        public int F() { return 1; }
    }
}
`;
    const as = anchors(src);
    assert.ok(byId(as, "Outer#"));
    assert.ok(byId(as, "Outer#Inner#"));
    assert.ok(byId(as, "Outer#Inner#F()."));
  });

  it("partial class fragments in one file fold into ONE type identity", () => {
    const src = `public partial class Server
{
    public void A() { }
}

public partial class Server
{
    public void B() { }
}
`;
    const as = anchors(src);
    assert.equal(as.filter((a) => a.id === `${P}::Server#`).length, 1, "one folded frame");
    assert.ok(byId(as, "Server#A()."));
    assert.ok(byId(as, "Server#B()."));
  });

  it("a property's accessor LIST is contract; accessor bodies and initializers are ackable body", () => {
    const src = `public class Server
{
    public string Addr { get; set; } = "localhost";
}
`;
    const base = anchors(src);
    const addr = byId(base, "Server#Addr.");
    assert.ok(addr?.signature);
    // Initializer edit: body only.
    const initEdit = anchors(src.replace('"localhost"', '"0.0.0.0"'));
    assert.notEqual(byId(initEdit, "Server#Addr.")?.fingerprint, addr?.fingerprint);
    assert.equal(byId(initEdit, "Server#Addr.")?.signature, addr?.signature);
    // set → init: accessor list is contract.
    const accEdit = anchors(src.replace("get; set;", "get; init;"));
    assert.notEqual(byId(accEdit, "Server#Addr.")?.signature, addr?.signature);
  });

  it("attributes are contract: adding one to a method moves the SIGNATURE", () => {
    const src = `public class Api
{
    public int Get() { return 1; }
}
`;
    const base = anchors(src);
    const attr = anchors(src.replace("public int Get()", "[Obsolete]\n    public int Get()"));
    assert.notEqual(byId(attr, "Api#Get().")?.signature, byId(base, "Api#Get().")?.signature);
  });

  it("record positional parameters are contract (the equality surface)", () => {
    const src = "public record Point(int X, int Y);\n";
    const base = anchors(src);
    const widened = anchors(src.replace("(int X, int Y)", "(int X, int Y, int Z)"));
    assert.notEqual(byId(widened, "Point#")?.signature, byId(base, "Point#")?.signature);
  });

  it("top-level statements ride the residual — Program.cs gates without a declared type", () => {
    const src = 'Console.WriteLine("hello");\nvar app = Build();\napp.Run();\n';
    const base = anchors(src);
    assert.ok(residual(base), "top-level statements must produce a residual");
    assert.equal(classifyCSharpFile(P, src).mode, "coarse");
    const edited = anchors(src.replace('"hello"', '"hi"'));
    assert.notEqual(residual(edited)?.fingerprint, residual(base)?.fingerprint);
  });

  it("classification: public members → precise; generated banner → coarse; parse error → unevaluable", () => {
    assert.equal(classifyCSharpFile(P, BASE).mode, "precise");
    assert.equal(
      classifyCSharpFile(P, "// <auto-generated> do not edit </auto-generated>\npublic class A { public int F() => 1; }\n").mode,
      "coarse",
    );
    assert.equal(classifyCSharpFile(P, "public class Broken {{{\n").mode, "unevaluable");
  });
});

describe("c# conformance battery — full", () => {
  before(async () => {
    await warmCSharpAdapter();
  });

  it("the C# adapter passes all eight behaviors", () => {
    const harness: AdapterHarness = {
      adapter: csharpAdapter,
      classify: (path, content) => classifyCSharpFile(path, content).mode,
      fixtures: {
        path: P,
        base: BASE,
        formatted: BASE.replace("// Computes the clamped area.", "// Reworded, same code.").replace(
          "    public int Perimeter(int w, int h)",
          "    public int Perimeter(int w, int h) // note",
        ),
        bodyEdit: {
          symbol: "Shapes#Perimeter",
          content: BASE.replace("return 2 * (w + h);", "return (w + h) * 2;"),
        },
        signatureEdit: {
          symbol: "Shapes#Perimeter",
          content: BASE.replace("Perimeter(int w, int h)", "Perimeter(int w, int h, int pad)"),
        },
        helperEdit: {
          symbol: "Shapes#Area",
          content: BASE.replace("return n;", "return n + 0;"),
        },
        residualEdit: BASE.replace('RegisterShapes("area", "perimeter")', 'RegisterShapes("area")'),
        reordered: BASE.replace(
          "    // Computes the clamped area.\n    public int Area(int w, int h)\n    {\n        return Clamp(w * h);\n    }\n\n    public int Perimeter(int w, int h)\n    {\n        return 2 * (w + h);\n    }",
          "    public int Perimeter(int w, int h)\n    {\n        return 2 * (w + h);\n    }\n\n    // Computes the clamped area.\n    public int Area(int w, int h)\n    {\n        return Clamp(w * h);\n    }",
        ),
        parseError: "public class Broken {{{\n",
      },
    };
    assert.deepEqual(checkAdapterConformance(harness), []);
  });
});
