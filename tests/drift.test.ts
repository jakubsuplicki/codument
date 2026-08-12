import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { buildReview } from "../src/commands/review.js";

let tmp: string;

function gitInit(root: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["add", "-A"]);
  run(["commit", "-m", "baseline"]);
}

async function scaffold(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(tmp, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

const REGISTRY = {
  features: {
    alpha: {
      doc: "docs/features/alpha.md",
      type: "feature",
      primary_sources: ["src/a.ts"],
      status: "current",
    },
  },
};

const A_SRC = "export function foo() {\n  return 1;\n}\n";

describe("drift wiring — per-symbol findings, acknowledgments, auto-invalidation", () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-drift-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(REGISTRY, null, 2),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "src/a.ts": A_SRC,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("a body-only move is reported in full and gates nothing (ADR 020)", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    const report = buildReview(tmp);

    // The whole point of ADR 020: an implementation edit is not a contract event,
    // and the only fix the gate could have demanded here was a signature nobody
    // reads back. Everything the tool KNOWS is still reported; only the block goes.
    assert.deepStrictEqual(
      report.state.staleDocs.map((d) => d.feature),
      [],
      "a body-only move never reaches the stale-doc verdict",
    );

    // precise per-symbol trace, with co-movement telemetry + fingerprint transition
    const f = report.drift.find((d) => d.symbol === "foo");
    assert.ok(f, "a drift finding for foo");
    assert.equal(f?.kind, "changed");
    assert.equal(f?.feature, "alpha");
    assert.equal(f?.comovement, "prose-unchanged"); // the foo() line did not move
    assert.equal(f?.acknowledged, false);
    assert.equal(f?.signatureChanged, false, "a return-value edit is a body-only move");
    assert.equal(f?.gates, false, "and so it is reported, never gated");
    assert.ok(f?.from && f?.to && f.from !== f.to, "carries the from->to fingerprints");
  });

  it("classifies a signature move (a contract change) on the finding, and it stays stale", async () => {
    // adding a parameter changes foo()'s contract, not just its body.
    await scaffold({ "src/a.ts": "export function foo(x: number) {\n  return x;\n}\n" });
    const report = buildReview(tmp);
    assert.deepStrictEqual(report.state.staleDocs.map((d) => d.feature), ["alpha"]);
    const f = report.drift.find((d) => d.symbol === "foo");
    assert.equal(f?.kind, "changed");
    assert.equal(f?.signatureChanged, true, "a new parameter is a signature move");
    // The other half of ADR 020, and the half that must not quietly widen: a
    // proven contract event still blocks exactly as it always did.
    assert.equal(f?.gates, true, "a contract move still gates");
  });

  it("co-movement reads as co-moved when the symbol's doc line is reconciled", async () => {
    await scaffold({
      "src/a.ts": A_SRC.replace("return 1;", "return 2;"),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper now returns two.\n",
    });
    const report = buildReview(tmp);
    // doc file changed -> not stale (file-grain); telemetry confirms the foo() line moved
    assert.deepStrictEqual(report.state.staleDocs, []);
    assert.equal(report.drift.find((d) => d.symbol === "foo")?.comovement, "co-moved");
  });

  // Both tests that used to live here proved the per-symbol acknowledgment
  // adjudicated a body-only move and then decayed on the next one. ADR 020 removes
  // the question: a body-only move never gates, so there is nothing for a per-symbol
  // ack to clear, and both would now pass vacuously — the verdict is already empty
  // before any ack is written. A test that cannot fail is the vacuous green the
  // conformance batteries exist to reject, so the property is asserted where it
  // still bites instead.
  //
  // Auto-invalidation itself is untouched and still covered: `acknowledgment.test.ts`
  // pins `ackCovers` decaying on a re-move directly, and the file- and tree-grain
  // suites in `ack.test.ts` exercise it end to end on the grains that still gate.
  it("a repeated body-only move needs no signature, and never accumulates one", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, [], "first move: reported, not gated");

    // The field's treadmill in two lines: the same file edited again in the next
    // step. Under 012 this re-fired the gate and bought a second near-identical
    // signature — thirty-eight of the field ledger's seventy-two were this shape.
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });
    const reMoved = buildReview(tmp);
    assert.deepStrictEqual(reMoved.state.staleDocs, [], "second move: still nothing to sign");
    const f = reMoved.drift.find((d) => d.symbol === "foo");
    assert.equal(f?.gates, false);
    assert.equal(f?.acknowledged, false, "and no acknowledgment was needed to get there");
  });
});
