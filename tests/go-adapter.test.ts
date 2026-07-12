import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Anchor } from "../src/lib/fingerprint.js";
import { classifyGoFile, goAdapter, warmGoAdapter } from "../src/lib/go-adapter.js";
import { TreeSitterError } from "../src/lib/tree-sitter.js";
import { type AdapterHarness, checkAdapterConformance } from "./adapter-conformance.js";

const P = "internal/shapes.go";

const BASE = `package shapes

import "fmt"

// clamp keeps sizes sane.
func clamp(n int) int {
	return n
}

// Area computes the clamped area.
func Area(w, h int) int {
	return clamp(w * h)
}

func Perimeter(w, h int) int {
	return 2 * (w + h)
}

func init() { fmt.Println("shapes ready") }
`;

function anchors(content: string): Anchor[] {
  return goAdapter.anchors(P, content);
}

function named(as: Anchor[], name: string): Anchor | undefined {
  return as.find((a) => a.kind !== "module" && a.name === name);
}

function residual(as: Anchor[]): Anchor | undefined {
  return as.find((a) => a.kind === "module");
}

describe("go cold adapter", () => {
  it("fails loud when the gate path runs before the grammar is warmed", () => {
    assert.throws(
      () => goAdapter.anchors(P, "package x\n"),
      (err: unknown) => {
        assert.ok(err instanceof TreeSitterError);
        assert.match(err.message, /warm/);
        return true;
      },
    );
  });
});

describe("go anchor extraction", () => {
  before(async () => {
    await warmGoAdapter();
  });

  it("matches .go only, and _test.go files are outside the source spec", () => {
    assert.ok(goAdapter.matches("cmd/main.go"));
    assert.ok(!goAdapter.matches("main.rs"));
  });

  it("capitalization IS the law: exported anchors, unexported closure pool", () => {
    const as = anchors(BASE);
    assert.equal(named(as, "Area")?.id, `${P}::Area().`);
    assert.equal(named(as, "Perimeter")?.id, `${P}::Perimeter().`);
    assert.equal(named(as, "clamp"), undefined, "unexported func is the closure pool");
    assert.equal(named(as, "init"), undefined, "init is never an anchor");
  });

  it("methods anchor under their receiver; pointer and value receivers share ONE identity", () => {
    const src = `package s

type Server struct{ Addr string }

func (s *Server) Handle() error {
	return nil
}
`;
    const as = anchors(src);
    const handle = as.find((a) => a.id === `${P}::Server#Handle().`);
    assert.ok(handle, "method must anchor as Type#method().");
    // Flipping the receiver from pointer to value keeps the IDENTITY (same id)
    // and moves the SIGNATURE (receiver kind is contract).
    const flipped = anchors(src.replace("(s *Server)", "(s Server)"));
    const same = flipped.find((a) => a.id === `${P}::Server#Handle().`);
    assert.ok(same, "identity survives the receiver-kind flip");
    assert.notEqual(same?.signature, handle?.signature, "receiver kind is signature");
  });

  it("grouped const/var declarations anchor per declarator", () => {
    const src = `package s

const (
	MaxSize = 10
	MinSize = 1
)
`;
    const base = anchors(src);
    assert.ok(named(base, "MaxSize"));
    assert.ok(named(base, "MinSize"));
    const edit = anchors(src.replace("MaxSize = 10", "MaxSize = 20"));
    assert.notEqual(named(edit, "MaxSize")?.fingerprint, named(base, "MaxSize")?.fingerprint);
    assert.equal(named(edit, "MinSize")?.fingerprint, named(base, "MinSize")?.fingerprint);
  });

  it("a const VALUE edit is ackable body; its name and type are contract", () => {
    const src = "package s\n\nconst MaxSize int = 10\n";
    const base = anchors(src);
    const valueEdit = anchors(src.replace("= 10", "= 20"));
    assert.notEqual(named(valueEdit, "MaxSize")?.fingerprint, named(base, "MaxSize")?.fingerprint);
    assert.equal(named(valueEdit, "MaxSize")?.signature, named(base, "MaxSize")?.signature);
    const typeEdit = anchors(src.replace("int", "int64"));
    assert.notEqual(named(typeEdit, "MaxSize")?.signature, named(base, "MaxSize")?.signature);
  });

  it("struct: exported fields and their tags are contract; unexported fields are ackable body", () => {
    const src = `package s

type Server struct {
	Addr string \`json:"addr"\`
	name string
}
`;
    const base = anchors(src);
    const server = named(base, "Server");
    assert.ok(server?.signature);
    // Tag edit: wire contract → signature moves.
    const tagEdit = anchors(src.replace('json:"addr"', 'json:"address"'));
    assert.notEqual(named(tagEdit, "Server")?.signature, server?.signature);
    // Unexported field edit: internal representation → body only.
    const fieldEdit = anchors(src.replace("name string", "name []byte"));
    assert.notEqual(named(fieldEdit, "Server")?.fingerprint, server?.fingerprint);
    assert.equal(named(fieldEdit, "Server")?.signature, server?.signature);
  });

  it("an iota block anchors WHOLE: inserting a member is a contract move for every constant in it", () => {
    const src = `package s

const (
	Active Status = iota
	Paused
	Stopped
)
`;
    const base = anchors(src);
    assert.ok(named(base, "Paused"), "implicit-iota members are anchored");
    // Inserting a member BEFORE Paused shifts its runtime value with zero
    // change to its own bytes — the block grain makes that a signature move.
    const inserted = anchors(src.replace("Active Status = iota\n", "Active Status = iota\n\tDraining\n"));
    assert.notEqual(named(inserted, "Paused")?.signature, named(base, "Paused")?.signature);
    assert.notEqual(named(inserted, "Stopped")?.signature, named(base, "Stopped")?.signature);
  });

  it("names co-declared in ONE spec share a span — editing one value moves both (pinned as intended)", () => {
    const src = "package s\n\nconst A, B = 1, 2\n";
    const base = anchors(src);
    const edit = anchors(src.replace("1, 2", "5, 2"));
    assert.notEqual(named(edit, "A")?.fingerprint, named(base, "A")?.fingerprint);
    // B rides along: the spec is one span (the values are positional).
    assert.notEqual(named(edit, "B")?.fingerprint, named(base, "B")?.fingerprint);
    assert.equal(named(edit, "B")?.signature, named(base, "B")?.signature, "still body-only — ackable");
  });

  it("init and package side effects ride the residual in source order", () => {
    const base = anchors(BASE);
    assert.ok(residual(base), "package clause + import + init must produce a residual");
    const after = anchors(BASE.replace('"shapes ready"', '"shapes booted"'));
    assert.notEqual(residual(after)?.fingerprint, residual(base)?.fingerprint);
    assert.equal(named(after, "Area")?.fingerprint, named(base, "Area")?.fingerprint);
  });

  it("the cgo preamble comment is SEMANTIC: editing it moves the residual", () => {
    const cgo = `package s

// #include <stdio.h>
// #define BUF 16
import "C"

func Use() { C.puts(nil) }
`;
    const base = anchors(cgo);
    const after = anchors(cgo.replace("#define BUF 16", "#define BUF 32"));
    assert.notEqual(residual(after)?.fingerprint, residual(base)?.fingerprint);
    // …while an ordinary comment stays trivia.
    const plain = anchors(BASE.replace("// clamp keeps sizes sane.", "// reworded"));
    assert.equal(residual(plain)?.fingerprint, residual(anchors(BASE))?.fingerprint);
  });

  it("classification: exported symbols → precise; generated banner / no exports → coarse; parse error → unevaluable", () => {
    assert.equal(classifyGoFile(P, BASE).mode, "precise");
    assert.equal(classifyGoFile(P, "package s\n\nfunc helper() {}\n").mode, "coarse");
    assert.equal(
      classifyGoFile(P, "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage s\n\nfunc Use() {}\n").mode,
      "coarse",
    );
    assert.equal(classifyGoFile(P, "func Broken(( {\n").mode, "unevaluable");
  });
});

describe("go conformance battery — full", () => {
  before(async () => {
    await warmGoAdapter();
  });

  it("the Go adapter passes all eight behaviors", () => {
    const harness: AdapterHarness = {
      adapter: goAdapter,
      classify: (path, content) => classifyGoFile(path, content).mode,
      fixtures: {
        path: P,
        base: BASE,
        formatted: BASE.replace("// Area computes the clamped area.", "// Area, reworded.").replace(
          "func Perimeter(w, h int) int {",
          "func Perimeter(w, h int) int { // note",
        ),
        bodyEdit: {
          symbol: "Perimeter",
          content: BASE.replace("return 2 * (w + h)", "return (w + h) * 2"),
        },
        signatureEdit: {
          symbol: "Perimeter",
          content: BASE.replace("func Perimeter(w, h int) int {", "func Perimeter(w, h, pad int) int {"),
        },
        helperEdit: {
          symbol: "Area",
          content: BASE.replace("return n\n", "return n + 0\n"),
        },
        residualEdit: BASE.replace('"shapes ready"', '"shapes booted"'),
        reordered: BASE.replace(
          "// Area computes the clamped area.\nfunc Area(w, h int) int {\n\treturn clamp(w * h)\n}\n\nfunc Perimeter(w, h int) int {\n\treturn 2 * (w + h)\n}",
          "func Perimeter(w, h int) int {\n\treturn 2 * (w + h)\n}\n\n// Area computes the clamped area.\nfunc Area(w, h int) int {\n\treturn clamp(w * h)\n}",
        ),
        parseError: "func Broken(( {\n",
      },
    };
    assert.deepEqual(checkAdapterConformance(harness), []);
  });
});
