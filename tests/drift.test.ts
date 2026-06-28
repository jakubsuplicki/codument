import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { buildReview } from "../src/commands/review.js";
import { writeAck } from "../src/lib/acknowledgment.js";

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

  it("a moved symbol with an unreconciled doc is a drift finding AND a stale doc", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    const report = buildReview(tmp);

    // deterministic verdict: alpha's doc is stale (file did not change)
    assert.deepStrictEqual(report.state.staleDocs.map((d) => d.feature), ["alpha"]);

    // precise per-symbol trace, with co-movement telemetry + fingerprint transition
    const f = report.drift.find((d) => d.symbol === "foo");
    assert.ok(f, "a drift finding for foo");
    assert.equal(f?.kind, "changed");
    assert.equal(f?.feature, "alpha");
    assert.equal(f?.comovement, "prose-unchanged"); // the foo() line did not move
    assert.equal(f?.acknowledged, false);
    assert.ok(f?.from && f?.to && f.from !== f.to, "carries the from->to fingerprints");
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

  it("a recorded acknowledgment clears the finding AND the stale-doc verdict", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    const before = buildReview(tmp);
    const f = before.drift.find((d) => d.symbol === "foo");
    assert.ok(f?.from && f?.to);

    // the agent records "behavior-preserving, no doc change owed" for this exact move
    writeAck(tmp, {
      anchorId: f!.anchorId,
      fromHash: f!.from!,
      toHash: f!.to!,
      reason: "refactor: return value semantics unchanged",
      signer: "agent",
    });

    const after = buildReview(tmp);
    assert.deepStrictEqual(after.state.staleDocs, [], "ack adjudicates the move -> doc no longer stale");
    const acked = after.drift.find((d) => d.symbol === "foo");
    assert.equal(acked?.acknowledged, true);
    assert.equal(
      acked?.ackReason,
      "refactor: return value semantics unchanged",
      "the finding carries the covering ack's reason for review/--json to show",
    );
  });

  it("the acknowledgment auto-invalidates when the symbol moves again", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    const first = buildReview(tmp);
    const f = first.drift.find((d) => d.symbol === "foo")!;
    writeAck(tmp, {
      anchorId: f.anchorId,
      fromHash: f.from!,
      toHash: f.to!,
      reason: "refactor",
      signer: "agent",
    });
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, [], "covered while the fingerprint matches");

    // the symbol moves AGAIN: the head fingerprint changes, so the ack (bound to the
    // old `to`) no longer covers it — the flag returns, no ride-forever exemption.
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });
    const reMoved = buildReview(tmp);
    assert.deepStrictEqual(
      reMoved.state.staleDocs.map((d) => d.feature),
      ["alpha"],
      "a second move invalidates the stale ack",
    );
    assert.equal(reMoved.drift.find((d) => d.symbol === "foo")?.acknowledged, false);
  });
});
