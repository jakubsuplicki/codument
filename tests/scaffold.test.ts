import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureDir,
  upsertManagedSection,
  buildManagedSection,
} from "../src/lib/scaffold.js";
import { MARKER_START, MARKER_END } from "../src/lib/markers.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ensureDir", () => {
  it("creates directory if it does not exist", () => {
    const dir = join(tmp, "a", "b", "c");
    assert.ok(!existsSync(dir));
    ensureDir(dir);
    assert.ok(existsSync(dir));
  });

  it("does nothing if directory already exists", () => {
    const dir = join(tmp, "existing");
    ensureDir(dir);
    // Should not throw
    ensureDir(dir);
    assert.ok(existsSync(dir));
  });
});

describe("upsertManagedSection", () => {
  it("creates new file with managed section", async () => {
    const filePath = join(tmp, "NEW.md");
    await upsertManagedSection(filePath, "managed content");

    const content = await readFile(filePath, "utf-8");
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes("managed content"));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.endsWith("\n"));
  });

  it("appends managed section to existing file without markers", async () => {
    const filePath = join(tmp, "EXISTING.md");
    await writeFile(filePath, "# My Project\n\nSome content.");

    await upsertManagedSection(filePath, "managed stuff");

    const content = await readFile(filePath, "utf-8");
    assert.ok(content.startsWith("# My Project\n\nSome content."));
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes("managed stuff"));
    assert.ok(content.includes(MARKER_END));
  });

  it("replaces existing managed section", async () => {
    const filePath = join(tmp, "REPLACE.md");
    const initial = `# Title\n\n${MARKER_START}\nold content\n${MARKER_END}\n\n# Footer`;
    await writeFile(filePath, initial);

    await upsertManagedSection(filePath, "new content");

    const content = await readFile(filePath, "utf-8");
    assert.ok(!content.includes("old content"));
    assert.ok(content.includes("new content"));
    assert.ok(content.includes("# Title"));
    assert.ok(content.includes("# Footer"));
  });

  it("preserves content before and after markers", async () => {
    const filePath = join(tmp, "PRESERVE.md");
    const before = "# Before\n\nIntro text.\n\n";
    const after = "\n\n# After\n\nOutro text.\n";
    const initial = `${before}${MARKER_START}\noriginal\n${MARKER_END}${after}`;
    await writeFile(filePath, initial);

    await upsertManagedSection(filePath, "replaced");

    const content = await readFile(filePath, "utf-8");
    assert.ok(content.startsWith(before));
    assert.ok(content.includes(`${MARKER_START}\nreplaced\n${MARKER_END}`));
    assert.ok(content.endsWith(after));
  });
});

describe("buildManagedSection", () => {
  it("returns documentation maintenance section", () => {
    const section = buildManagedSection();
    assert.ok(section.includes("## Documentation Maintenance"));
    assert.ok(section.includes("Definition of Done"));
    assert.ok(section.includes("docs/.registry.json"));
    assert.ok(section.includes("Documentation Structure"));
    assert.ok(section.includes("docs/features/{name}.md"));
    assert.ok(section.includes("docs/concepts/{name}.md"));
  });
});
