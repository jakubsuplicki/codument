import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProject } from "../src/lib/detect.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("detectProject", () => {
  it("detects typescript with src dir", async () => {
    await writeFile(join(tmp, "tsconfig.json"), "{}");
    await mkdir(join(tmp, "src"));
    await writeFile(join(tmp, "package.json"), JSON.stringify({}));

    const info = await detectProject(tmp);
    assert.equal(info.language, "typescript");
    assert.equal(info.srcDir, "src");
    assert.deepStrictEqual(info.sourceGlobs, [
      "src/**/*.ts",
      "src/**/*.tsx",
    ]);
    assert.equal(info.framework, null);
  });

  it("detects javascript without tsconfig", async () => {
    await writeFile(join(tmp, "package.json"), JSON.stringify({}));

    const info = await detectProject(tmp);
    assert.equal(info.language, "javascript");
    assert.deepStrictEqual(info.sourceGlobs, ["./**/*.js", "./**/*.jsx"]);
  });

  it("detects root srcDir when no src/ directory", async () => {
    await writeFile(join(tmp, "tsconfig.json"), "{}");
    await writeFile(join(tmp, "package.json"), JSON.stringify({}));

    const info = await detectProject(tmp);
    assert.equal(info.srcDir, ".");
    assert.deepStrictEqual(info.sourceGlobs, ["./**/*.ts", "./**/*.tsx"]);
  });

  it("detects nextjs framework", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { next: "^14.0.0", react: "^18.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "nextjs");
  });

  it("detects remix framework", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@remix-run/node": "^2.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "remix");
  });

  it("detects remix via @remix-run/react", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@remix-run/react": "^2.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "remix");
  });

  it("detects express framework", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "express");
  });

  it("detects nestjs framework", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "^10.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "nestjs");
  });

  it("detects react framework (standalone)", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "react");
  });

  it("detects vue framework", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { vue: "^3.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "vue");
  });

  it("detects svelte framework", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ dependencies: { svelte: "^4.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "svelte");
  });

  it("prefers next over react when both present", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
      }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "nextjs");
  });

  it("checks devDependencies too", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ devDependencies: { svelte: "^4.0.0" } }),
    );

    const info = await detectProject(tmp);
    assert.equal(info.framework, "svelte");
  });

  it("returns null framework when no package.json", async () => {
    const info = await detectProject(tmp);
    assert.equal(info.framework, null);
  });
});
