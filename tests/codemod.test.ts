import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hashContent,
  readMeta,
  writeMeta,
  decideMergeStrategy,
  setFileHash,
  type MetaFile,
} from "../src/lib/codemod.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("hashContent", () => {
  it("returns a 16-character hex string", () => {
    const hash = hashContent("hello world");
    assert.equal(hash.length, 16);
    assert.match(hash, /^[0-9a-f]{16}$/);
  });

  it("returns same hash for same content", () => {
    assert.equal(hashContent("test"), hashContent("test"));
  });

  it("returns different hash for different content", () => {
    assert.notEqual(hashContent("a"), hashContent("b"));
  });

  it("handles empty string", () => {
    const hash = hashContent("");
    assert.equal(hash.length, 16);
    assert.match(hash, /^[0-9a-f]{16}$/);
  });
});

describe("readMeta", () => {
  it("returns null when file does not exist", async () => {
    const result = await readMeta(tmp);
    assert.equal(result, null);
  });

  it("reads existing meta file", async () => {
    const meta: MetaFile = {
      version: "0.1.0",
      initialized: "2026-03-01",
      project: { language: "typescript" },
    };
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      join(tmp, ".codument-meta.json"),
      JSON.stringify(meta),
    );

    const result = await readMeta(tmp);
    assert.deepStrictEqual(result, meta);
  });
});

describe("writeMeta", () => {
  it("writes meta as formatted JSON with trailing newline", async () => {
    const meta: MetaFile = {
      version: "0.1.0",
      initialized: "2026-03-01",
      project: {},
    };

    await writeMeta(tmp, meta);

    const raw = await readFile(join(tmp, ".codument-meta.json"), "utf-8");
    assert.ok(raw.endsWith("\n"));
    assert.deepStrictEqual(JSON.parse(raw), meta);
  });

  it("round-trips the optional charter field", async () => {
    const meta: MetaFile = {
      version: "0.1.0",
      initialized: "2026-03-01",
      project: {},
      charter: { seriousness: "serious", established: "2026-06-22" },
    };

    await writeMeta(tmp, meta);
    const result = await readMeta(tmp);

    assert.deepStrictEqual(result?.charter, {
      seriousness: "serious",
      established: "2026-06-22",
    });
  });

  it("omits charter by default", async () => {
    const meta: MetaFile = {
      version: "0.1.0",
      initialized: "2026-03-01",
      project: {},
    };

    await writeMeta(tmp, meta);
    const result = await readMeta(tmp);

    assert.equal(result?.charter, undefined);
  });
});

describe("decideMergeStrategy", () => {
  const contentA = "file content A";
  const contentB = "file content B";
  const contentC = "file content C";
  const hashA = hashContent(contentA);
  const hashB = hashContent(contentB);

  it("skips when no stored hash and content matches upstream", () => {
    const result = decideMergeStrategy(contentA, contentA, undefined);
    assert.equal(result.action, "skip");
    assert.match(result.reason, /already up to date/);
  });

  it("merges when no stored hash and content differs", () => {
    const result = decideMergeStrategy(contentA, contentB, undefined);
    assert.equal(result.action, "merge");
    assert.match(result.reason, /no prior hash/);
  });

  it("skips when nothing changed", () => {
    const result = decideMergeStrategy(contentA, contentA, hashA);
    assert.equal(result.action, "skip");
    assert.match(result.reason, /no changes/);
  });

  it("overwrites when only upstream changed", () => {
    // storedHash = hashA, current = contentA (unchanged), upstream = contentB (changed)
    const result = decideMergeStrategy(contentB, contentA, hashA);
    assert.equal(result.action, "overwrite");
    assert.match(result.reason, /upstream updated/);
  });

  it("skips when only user changed", () => {
    // storedHash = hashA, current = contentB (user modified), upstream = contentA (unchanged)
    const result = decideMergeStrategy(contentA, contentB, hashA);
    assert.equal(result.action, "skip");
    assert.match(result.reason, /only local modifications/);
  });

  it("merges when both changed", () => {
    // storedHash = hashA, current = contentB (user modified), upstream = contentC (upstream modified)
    const result = decideMergeStrategy(contentC, contentB, hashA);
    assert.equal(result.action, "merge");
    assert.match(result.reason, /both upstream and local/);
  });
});

describe("setFileHash", () => {
  it("creates fileHashes if missing", () => {
    const meta: MetaFile = {
      version: "0.1.0",
      initialized: "2026-01-01",
      project: {},
    };

    setFileHash(meta, "some/file.md", "content");
    assert.ok(meta.fileHashes);
    assert.equal(meta.fileHashes["some/file.md"], hashContent("content"));
  });

  it("adds to existing fileHashes", () => {
    const meta: MetaFile = {
      version: "0.1.0",
      initialized: "2026-01-01",
      project: {},
      fileHashes: { "existing.md": "abc123" },
    };

    setFileHash(meta, "new.md", "new content");
    assert.equal(meta.fileHashes!["existing.md"], "abc123");
    assert.equal(meta.fileHashes!["new.md"], hashContent("new content"));
  });

  it("overwrites existing hash for same path", () => {
    const meta: MetaFile = {
      version: "0.1.0",
      initialized: "2026-01-01",
      project: {},
      fileHashes: { "file.md": "old-hash" },
    };

    setFileHash(meta, "file.md", "updated content");
    assert.equal(
      meta.fileHashes!["file.md"],
      hashContent("updated content"),
    );
  });
});

describe("an exclude block is validated on read, never silently ignored", () => {
  const writeRaw = async (exclude: unknown): Promise<void> => {
    const meta = {
      version: "0.9.0",
      initialized: "2026-07-21",
      project: {},
      ...(exclude === undefined ? {} : { exclude }),
    };
    await writeFile(join(tmp, ".codument-meta.json"), JSON.stringify(meta), "utf-8");
  };

  it("accepts a well-formed block and hands it back verbatim", async () => {
    await writeRaw({ dirs: ["out", "public-preprod"], globs: ["**/*.gen.ts"] });
    const meta = await readMeta(tmp);
    assert.deepEqual(meta?.exclude, {
      dirs: ["out", "public-preprod"],
      globs: ["**/*.gen.ts"],
    });
  });

  it("accepts either key alone", async () => {
    await writeRaw({ dirs: ["out"] });
    assert.deepEqual((await readMeta(tmp))?.exclude, { dirs: ["out"] });
    await writeRaw({ globs: ["**/*.gen.ts"] });
    assert.deepEqual((await readMeta(tmp))?.exclude, { globs: ["**/*.gen.ts"] });
  });

  it("accepts an empty block (declares nothing, means nothing)", async () => {
    await writeRaw({});
    assert.deepEqual((await readMeta(tmp))?.exclude, {});
  });

  it("leaves a meta with no exclude block untouched", async () => {
    await writeRaw(undefined);
    const meta = await readMeta(tmp);
    assert.equal(meta?.exclude, undefined);
    assert.equal(meta?.version, "0.9.0");
  });

  const rejected: Array<[string, unknown, RegExp]> = [
    ["a non-object block", ["out"], /invalid exclude — expected an object, got an array/],
    ["a null block", null, /invalid exclude — expected an object, got null/],
    ["a string block", "out", /invalid exclude — expected an object, got "out"/],
    [
      "an unknown key",
      { dirs: ["out"], dir: ["typo"] },
      /invalid exclude — unknown key "dir"/,
    ],
    [
      "a non-array dirs",
      { dirs: "out" },
      /invalid exclude\.dirs — expected an array of strings, got "out"/,
    ],
    [
      "a non-string element",
      { dirs: ["out", 7] },
      /invalid exclude\.dirs — expected a string, got number/,
    ],
    ["an empty string", { globs: [""] }, /invalid exclude\.globs — an entry is empty/],
    [
      "a whitespace-only string",
      { dirs: ["  "] },
      /invalid exclude\.dirs — an entry is empty/,
    ],
    [
      "a path where a bare dir name belongs",
      { dirs: ["build/out"] },
      /invalid exclude\.dirs — "build\/out" is a path/,
    ],
  ];

  for (const [label, block, expected] of rejected) {
    it(`rejects ${label}, naming the offending value`, async () => {
      await writeRaw(block);
      await assert.rejects(() => readMeta(tmp), (err: Error) => {
        assert.equal(err.name, "ConfigValueError");
        assert.match(err.message, expected);
        // The path is named too, so the user knows which file to edit.
        assert.match(err.message, /\.codument-meta\.json/);
        return true;
      });
    });
  }

  it("points a path-shaped dirs entry at the key that would work", async () => {
    await writeRaw({ dirs: ["build/out"] });
    await assert.rejects(() => readMeta(tmp), /use exclude\.globs/);
  });
});

// Plan 45 step 1: the three-way comparison reads "both changed" whenever neither side
// matches the recorded hash — including an upgrade where the two sides arrived at the
// SAME content. "Both changed" means back the file up and overwrite it with what is
// already there, so one `codument update` on this repository wrote 21 backups, none of
// them preserving anything.
describe("a backup is written only when something would be lost (plan 45)", () => {
  const upstream = "shared content";

  it("converged content is a skip, however it got there", () => {
    // Both sides moved to the same text; the stored hash remembers neither.
    const r = decideMergeStrategy(upstream, upstream, hashContent("something older"));
    assert.equal(r.action, "skip");
    assert.match(r.reason, /already up to date/);
  });

  it("the untouched case still reads exactly as it always has", () => {
    const r = decideMergeStrategy(upstream, upstream, hashContent(upstream));
    assert.equal(r.action, "skip");
    assert.match(r.reason, /no changes/);
  });

  it("a first update with no recorded hash and identical content is still a skip", () => {
    assert.equal(decideMergeStrategy(upstream, upstream, undefined).action, "skip");
  });

  it("a genuine divergence is still merged, so nothing stops being preserved", () => {
    const r = decideMergeStrategy(upstream, "local edits", hashContent("something older"));
    assert.equal(r.action, "merge");
  });
});
