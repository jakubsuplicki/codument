import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-demo-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("codument demo --auto", () => {
  it("runs the full walkthrough end-to-end and exits 0", () => {
    const repo = join(tmp, "repo");
    const out = execFileSync("node", [CLI, "demo", "--auto", "--dir", repo], {
      encoding: "utf-8",
    });
    // the three scenes ran
    assert.match(out, /documentation coverage/i);
    assert.match(out, /An AI agent makes a sweeping change/);
    // scene ③ leads with the with/without value contrast, not the raw % swing
    assert.match(out, /Without codument/);
    assert.match(out, /With codument/);
    assert.match(out, /changes outside the approved plan/);
    assert.match(out, /health gauge, not the verdict/);
    // it materialized the sample repo and wrote the HTML report
    assert.ok(existsSync(join(repo, "docs", ".registry.json")));
    const reportPath = join(repo, ".codument", "report.html");
    assert.ok(existsSync(reportPath));
    // the report embeds the self-explaining demo callout + per-card notes + contrast
    const html = readFileSync(reportPath, "utf-8");
    assert.match(html, /How this demo works/);
    assert.match(html, /add rate limiting to the login path/i);
    assert.match(html, /what this checks/);
    assert.match(html, /Without codument/);
  });
});

describe("codument demo --live --auto", () => {
  it("starts on a clean tree, lands the change, and lights up the panel", () => {
    const repo = join(tmp, "repo");
    const out = execFileSync("node", [CLI, "demo", "--live", "--auto", "--dir", repo], {
      encoding: "utf-8",
    });
    const clean = out.replace(/\x1b\[[0-9;]*[mGKHJ]/g, "");
    // it ran the live watch panel
    assert.match(clean, /codument demo --live/);
    assert.match(clean, /clean working tree/);
    assert.match(clean, /an AI agent is editing/);
    // the panel reflects the change landing (coverage drops to the lit-up state)
    assert.match(clean, /docs coverage: 71%/);
    assert.match(clean, /3 out-of-plan/);
    // and it still produced the shareable report
    assert.ok(existsSync(join(repo, ".codument", "report.html")));
    assert.match(clean, /codument watch/);
  });
});
