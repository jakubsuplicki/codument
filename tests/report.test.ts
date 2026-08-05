import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReportData, buildReportJson, writeReport } from "../src/commands/report.js";
import { writeAck } from "../src/lib/acknowledgment.js";
import type { ChangeState } from "../src/lib/change-state.js";
import { fileContentTransition } from "../src/lib/fingerprint.js";
import { renderReviewReportHtml } from "../src/lib/report-html.js";
import { emitCaught } from "../src/lib/review-events.js";

function emptyState(): ChangeState {
  return {
    changedSources: [],
    changedDocs: [],
    byFeature: [],
    unmapped: [],
    otherChanged: [],
    staleDocs: [],
    docsChangedWithoutSource: [],
    highFanout: [],
    riskTouches: [],
    dependents: [],
    dependentsSummary: [],
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

  it("renders the acknowledgments card with self vs independent badges", () => {
    const html = renderReviewReportHtml({
      review: {
        version: 2,
        gate: "ok",
        isGitRepo: true,
        changedFileCount: 2,
        deletions: [],
        plan: null,
        state: emptyState(),
        drift: [],
        fileGrainAcked: ["src/b.ts"],
        coveringAcks: [
          {
            anchorId: "src/a.ts::foo",
            grain: "symbol",
            symbol: "foo",
            signer: "alice",
            reason: "internal refactor, same shape",
            independent: false,
          },
          {
            anchorId: "src/b.ts",
            grain: "file",
            symbol: null,
            signer: "bob",
            reason: "additive helper only",
            independent: true,
          },
        ],
      },
      coveragePercent: 90,
      generatedAt: "t",
    });
    assert.match(html, /Acknowledgments in this change/);
    assert.match(html, /2 covering/);
    assert.match(html, /1 self-adjudicated/);
    assert.match(html, /1 independent/);
    assert.match(html, /class="akb self"/, "the self ack is badged self");
    assert.match(html, /class="akb ind"/, "the independent ack is badged independent");
    assert.match(html, /internal refactor, same shape/);
    assert.match(html, /additive helper only/);
    assert.match(html, /src\/b\.ts/); // the file-grain ack names its path
  });

  it("omits the acknowledgments card when the change carries no covering ack", () => {
    const html = renderReviewReportHtml({
      review: {
        version: 2,
        isGitRepo: true,
        changedFileCount: 1,
        plan: null,
        state: emptyState(),
        coveringAcks: [],
      },
      coveragePercent: 90,
      generatedAt: "t",
    });
    assert.doesNotMatch(html, /Acknowledgments in this change/);
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

  it("omits the Caught panel when there is no impact ledger data", () => {
    const html = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 0, plan: null, state: emptyState() },
      coveragePercent: 90,
      generatedAt: "t",
      impact: {
        provable: { staleDocs: 0, riskTouches: 0, offPlan: 0, snapshots: 0 },
        reported: {
          headline: 0,
          fixed: { correctness: 0, minor: 0 },
          deferred: { correctness: 0, minor: 0 },
          total: 0,
        },
        hasProvable: false,
        hasReported: false,
      },
    });
    assert.doesNotMatch(html, /Caught across this project/);
  });

  it("renders the Caught panel: provable line leads, reported line labeled self-reported", () => {
    const html = renderReviewReportHtml({
      review: { version: 1, isGitRepo: true, changedFileCount: 0, plan: null, state: emptyState() },
      coveragePercent: 90,
      generatedAt: "t",
      impact: {
        provable: { staleDocs: 23, riskTouches: 4, offPlan: 2, snapshots: 12 },
        reported: {
          headline: 11,
          fixed: { correctness: 11, minor: 3 },
          deferred: { correctness: 0, minor: 1 },
          total: 15,
        },
        hasProvable: true,
        hasReported: true,
      },
    });
    assert.match(html, /Caught across this project/);
    assert.match(html, /Provable/);
    assert.match(html, /23 stale docs flagged/);
    assert.match(html, /4 high-risk touches/);
    assert.match(html, /2 off-plan changes/);
    assert.match(html, /Reported/);
    assert.match(html, /11 review issues fixed before commit/);
    assert.match(html, /\+3 minor/);
    assert.match(html, /agent self-reported/);
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
      execFileSync("git", args, {
        cwd: tmp,
        stdio: "ignore",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
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

  it("refuses a subdirectory root — never persists a wrong-verdict artifact", async () => {
    // The report renders the same gate verdict review refuses from a subdir;
    // exit 0 + a shareable HTML saying "no owned changes" would be the wrong
    // verdict made durable.
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 4;\n");
    const here = dirname(fileURLToPath(import.meta.url));
    const CLI = join(here, "..", "dist", "cli.js");
    let status = 0;
    let stdout = "";
    try {
      execFileSync("node", [CLI, "report", "--no-open"], {
        cwd: join(tmp, "src"),
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    assert.equal(status, 1);
    assert.match(stdout, /subdirectory/);
    assert.match(stdout, /gate could not run/);
    assert.ok(!existsSync(join(tmp, "src", ".codument", "report.html")), "no artifact written");
  });

  describe("report --json (machine surface)", () => {
    it("emits a versioned {impact, acks} envelope with no timestamp", async () => {
      await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 5;\n");
      const j = buildReportJson(tmp);
      assert.equal(j.version, 1);
      assert.ok(j.impact.provable && j.impact.reported && j.impact.drift, "carries the ledger");
      assert.ok(Array.isArray(j.acks), "carries the acks card");
      // The whole point of the JSON surface vs the HTML report: no `generatedAt`,
      // so it is byte-identical across runs and diffable in CI.
      const serialized = JSON.stringify(j);
      assert.doesNotMatch(serialized, /generatedAt|UTC|\d{4}-\d{2}-\d{2}T/);
    });

    it("carries a covering ack into the acks array (round-trip)", async () => {
      // An additive export wakes auth file-grain; a file-grain ack covers it and
      // must surface in the report's machine acks card, not just the human/HTML one.
      await writeFile(
        join(tmp, "src", "auth", "login.ts"),
        "export const a = 1;\nexport const helper = () => 1;\n",
      );
      const { from, to } = fileContentTransition(tmp, "HEAD", "src/auth/login.ts");
      assert.ok(from && to);
      writeAck(tmp, {
        anchorId: "src/auth/login.ts",
        fromHash: from!,
        toHash: to!,
        reason: "additive helper; no public contract added",
        signer: "reviewer@team",
      });
      const j = buildReportJson(tmp);
      const fileAck = j.acks.find((a) => a.grain === "file" && a.anchorId === "src/auth/login.ts");
      assert.ok(fileAck, "the file-grain ack rides into report --json");
      assert.equal(fileAck.signer, "reviewer@team");
      assert.equal(fileAck.reason, "additive helper; no public contract added");
      // The report is a WORKING-TREE snapshot (base = HEAD, so HEAD..HEAD carries no
      // committed authorship): independence is fail-closed unverifiable here, exactly
      // as in the gate's strict mode. So even a different signer badges `independent:
      // false` on the report surface — an honest "cannot verify", never a false claim.
      assert.equal(fileAck.independent, false);
    });

    it("is byte-identical across runs and never writes an artifact", async () => {
      await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 6;\n");
      const here = dirname(fileURLToPath(import.meta.url));
      const CLI = join(here, "..", "dist", "cli.js");
      const runJson = () =>
        execFileSync("node", [CLI, "report", "--json"], { cwd: tmp, encoding: "utf-8" });
      const first = runJson();
      const second = runJson();
      assert.equal(first, second, "two runs produce byte-identical JSON (no timestamp drift)");
      const parsed = JSON.parse(first);
      assert.equal(parsed.version, 1);
      assert.ok(parsed.impact && Array.isArray(parsed.acks));
      assert.ok(!existsSync(join(tmp, ".codument", "report.html")), "no HTML artifact written");
    });

    it("refuses a subdirectory root with a machine-readable shape", async () => {
      await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 7;\n");
      const here = dirname(fileURLToPath(import.meta.url));
      const CLI = join(here, "..", "dist", "cli.js");
      let status = 0;
      let stdout = "";
      try {
        execFileSync("node", [CLI, "report", "--json"], {
          cwd: join(tmp, "src"),
          encoding: "utf-8",
        });
      } catch (err) {
        const e = err as { status?: number; stdout?: string };
        status = e.status ?? 1;
        stdout = e.stdout ?? "";
      }
      assert.equal(status, 1);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.version, 1);
      assert.equal(parsed.gate, "unavailable");
      assert.match(parsed.reason, /subdirectory/);
    });

    it("fails closed on a non-git tree — never a green all-zeros verdict (exit 1)", async () => {
      // The fail-open trap: a non-git directory has no verdict to compute, but the
      // ledger + acks both come back empty, so a naive `report --json` would emit a
      // clean `{impact: all-zeros, acks: []}` with exit 0 — CI would read "all clean"
      // from a tree that isn't even a repository. It must refuse like `review --json`.
      const nogit = await mkdtemp(join(tmpdir(), "codument-report-nogit-"));
      await mkdir(join(nogit, "docs"), { recursive: true });
      await writeFile(join(nogit, "docs", ".registry.json"), JSON.stringify({ features: {} }));
      const here = dirname(fileURLToPath(import.meta.url));
      const CLI = join(here, "..", "dist", "cli.js");
      try {
        let status = 0;
        let stdout = "";
        try {
          execFileSync("node", [CLI, "report", "--json"], { cwd: nogit, encoding: "utf-8" });
        } catch (err) {
          const e = err as { status?: number; stdout?: string };
          status = e.status ?? 1;
          stdout = e.stdout ?? "";
        }
        assert.equal(status, 1, "a non-git report --json exits nonzero");
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.gate, "unavailable");
        assert.match(parsed.reason, /not a git repository/);
        assert.equal(parsed.impact, undefined, "no green all-zeros ledger leaks through");
      } finally {
        await rm(nogit, { recursive: true, force: true });
      }
    });

    it("bare report (HTML) also fails closed on a non-git tree — no artifact, exit 1", async () => {
      // The fail-open bug this step fixed lived on BOTH surfaces: the guard's `else`
      // arm protects the shareable HTML too. Without this test, dropping that arm
      // would silently re-emit a green all-zeros report.html at exit 0 while the
      // whole suite stayed green (the --json half is a separate branch).
      const nogit = await mkdtemp(join(tmpdir(), "codument-report-nogit-html-"));
      await mkdir(join(nogit, "docs"), { recursive: true });
      await writeFile(join(nogit, "docs", ".registry.json"), JSON.stringify({ features: {} }));
      const here = dirname(fileURLToPath(import.meta.url));
      const CLI = join(here, "..", "dist", "cli.js");
      try {
        let status = 0;
        let stdout = "";
        try {
          execFileSync("node", [CLI, "report", "--no-open"], { cwd: nogit, encoding: "utf-8" });
        } catch (err) {
          const e = err as { status?: number; stdout?: string };
          status = e.status ?? 1;
          stdout = e.stdout ?? "";
        }
        assert.equal(status, 1, "HTML report on non-git exits nonzero");
        assert.match(stdout, /not a git repository/);
        assert.ok(
          !existsSync(join(nogit, ".codument", "report.html")),
          "no green all-zeros HTML artifact written",
        );
      } finally {
        await rm(nogit, { recursive: true, force: true });
      }
    });

    it("stays byte-identical across runs with a POPULATED ledger (float frictionRate, non-empty sets)", async () => {
      // The all-zeros envelope can't catch a determinism regression in the real
      // payload — the Set/Map-derived counts and the float frictionRate quotient.
      // Seed a caught event with mixed resolutions (frictionRate = 2/3, a repeating
      // decimal) and populated stale/risk/off-plan sets, then diff two real CLI runs.
      emitCaught(tmp, {
        commit: "seed",
        staleDocs: ["docs/features/auth.md", "docs/features/b.md"],
        riskTouches: ["auth", "b"],
        offPlan: ["src/x.ts"],
        driftTransitions: [
          { anchorId: "src/a.ts::x", from: "h1", to: "h2", resolution: "acked", comovement: "not-referenced" },
          { anchorId: "src/a.ts::y", from: "h3", to: "h4", resolution: "file-acked", comovement: "not-referenced" },
          { anchorId: "src/a.ts::z", from: "h5", to: "h6", resolution: "doc-updated", comovement: "co-moved" },
        ],
      });
      await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 9;\n");
      const here = dirname(fileURLToPath(import.meta.url));
      const CLI = join(here, "..", "dist", "cli.js");
      const run = () =>
        execFileSync("node", [CLI, "report", "--json"], { cwd: tmp, encoding: "utf-8" });
      const first = run();
      const second = run();
      assert.equal(first, second, "populated ledger is byte-identical across runs");
      const parsed = JSON.parse(first);
      assert.equal(
        parsed.impact.drift.frictionRate,
        2 / 3,
        "the repeating-decimal quotient is present — the populated path actually ran",
      );
      assert.equal(parsed.impact.provable.staleDocs, 2);
      assert.equal(parsed.impact.hasProvable, true);
      assert.doesNotMatch(first, /generatedAt|UTC|\d{4}-\d{2}-\d{2}T/);
    });

    it("report --json fails closed on a MID-COMPUTATION git failure (the inner catch)", async () => {
      // Distinct from the non-git and subdirectory guards: here isGitRepo passes and
      // the toplevel resolves (outer guards satisfied), but change-listing fails, so
      // buildReview throws GateError WHILE computing the verdict. The --json contract
      // must still emit the discriminated shape, never leak human text — the parity
      // guarantee review --json makes that review's single outer try structurally has
      // and report's separate inner try must reproduce.
      const fakeBin = await mkdtemp(join(tmpdir(), "codument-report-fakegit-"));
      const top = realpathSync(tmp);
      const FAKE = `#!/bin/sh
for a in "$@"; do
  [ "$a" = "--is-inside-work-tree" ] && { echo true; exit 0; }
  [ "$a" = "--show-toplevel" ] && { echo "${top}"; exit 0; }
done
exit 3
`;
      await writeFile(join(fakeBin, "git"), FAKE);
      await chmod(join(fakeBin, "git"), 0o755);
      const here = dirname(fileURLToPath(import.meta.url));
      const CLI = join(here, "..", "dist", "cli.js");
      try {
        let status = 0;
        let stdout = "";
        try {
          execFileSync("node", [CLI, "report", "--json"], {
            cwd: tmp,
            encoding: "utf-8",
            env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
          });
        } catch (err) {
          const e = err as { status?: number; stdout?: string };
          status = e.status ?? 1;
          stdout = e.stdout ?? "";
        }
        assert.equal(status, 1, "a mid-computation git failure exits nonzero");
        // The whole point: parseable JSON, not the human "gate could not run" line.
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.gate, "unavailable");
        assert.equal(parsed.version, 1);
      } finally {
        await rm(fakeBin, { recursive: true, force: true });
      }
    });
  });
});
