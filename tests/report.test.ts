import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderReviewReportHtml } from "../src/lib/report-html.js";
import { buildReportData, writeReport } from "../src/commands/report.js";
import type { ChangeState } from "../src/lib/change-state.js";

function emptyState(): ChangeState {
  return {
    changedSources: [],
    changedDocs: [],
    byFeature: [],
    unmapped: [],
    staleDocs: [],
    docsChangedWithoutSource: [],
    highFanout: [],
    riskTouches: [],
    dependents: [],
    outOfPlan: [],
    planScoped: false,
  };
}

describe("renderReviewReportHtml", () => {
  it("is a self-contained page (no network, has style, doctype)", () => {
    const html = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 0, plan: null, state: emptyState() },
      coveragePercent: 94,
      previousPercent: 94,
      generatedAt: "t",
    });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<style>/);
    assert.doesNotMatch(html, /https?:\/\//);
  });

  it("renders a clean verdict when there are no actionable findings", () => {
    const html = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 1, plan: null, state: emptyState() },
      coveragePercent: 94,
      generatedAt: "t",
    });
    assert.match(html, /looks clean/i);
    assert.doesNotMatch(html, /needs a look/i);
  });

  it("renders the verdict, coverage delta, and findings when something is wrong", () => {
    const state = emptyState();
    state.staleDocs = [
      { feature: "auth", doc: "docs/features/auth.md", changedSources: ["src/auth/login.ts"] },
    ];
    state.unmapped = ["src/lib/cache.ts"];
    const html = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 3, plan: null, state },
      coveragePercent: 71,
      previousPercent: 78,
      generatedAt: "t",
    });
    assert.match(html, /needs a look/i);
    assert.match(html, /78% &rarr; 71%/);
    assert.match(html, /\(&minus;7\)/);
    assert.match(html, /auth/);
    assert.match(html, /went stale/i);
    // the value framing: without/with codument, coverage demoted to a gauge
    assert.match(html, /Without codument/);
    assert.match(html, /With codument/);
    assert.match(html, /health gauge, not the verdict/);
  });

  it("omits the with/without contrast on a clean change", () => {
    const html = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 2, plan: null, state: emptyState() },
      coveragePercent: 94,
      previousPercent: 94,
      generatedAt: "t",
    });
    assert.match(html, /looks clean/i);
    assert.doesNotMatch(html, /Without codument/);
  });

  it("gives every rendered finding card a 'what this checks' explainer", () => {
    const state = emptyState();
    state.staleDocs = [
      { feature: "auth", doc: "docs/features/auth.md", changedSources: ["src/auth/login.ts"] },
    ];
    const html = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 1, plan: null, state },
      coveragePercent: 80,
      generatedAt: "t",
    });
    assert.match(html, /what this checks/);
    assert.match(html, /the doc that owns it in the registry/i);
  });

  it("omits the demo callout unless demo notes are provided", () => {
    const clean = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 0, plan: null, state: emptyState() },
      coveragePercent: 90,
      generatedAt: "t",
    });
    assert.doesNotMatch(clean, /How this demo works/);

    const withDemo = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 0, plan: null, state: emptyState() },
      coveragePercent: 90,
      generatedAt: "t",
      demo: {
        intro: "Throwaway sample repo.",
        scenario: "An AI agent overreached.",
        changeRows: [{ file: "src/lib/db.ts", note: "out of plan" }],
        footnote: "Nothing leaks.",
      },
    });
    assert.match(withDemo, /How this demo works/);
    assert.match(withDemo, /Throwaway sample repo\./);
    assert.match(withDemo, /src\/lib\/db\.ts/);
    assert.match(withDemo, /out of plan/);
  });

  it("keeps the coverage percentage visible above the gauge's inner disc", () => {
    const html = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 1, plan: null, state: emptyState() },
      coveragePercent: 39,
      generatedAt: "t",
    });
    assert.match(html, /class="pct">39<sup>%<\/sup>/);
    // the number layer must stack above the .ring::after donut-hole disc, or it's invisible
    assert.match(html, /\.ring \.num\{[^}]*z-index:\s*[1-9]/);
  });
});

describe("report command (temp git repo)", () => {
  let tmp: string;
  const CLI_REGISTRY = {
    features: {
      auth: {
        doc: "docs/features/auth.md",
        type: "feature",
        primary_sources: ["src/auth/login.ts"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: ["auth"],
        last_updated: "2026-06-16",
        status: "current",
      },
    },
  };

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-report-"));
    await mkdir(join(tmp, "src", "auth"), { recursive: true });
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await writeFile(join(tmp, "docs", ".registry.json"), JSON.stringify(CLI_REGISTRY, null, 2));
    await writeFile(join(tmp, "docs", "features", "auth.md"), "# auth\n");
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 1;\n");
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd: tmp, stdio: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    run(["init"]);
    run(["config", "user.email", "t@e.com"]);
    run(["config", "user.name", "T"]);
    run(["add", "-A"]);
    run(["commit", "-m", "baseline"]);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes a report that flags a stale doc on a real change", async () => {
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 2;\n");
    const out = writeReport(tmp);
    assert.ok(existsSync(out));
    const html = readFileSync(out, "utf-8");
    assert.match(html, /needs a look/i);
    assert.match(html, /went stale/i);
    assert.match(html, /auth/);
  });

  it("buildReportData picks up the previous coverage from coverage.json", async () => {
    // simulate a prior `doctor --write` having persisted a baseline
    await mkdir(join(tmp, ".codument"), { recursive: true });
    await writeFile(
      join(tmp, ".codument", "coverage.json"),
      JSON.stringify({ version: 1, percent: 100 }),
    );
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 3;\n");
    const data = buildReportData(tmp, "t");
    assert.equal(data.previousPercent, 100);
    assert.equal(typeof data.coveragePercent, "number");
  });
});
