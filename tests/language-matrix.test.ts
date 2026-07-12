import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXCLUSION_SPEC } from "../src/lib/analyze.js";
import {
  LANGUAGE_MATRIX,
  adapterFor,
  preciseAdapterIds,
  renderLanguageMatrixTable,
} from "../src/lib/fingerprint.js";

const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");

// Extract the language-support table from the README, normalized row-by-row.
function readmeTable(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Language | Files | Resolution | Since |"));
  assert.notEqual(start, -1, "README must carry the language matrix table");
  const rows: string[] = [];
  for (let i = start; i < lines.length && lines[i].startsWith("|"); i++) {
    rows.push(lines[i].trim());
  }
  return rows.join("\n");
}

describe("language matrix — the claim that cannot lie", () => {
  it("the README table is byte-equal to the manifest rendering", () => {
    assert.equal(readmeTable(readFileSync(README, "utf-8")), renderLanguageMatrixTable());
  });

  it("the manifest and the registered precise adapters are the same set", () => {
    assert.deepEqual(
      LANGUAGE_MATRIX.map((r) => r.language).sort(),
      preciseAdapterIds().sort(),
    );
  });

  it("every matrix row's extensions resolve to its own adapter", () => {
    for (const row of LANGUAGE_MATRIX) {
      for (const ext of row.extensions) {
        assert.equal(
          adapterFor(`sample/file${ext}`).language,
          row.language,
          `${ext} must dispatch to ${row.language}`,
        );
      }
    }
  });

  it("every matrix extension is IN the governance spec — dispatch alone is not enough", () => {
    // adapterFor dispatch does not depend on the exclusion spec, so a future
    // adapter registered without a spec addition would judge registered files
    // while scan/coverage silently never discover them. Close that axis.
    for (const row of LANGUAGE_MATRIX) {
      for (const ext of row.extensions) {
        assert.ok(
          DEFAULT_EXCLUSION_SPEC.extensions.includes(ext),
          `${ext} must be in DEFAULT_EXCLUSION_SPEC.extensions`,
        );
      }
    }
  });

  it("the parity check goes RED on a seeded mismatch — the test bites", () => {
    const doctored = readFileSync(README, "utf-8").replace(
      "| Go | `.go` | per-symbol |",
      "| COBOL | `.cbl` | per-symbol |",
    );
    assert.notEqual(readmeTable(doctored), renderLanguageMatrixTable());
  });
});
