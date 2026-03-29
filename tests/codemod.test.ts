import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
