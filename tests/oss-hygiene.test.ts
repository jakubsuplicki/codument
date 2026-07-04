import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// This repo is open source and must carry zero indication that any companion
// product exists: every contract (the event stream, the JSON surfaces) is
// justified on its own terms, never "for <that product>". This test mechanically
// enforces the rule across the directories that define the shipped surface, so a
// stray reference fails CI instead of leaking into a published package.
const ENFORCED_DIRS = ["src", "templates", "skills", "agents", "rules"];

// The forbidden markers are held base64-encoded so the literal terms are
// themselves absent from this repository (the rule applies to this test too).
// Decode with Buffer.from(m, "base64") to audit the list.
const FORBIDDEN_MARKERS = ["c3R1ZGlv"].map((m) =>
  Buffer.from(m, "base64").toString("utf8").toLowerCase(),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe("oss hygiene", () => {
  it("has a live, non-empty forbidden-marker list", () => {
    // Guard against a broken encoding silently disabling the whole check.
    assert.ok(FORBIDDEN_MARKERS.length > 0);
    assert.ok(FORBIDDEN_MARKERS.every((m) => m.length > 2));
  });

  it("no companion-product references in the shipped surface", () => {
    const hits: string[] = [];
    for (const dir of ENFORCED_DIRS) {
      for (const file of walk(join(repoRoot, dir))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          const lower = line.toLowerCase();
          if (FORBIDDEN_MARKERS.some((m) => lower.includes(m))) {
            hits.push(`${relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    assert.deepEqual(
      hits,
      [],
      `Forbidden companion-product references found (justify contracts intrinsically):\n${hits.join("\n")}`,
    );
  });
});
