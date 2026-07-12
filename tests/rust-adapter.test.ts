import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Anchor } from "../src/lib/fingerprint.js";
import { classifyRustFile, rustAdapter, warmRustAdapter } from "../src/lib/rust-adapter.js";
import { TreeSitterError } from "../src/lib/tree-sitter.js";
import { type AdapterHarness, checkAdapterConformance } from "./adapter-conformance.js";

const P = "src/shapes.rs";

const BASE = `use std::fmt;

// clamp keeps sizes sane.
fn clamp(n: usize) -> usize {
    n
}

/// Computes the clamped area.
pub fn area(w: usize, h: usize) -> usize {
    clamp(w * h)
}

pub fn perimeter(w: usize, h: usize) -> usize {
    2 * (w + h)
}

register_shapes!(area, perimeter);
`;

function anchors(content: string): Anchor[] {
  return rustAdapter.anchors(P, content);
}

function named(as: Anchor[], name: string): Anchor | undefined {
  return as.find((a) => a.kind !== "module" && a.name === name);
}

function residual(as: Anchor[]): Anchor | undefined {
  return as.find((a) => a.kind === "module");
}

describe("rust cold adapter", () => {
  it("fails loud when the gate path runs before the grammar is warmed", () => {
    assert.throws(
      () => rustAdapter.anchors(P, "pub fn a() {}\n"),
      (err: unknown) => {
        assert.ok(err instanceof TreeSitterError);
        assert.match(err.message, /warm/);
        return true;
      },
    );
  });
});

describe("rust anchor extraction", () => {
  before(async () => {
    await warmRustAdapter();
  });

  it("any pub form makes an anchor; non-pub is the closure pool", () => {
    const src = "pub fn a() {}\npub(crate) fn b() {}\npub(super) fn c() {}\nfn d() {}\n";
    const as = anchors(src);
    assert.ok(named(as, "a"));
    assert.ok(named(as, "b"), "pub(crate) is load-bearing inside the repo");
    assert.ok(named(as, "c"));
    assert.equal(named(as, "d"), undefined);
  });

  it("inherent-impl members anchor as Type#method().; private members join the closure", () => {
    const src = `pub struct Server;

impl Server {
    pub fn handle(&self) -> bool {
        self.secret() > 0
    }
    fn secret(&self) -> u8 {
        0
    }
}
`;
    const as = anchors(src);
    const handle = as.find((a) => a.id === `${P}::Server#handle().`);
    assert.ok(handle, "impl member must anchor under its type");
    assert.equal(named(as, "secret"), undefined);
    // Private-method edit wakes its public referencer via closure.
    const after = anchors(src.replace("0\n", "1\n"));
    assert.notEqual(
      after.find((a) => a.id === `${P}::Server#handle().`)?.fingerprint,
      handle?.fingerprint,
    );
  });

  it("trait impls anchor under a trait-qualified identity — a trait-impl swap is its own event", () => {
    const src = `use std::fmt;

pub struct Server;

impl fmt::Display for Server {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "server")
    }
}
`;
    const as = anchors(src);
    assert.ok(
      as.find((a) => a.id === `${P}::Server#fmt::Display::fmt().`),
      `trait-impl member must carry the trait in its identity, got: ${as.map((a) => a.id)}`,
    );
  });

  it("derives are contract: adding one moves the SIGNATURE", () => {
    const src = "#[derive(Debug)]\npub struct Point {\n    pub x: i32,\n}\n";
    const base = anchors(src);
    const withClone = anchors(src.replace("#[derive(Debug)]", "#[derive(Debug, Clone)]"));
    assert.notEqual(named(withClone, "Point")?.signature, named(base, "Point")?.signature);
  });

  it("struct calibration: pub fields are contract, private fields are ackable body", () => {
    const src = "pub struct Server {\n    pub addr: String,\n    name: String,\n}\n";
    const base = anchors(src);
    const privEdit = anchors(src.replace("name: String", "name: Vec<u8>"));
    assert.notEqual(named(privEdit, "Server")?.fingerprint, named(base, "Server")?.fingerprint);
    assert.equal(named(privEdit, "Server")?.signature, named(base, "Server")?.signature);
    const pubEdit = anchors(src.replace("addr: String", "addr: Vec<u8>"));
    assert.notEqual(named(pubEdit, "Server")?.signature, named(base, "Server")?.signature);
  });

  it("enum variants are all signature — they are the type's surface", () => {
    const src = "pub enum Status {\n    Active,\n    Paused,\n}\n";
    const base = anchors(src);
    const variantAdd = anchors(src.replace("Paused,", "Paused,\n    Stopped,"));
    assert.notEqual(named(variantAdd, "Status")?.signature, named(base, "Status")?.signature);
  });

  it("a where-clause addition is a signature move", () => {
    const src = "pub fn take<T>(x: T) -> T {\n    x\n}\n";
    const after = anchors(src.replace("pub fn take<T>(x: T) -> T", "pub fn take<T>(x: T) -> T\nwhere\n    T: Clone,"));
    assert.notEqual(named(after, "take")?.signature, named(anchors(src), "take")?.signature);
  });

  it("a macro definition is one all-signature anchor; item-position invocations ride the residual", () => {
    const src = "macro_rules! log_it {\n    ($x:expr) => { println!(\"{}\", $x) };\n}\n\npub fn a() {}\n";
    const base = anchors(src);
    assert.ok(named(base, "log_it"), "a macro IS contract");
    const macroEdit = anchors(src.replace("println!", "eprintln!"));
    assert.notEqual(named(macroEdit, "log_it")?.signature, named(base, "log_it")?.signature);
    // Invocation at item position (in BASE fixture) lands in residual:
    const inv = anchors(BASE);
    assert.ok(residual(inv));
    const invEdit = anchors(BASE.replace("register_shapes!(area, perimeter)", "register_shapes!(area)"));
    assert.notEqual(residual(invEdit)?.fingerprint, residual(inv)?.fingerprint);
  });

  it("const/static: the value is ackable body; name and type are contract", () => {
    const src = "pub const MAX: usize = 10;\n";
    const base = anchors(src);
    const valueEdit = anchors(src.replace("= 10", "= 20"));
    assert.notEqual(named(valueEdit, "MAX")?.fingerprint, named(base, "MAX")?.fingerprint);
    assert.equal(named(valueEdit, "MAX")?.signature, named(base, "MAX")?.signature);
    const typeEdit = anchors(src.replace("usize", "u32"));
    assert.notEqual(named(typeEdit, "MAX")?.signature, named(base, "MAX")?.signature);
  });

  it("classification: pub items → precise; generated banner / private-only → coarse; parse error → unevaluable", () => {
    assert.equal(classifyRustFile(P, BASE).mode, "precise");
    assert.equal(classifyRustFile(P, "fn helper() {}\n").mode, "coarse");
    assert.equal(
      classifyRustFile(P, "// @generated by build.rs — do not edit\npub fn a() {}\n").mode,
      "coarse",
    );
    assert.equal(classifyRustFile(P, "pub fn broken(( {\n").mode, "unevaluable");
  });
});

describe("rust conformance battery — full", () => {
  before(async () => {
    await warmRustAdapter();
  });

  it("the Rust adapter passes all eight behaviors", () => {
    const harness: AdapterHarness = {
      adapter: rustAdapter,
      classify: (path, content) => classifyRustFile(path, content).mode,
      fixtures: {
        path: P,
        base: BASE,
        formatted: BASE.replace("// clamp keeps sizes sane.", "// reworded, same code").replace(
          "pub fn perimeter(w: usize, h: usize) -> usize {",
          "pub fn perimeter(w: usize, h: usize) -> usize { // inline note",
        ),
        bodyEdit: {
          symbol: "perimeter",
          content: BASE.replace("2 * (w + h)", "(w + h) * 2"),
        },
        signatureEdit: {
          symbol: "perimeter",
          content: BASE.replace(
            "pub fn perimeter(w: usize, h: usize) -> usize {",
            "pub fn perimeter(w: usize, h: usize, pad: usize) -> usize {",
          ),
        },
        helperEdit: {
          symbol: "area",
          content: BASE.replace("    n\n", "    n + 0\n"),
        },
        residualEdit: BASE.replace("register_shapes!(area, perimeter)", "register_shapes!(area)"),
        reordered: BASE.replace(
          "/// Computes the clamped area.\npub fn area(w: usize, h: usize) -> usize {\n    clamp(w * h)\n}\n\npub fn perimeter(w: usize, h: usize) -> usize {\n    2 * (w + h)\n}",
          "pub fn perimeter(w: usize, h: usize) -> usize {\n    2 * (w + h)\n}\n\n/// Computes the clamped area.\npub fn area(w: usize, h: usize) -> usize {\n    clamp(w * h)\n}",
        ),
        parseError: "pub fn broken(( {\n",
      },
    };
    assert.deepEqual(checkAdapterConformance(harness), []);
  });
});
