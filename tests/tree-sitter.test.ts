import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  grammarManifest,
  loadLanguage,
  loadLanguageFromFile,
  manifestFor,
  parseWith,
  runtimeInitialized,
  TreeSitterError,
} from "../src/lib/tree-sitter.js";

// A real grammar binary, pinned through the lockfile rather than committed as a
// repo blob: the exact-versioned dev dependency plays the role `grammars/` will
// play for shipped adapters (plan 19+ vendors per-language binaries there).
const require = createRequire(import.meta.url);
const PYTHON_WASM = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm");

const PY_SOURCE =
  'def greet(name):\n    # a comment the tree still sees\n    return f"hi {name}"\n\n\nclass Greeter:\n    def greet(self):\n        return greet("world")\n';

// The parse is a pure function of (content bytes, grammar bytes, runtime
// bytes); all three are version-pinned, so this constant holds on every
// machine. If a dependency bump moves it, that bump is an algo-visible event
// and belongs in a commit that says so — exactly the contract.
//
// The S-expression is STRUCTURE ONLY: identifier and literal text never appear
// in it, so it pins parse determinism, not content sensitivity. An adapter
// must key fingerprints off node text/byte spans — never off `.toString()`.
const PY_SEXP_SHA256 = "0a5b9091623f8e2f65b03dbbb54003dd2f2269c629941ae340bf538da64adc04";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-ts-wasm-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("tree-sitter substrate", () => {
  // Declaration order matters for this file: the laziness assertion must run
  // before anything loads a grammar in this process.
  it("importing the module initializes no WASM runtime", () => {
    assert.equal(runtimeInitialized(), false);
  });

  it("parses the same bytes to an identical, pinned S-expression across two fresh loads", async () => {
    const first = await loadLanguageFromFile(PYTHON_WASM);
    const second = await loadLanguageFromFile(PYTHON_WASM);
    const sexpA = (await parseWith(first, PY_SOURCE)).rootNode.toString();
    const sexpB = (await parseWith(second, PY_SOURCE)).rootNode.toString();
    assert.equal(sexpA, sexpB);
    assert.equal(createHash("sha256").update(sexpA, "utf8").digest("hex"), PY_SEXP_SHA256);
    assert.equal(runtimeInitialized(), true);
    // Different structure must land elsewhere — the golden is not a constant
    // the parser emits regardless of input.
    const other = (await parseWith(first, "x = 1\n")).rootNode.toString();
    assert.notEqual(createHash("sha256").update(other, "utf8").digest("hex"), PY_SEXP_SHA256);
  });

  it("fails loud on a corrupted grammar binary — never a fallback", async () => {
    const bytes = readFileSync(PYTHON_WASM);
    const corrupted = join(tmp, "corrupt.wasm");
    writeFileSync(corrupted, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await assert.rejects(loadLanguageFromFile(corrupted), (err: unknown) => {
      assert.ok(err instanceof TreeSitterError);
      assert.match(err.message, /refusing to fall back/);
      return true;
    });
  });

  it("fails loud on a missing grammar binary", async () => {
    await assert.rejects(loadLanguageFromFile(join(tmp, "absent.wasm")), (err: unknown) => {
      assert.ok(err instanceof TreeSitterError);
      assert.match(err.message, /unreadable/);
      return true;
    });
  });

  it("refuses an unbundled language by name", async () => {
    await assert.rejects(loadLanguage("klingon"), (err: unknown) => {
      assert.ok(err instanceof TreeSitterError);
      assert.match(err.message, /"klingon"/);
      return true;
    });
  });
});

describe("grammar manifest", () => {
  it("hashes bundled grammar bytes and sorts by language, locale-independent", () => {
    writeFileSync(join(tmp, "zebra.wasm"), "zebra-bytes");
    writeFileSync(join(tmp, "apple.wasm"), "apple-bytes");
    const manifest = manifestFor(
      [
        { language: "zebra", file: "zebra.wasm" },
        { language: "apple", file: "apple.wasm" },
      ],
      tmp,
    );
    assert.deepEqual(
      manifest.map((m) => m.language),
      ["apple", "zebra"],
    );
    assert.equal(
      manifest[0].sha256,
      createHash("sha256").update("apple-bytes").digest("hex"),
    );
  });

  it("refuses a duplicate language id — one binary per language", () => {
    writeFileSync(join(tmp, "a.wasm"), "a");
    assert.throws(
      () =>
        manifestFor(
          [
            { language: "twice", file: "a.wasm" },
            { language: "twice", file: "a.wasm" },
          ],
          tmp,
        ),
      (err: unknown) => {
        assert.ok(err instanceof TreeSitterError);
        assert.match(err.message, /"twice"/);
        return true;
      },
    );
  });

  it("fails loud when a bundled grammar binary is missing — never a shorter manifest", () => {
    assert.throws(
      () => manifestFor([{ language: "ghost", file: "ghost.wasm" }], tmp),
      (err: unknown) => {
        assert.ok(err instanceof TreeSitterError);
        assert.match(err.message, /"ghost"/);
        return true;
      },
    );
  });

  it("carries every bundled grammar — python since its adapter shipped", () => {
    const manifest = grammarManifest();
    assert.deepEqual(
      manifest.map((m) => m.language),
      ["c-sharp", "go", "java", "kotlin", "python", "rust"],
    );
    for (const m of manifest) assert.match(m.sha256, /^[0-9a-f]{64}$/);
  });
});
