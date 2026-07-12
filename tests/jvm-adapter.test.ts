import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Anchor } from "../src/lib/fingerprint.js";
import { classifyJvmFile, jvmAdapter, warmJvmAdapter } from "../src/lib/jvm-adapter.js";
import { TreeSitterError } from "../src/lib/tree-sitter.js";
import { type AdapterHarness, checkAdapterConformance } from "./adapter-conformance.js";

const JP = "src/Shapes.java";
const KP = "src/shapes.kt";

const JAVA_BASE = `package com.acme;

import java.util.List;

// Shapes is the file's one public type.
public class Shapes {
    private int clamp(int n) {
        return n;
    }

    // Computes the clamped area.
    public int area(int w, int h) {
        return clamp(w * h);
    }

    public int perimeter(int w, int h) {
        return 2 * (w + h);
    }
}
`;

const KOTLIN_BASE = `package com.acme

import kotlin.math.abs

private fun clamp(n: Int): Int {
    return abs(n)
}

// Computes the clamped area.
fun area(w: Int, h: Int): Int {
    return clamp(w * h)
}

fun perimeter(w: Int, h: Int): Int {
    return 2 * (w + h)
}

registerShapes("area", "perimeter")
`;

function jAnchors(content: string): Anchor[] {
  return jvmAdapter.anchors(JP, content);
}
function kAnchors(content: string): Anchor[] {
  return jvmAdapter.anchors(KP, content);
}
function byId(as: Anchor[], path: string, suffix: string): Anchor | undefined {
  return as.find((a) => a.id === `${path}::${suffix}`);
}
function residual(as: Anchor[]): Anchor | undefined {
  return as.find((a) => a.kind === "module");
}

describe("jvm cold adapter", () => {
  it("fails loud when the gate path runs before the grammars are warmed", () => {
    for (const [path, src] of [
      [JP, "public class A {}\n"],
      [KP, "fun a() {}\n"],
    ] as const) {
      assert.throws(
        () => jvmAdapter.anchors(path, src),
        (err: unknown) => {
          assert.ok(err instanceof TreeSitterError);
          assert.match(err.message, /warm/);
          return true;
        },
      );
    }
  });
});

describe("java anchor extraction", () => {
  before(async () => {
    await warmJvmAdapter();
  });

  it("types anchor as frames; public/protected members individually; private joins the closure", () => {
    const as = jAnchors(JAVA_BASE);
    assert.ok(byId(as, JP, "Shapes#"), "type frame anchors");
    assert.ok(byId(as, JP, "Shapes#area()."));
    assert.ok(byId(as, JP, "Shapes#perimeter()."));
    assert.equal(byId(as, JP, "Shapes#clamp()."), undefined, "private member is the closure pool");
    // Private-helper edit wakes only its public referencer.
    const after = jAnchors(JAVA_BASE.replace("return n;", "return n + 0;"));
    assert.notEqual(byId(after, JP, "Shapes#area().")?.fingerprint, byId(as, JP, "Shapes#area().")?.fingerprint);
    assert.equal(byId(after, JP, "Shapes#perimeter().")?.fingerprint, byId(as, JP, "Shapes#perimeter().")?.fingerprint);
  });

  it("package-private is NOT anchored — a bare Java default is not a declared contract", () => {
    const src = `public class Api {
    public int shown() { return hidden(); }
    int hidden() { return 1; }
}
`;
    const as = jAnchors(src);
    assert.ok(byId(as, JP, "Api#shown()."));
    assert.equal(byId(as, JP, "Api#hidden()."), undefined, "package-private member joins the pool");
    // But it still wakes its referencer through the closure.
    const after = jAnchors(src.replace("return 1;", "return 2;"));
    assert.notEqual(byId(after, JP, "Api#shown().")?.fingerprint, byId(as, JP, "Api#shown().")?.fingerprint);
  });

  it("protected anchors (inheritance contract); nested types chain; interface members are implicitly public", () => {
    const src = `public class Outer {
    protected int hook() { return 1; }
    public interface Inner {
        int f();
    }
}
`;
    const as = jAnchors(src);
    assert.ok(byId(as, JP, "Outer#hook()."), "protected is inheritance contract");
    assert.ok(byId(as, JP, "Outer#Inner#"));
    assert.ok(byId(as, JP, "Outer#Inner#f()."), "interface member anchors without a modifier");
  });

  it("annotations are contract: adding one to a method moves the SIGNATURE", () => {
    const src = `public class Api {
    public int get() { return 1; }
}
`;
    const base = jAnchors(src);
    const attr = jAnchors(src.replace("public int get()", "@Deprecated\n    public int get()"));
    assert.notEqual(byId(attr, JP, "Api#get().")?.signature, byId(base, JP, "Api#get().")?.signature);
  });

  it("overloads fold into one anchor per name; a body edit to one moves the folded fingerprint", () => {
    const src = `public class Api {
    public int f(int x) { return x; }
    public int f(int x, int y) { return x + y; }
}
`;
    const base = jAnchors(src);
    assert.equal(base.filter((a) => a.id === `${JP}::Api#f().`).length, 1, "overloads fold to one id");
    const edit = jAnchors(src.replace("return x + y;", "return y + x;"));
    assert.notEqual(byId(edit, JP, "Api#f().")?.fingerprint, byId(base, JP, "Api#f().")?.fingerprint);
  });

  it("a field's initializer is ackable body; its type is contract", () => {
    const src = `public class Api {
    public int port = 8080;
}
`;
    const base = jAnchors(src);
    const initEdit = jAnchors(src.replace("= 8080", "= 9090"));
    assert.notEqual(byId(initEdit, JP, "Api#port.")?.fingerprint, byId(base, JP, "Api#port.")?.fingerprint);
    assert.equal(byId(initEdit, JP, "Api#port.")?.signature, byId(base, JP, "Api#port.")?.signature);
    const typeEdit = jAnchors(src.replace("public int port", "public long port"));
    assert.notEqual(byId(typeEdit, JP, "Api#port.")?.signature, byId(base, JP, "Api#port.")?.signature);
  });

  it("enums anchor whole — the variants are the surface", () => {
    const src = "public enum Color { RED, GREEN }\n";
    const base = jAnchors(src);
    const added = jAnchors(src.replace("RED, GREEN", "RED, GREEN, BLUE"));
    assert.notEqual(byId(added, JP, "Color#")?.signature, byId(base, JP, "Color#")?.signature);
  });

  it("annotation-type elements anchor — an @interface's elements are its contract surface", () => {
    // Regression: elements are `annotation_type_element_declaration` nodes;
    // before the fix they fell into the coarse residual, so an element rename
    // (a breaking change at every use site) read as ackable churn.
    const src = `public @interface Route {
    String value();
    int code() default 200;
}
`;
    const base = jAnchors(src);
    assert.ok(byId(base, JP, "Route#value()."), "element anchors method-shaped");
    assert.ok(byId(base, JP, "Route#code()."));
    const renamed = jAnchors(src.replace("String value()", "String path()"));
    assert.equal(byId(renamed, JP, "Route#value()."), undefined, "rename retires the old anchor");
    assert.ok(byId(renamed, JP, "Route#path()."));
    const retyped = jAnchors(src.replace("int code()", "long code()"));
    assert.notEqual(byId(retyped, JP, "Route#code().")?.signature, byId(base, JP, "Route#code().")?.signature);
    // The default value is contract — omitting callers depend on it.
    const defaulted = jAnchors(src.replace("default 200", "default 404"));
    assert.notEqual(byId(defaulted, JP, "Route#code().")?.signature, byId(base, JP, "Route#code().")?.signature);
  });

  it("classification: public members → precise; generated banner → coarse; parse error → unevaluable", () => {
    assert.equal(classifyJvmFile(JP, JAVA_BASE).mode, "precise");
    assert.equal(
      classifyJvmFile(JP, "// <auto-generated>\npublic class A { public int f() { return 1; } }\n").mode,
      "coarse",
    );
    assert.equal(classifyJvmFile(JP, "public class Broken {{{\n").mode, "unevaluable");
  });
});

describe("kotlin anchor extraction", () => {
  before(async () => {
    await warmJvmAdapter();
  });

  it("default visibility IS public: a modifier-less top-level function anchors", () => {
    const as = kAnchors(KOTLIN_BASE);
    assert.ok(byId(as, KP, "area()."), "no modifier == public in Kotlin");
    assert.ok(byId(as, KP, "perimeter()."));
    assert.equal(byId(as, KP, "clamp()."), undefined, "an explicit private drops to the pool");
    // Private helper still wakes its referencer.
    const after = kAnchors(KOTLIN_BASE.replace("return abs(n)", "return abs(n) + 0"));
    assert.notEqual(byId(after, KP, "area().")?.fingerprint, byId(as, KP, "area().")?.fingerprint);
  });

  it("internal counts as public within the repo; private is the pool", () => {
    const src = `fun a() {}
internal fun b() {}
private fun c() {}
`;
    const as = kAnchors(src);
    assert.ok(byId(as, KP, "a()."));
    assert.ok(byId(as, KP, "b()."), "internal is the repo-audience surface");
    assert.equal(byId(as, KP, "c()."), undefined);
  });

  it("members chain under their type; companion and nested objects chain too", () => {
    const src = `class Server {
    fun handle(): Boolean {
        return true
    }

    companion object {
        fun create(): Server {
            return Server()
        }
    }

    object Nested {
        fun f() {}
    }
}
`;
    const as = kAnchors(src);
    assert.ok(byId(as, KP, "Server#"));
    assert.ok(byId(as, KP, "Server#handle()."));
    assert.ok(byId(as, KP, "Server#Companion#create()."));
    assert.ok(byId(as, KP, "Server#Nested#f()."));
  });

  it("a data class's primary-constructor parameters are contract (the equality surface)", () => {
    const src = "data class Point(val x: Int, val y: Int)\n";
    const base = kAnchors(src);
    const widened = kAnchors(src.replace("(val x: Int, val y: Int)", "(val x: Int, val y: Int, val z: Int)"));
    assert.notEqual(byId(widened, KP, "Point#")?.signature, byId(base, KP, "Point#")?.signature);
  });

  it("annotations are contract: removing @GetMapping moves a method's signature", () => {
    const src = `class Api {
    @GetMapping("/h")
    fun handle(): Boolean {
        return true
    }
}
`;
    const base = kAnchors(src);
    const stripped = kAnchors(src.replace('@GetMapping("/h")\n    ', ""));
    assert.notEqual(byId(stripped, KP, "Api#handle().")?.signature, byId(base, KP, "Api#handle().")?.signature);
  });

  it("a property's custom getter body is ackable; changing val→var is contract", () => {
    const src = `class Api {
    val computed: Int
        get() = compute()
}
`;
    const base = kAnchors(src);
    const bodyEdit = kAnchors(src.replace("get() = compute()", "get() = compute() + 0"));
    assert.notEqual(byId(bodyEdit, KP, "Api#computed.")?.fingerprint, byId(base, KP, "Api#computed.")?.fingerprint);
    assert.equal(byId(bodyEdit, KP, "Api#computed.")?.signature, byId(base, KP, "Api#computed.")?.signature);
    const varEdit = kAnchors(src.replace("val computed: Int", "var computed: Int"));
    assert.notEqual(byId(varEdit, KP, "Api#computed.")?.signature, byId(base, KP, "Api#computed.")?.signature);
  });

  it("enum variants are contract — adding or renaming one moves the type signature", () => {
    // Regression: the `ng` grammar nests the `enum` keyword under modifiers, so
    // a direct-child scan missed every Kotlin enum and dumped its variants into
    // the coarse residual — a breaking variant change read as ackable churn.
    const src = "enum class Color {\n    RED,\n    GREEN,\n}\n";
    const base = kAnchors(src);
    const added = kAnchors("enum class Color {\n    RED,\n    GREEN,\n    BLUE,\n}\n");
    assert.notEqual(byId(added, KP, "Color#")?.signature, byId(base, KP, "Color#")?.signature);
    const renamed = kAnchors("enum class Color {\n    CRIMSON,\n    GREEN,\n}\n");
    assert.notEqual(byId(renamed, KP, "Color#")?.signature, byId(base, KP, "Color#")?.signature);
  });

  it("a secondary constructor's block is ackable body; its parameters are contract", () => {
    const src = "class Api {\n    constructor(x: Int) {\n        println(x)\n    }\n}\n";
    const base = kAnchors(src);
    const bodyEdit = kAnchors(src.replace("println(x)", "println(x + 1)"));
    assert.notEqual(byId(bodyEdit, KP, "Api#constructor().")?.fingerprint, byId(base, KP, "Api#constructor().")?.fingerprint);
    assert.equal(byId(bodyEdit, KP, "Api#constructor().")?.signature, byId(base, KP, "Api#constructor().")?.signature);
    const paramEdit = kAnchors(src.replace("constructor(x: Int)", "constructor(x: Int, y: Int)"));
    assert.notEqual(byId(paramEdit, KP, "Api#constructor().")?.signature, byId(base, KP, "Api#constructor().")?.signature);
  });

  it("a const's value is ackable body; its type is contract", () => {
    const src = "const val MAX: Int = 10\n";
    const base = kAnchors(src);
    const valueEdit = kAnchors(src.replace("= 10", "= 20"));
    assert.notEqual(byId(valueEdit, KP, "MAX.")?.fingerprint, byId(base, KP, "MAX.")?.fingerprint);
    assert.equal(byId(valueEdit, KP, "MAX.")?.signature, byId(base, KP, "MAX.")?.signature);
    const typeEdit = kAnchors(src.replace("MAX: Int", "MAX: Long"));
    assert.notEqual(byId(typeEdit, KP, "MAX.")?.signature, byId(base, KP, "MAX.")?.signature);
  });

  it("top-level DSL scripts with no declarations classify coarse — the gradle.kts case", () => {
    const src = `plugins {
    kotlin("jvm") version "1.9.0"
}

dependencies {
    implementation("org.springframework:spring-core")
}
`;
    assert.equal(classifyJvmFile("build.gradle.kts", src).mode, "coarse");
  });

  it("classification: public declarations → precise; parse error → unevaluable", () => {
    assert.equal(classifyJvmFile(KP, KOTLIN_BASE).mode, "precise");
    assert.equal(classifyJvmFile(KP, "fun broken(( {\n").mode, "unevaluable");
  });
});

describe("jvm conformance battery — full, both grammars", () => {
  before(async () => {
    await warmJvmAdapter();
  });

  it("the adapter passes all eight behaviors on Java", () => {
    const harness: AdapterHarness = {
      adapter: jvmAdapter,
      classify: (path, content) => classifyJvmFile(path, content).mode,
      fixtures: {
        path: JP,
        base: JAVA_BASE,
        formatted: JAVA_BASE.replace("// Computes the clamped area.", "// Reworded, same code.").replace(
          "    public int perimeter(int w, int h) {",
          "    public int perimeter(int w, int h) { // note",
        ),
        bodyEdit: { symbol: "Shapes#perimeter", content: JAVA_BASE.replace("return 2 * (w + h);", "return (w + h) * 2;") },
        signatureEdit: {
          symbol: "Shapes#perimeter",
          content: JAVA_BASE.replace("perimeter(int w, int h)", "perimeter(int w, int h, int pad)"),
        },
        helperEdit: { symbol: "Shapes#area", content: JAVA_BASE.replace("return n;", "return n + 0;") },
        residualEdit: JAVA_BASE.replace("import java.util.List;", "import java.util.Map;"),
        reordered: JAVA_BASE.replace(
          "    // Computes the clamped area.\n    public int area(int w, int h) {\n        return clamp(w * h);\n    }\n\n    public int perimeter(int w, int h) {\n        return 2 * (w + h);\n    }",
          "    public int perimeter(int w, int h) {\n        return 2 * (w + h);\n    }\n\n    // Computes the clamped area.\n    public int area(int w, int h) {\n        return clamp(w * h);\n    }",
        ),
        parseError: "public class Broken {{{\n",
      },
    };
    assert.deepEqual(checkAdapterConformance(harness), []);
  });

  it("the adapter passes all eight behaviors on Kotlin", () => {
    const harness: AdapterHarness = {
      adapter: jvmAdapter,
      classify: (path, content) => classifyJvmFile(path, content).mode,
      fixtures: {
        path: KP,
        base: KOTLIN_BASE,
        formatted: KOTLIN_BASE.replace("// Computes the clamped area.", "// Reworded, same code.").replace(
          "fun perimeter(w: Int, h: Int): Int {",
          "fun perimeter(w: Int, h: Int): Int { // note",
        ),
        bodyEdit: { symbol: "perimeter", content: KOTLIN_BASE.replace("return 2 * (w + h)", "return (w + h) * 2") },
        signatureEdit: {
          symbol: "perimeter",
          content: KOTLIN_BASE.replace("fun perimeter(w: Int, h: Int): Int", "fun perimeter(w: Int, h: Int, pad: Int): Int"),
        },
        helperEdit: { symbol: "area", content: KOTLIN_BASE.replace("return abs(n)", "return abs(n) + 0") },
        residualEdit: KOTLIN_BASE.replace('registerShapes("area", "perimeter")', 'registerShapes("area")'),
        reordered: KOTLIN_BASE.replace(
          "// Computes the clamped area.\nfun area(w: Int, h: Int): Int {\n    return clamp(w * h)\n}\n\nfun perimeter(w: Int, h: Int): Int {\n    return 2 * (w + h)\n}",
          "fun perimeter(w: Int, h: Int): Int {\n    return 2 * (w + h)\n}\n\n// Computes the clamped area.\nfun area(w: Int, h: Int): Int {\n    return clamp(w * h)\n}",
        ),
        parseError: "fun broken(( {\n",
      },
    };
    assert.deepEqual(checkAdapterConformance(harness), []);
  });
});
