import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReview, dependentLines, normalizeTestCommand } from "../src/commands/review.js";
import { writeAck } from "../src/lib/acknowledgment.js";
import { fileContentTransition } from "../src/lib/fingerprint.js";
import { forgetWorkspace, getWorkingTreeChanges } from "../src/lib/git.js";
import { worktreeChangesSince } from "../src/lib/two-ref.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

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

function gitCommitAll(root: string, message: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  run(["add", "-A"]);
  run(["commit", "-m", message]);
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
    auth: {
      doc: "docs/features/auth.md",
      type: "feature",
      primary_sources: ["src/auth/login.ts"],
      related_sources: ["src/lib/db.ts"],
      docs: [],
      depends_on: ["db"],
      risk: ["auth"],
      last_updated: "2026-06-16",
      status: "current",
    },
    db: {
      doc: "docs/concepts/db.md",
      type: "concept",
      primary_sources: ["src/lib/db.ts"],
      related_sources: [],
      docs: [],
      depends_on: [],
      risk: [],
      last_updated: "2026-06-16",
      status: "current",
    },
  },
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-review-"));
  await scaffold({
    "docs/.registry.json": JSON.stringify(REGISTRY, null, 2),
    "docs/features/auth.md": "# auth\n",
    "docs/concepts/db.md": "# db\n",
    "src/auth/login.ts": "export const login = () => {};\n",
    "src/lib/db.ts": "export const db = {};\n",
  });
  gitInit(tmp);
});
afterEach(async () => {
  forgetWorkspace();
  await rm(tmp, { recursive: true, force: true });
});

describe("buildReview (temp git repo)", () => {
  it("reports a clean working tree", () => {
    const report = buildReview(tmp);
    assert.equal(report.isGitRepo, true);
    assert.equal(report.changedFileCount, 0);
    assert.equal(report.state.changedSources.length, 0);
  });

  it("flags a stale doc, an unmapped change, a risk touch, and dependents", async () => {
    // change auth's source without its doc; add an unmapped file
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return true; };\n",
      "src/lib/cache.ts": "export const cache = {};\n",
    });

    const report = buildReview(tmp);
    assert.ok(report.changedFileCount >= 2);

    const stale = report.state.staleDocs.map((d) => d.feature);
    assert.ok(stale.includes("auth"), "auth doc is stale");

    assert.ok(report.state.unmapped.includes("src/lib/cache.ts"), "cache unmapped");

    const riskFeatures = report.state.riskTouches.map((r) => r.feature);
    assert.ok(riskFeatures.includes("auth"), "auth risk touched");
  });

  it("accepts a precomputed changed-file list and matches the self-computed report", async () => {
    // watch passes the working-tree changes it already gathered so the analyzer
    // doesn't re-run `git status`; the report must be identical either way.
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 7; };\n",
      "src/lib/cache.ts": "export const cache = {};\n",
    });
    const changes = getWorkingTreeChanges(tmp);
    const passed = buildReview(tmp, changes);
    const selfComputed = buildReview(tmp);
    assert.deepStrictEqual(passed, selfComputed);
    assert.equal(passed.changedFileCount, changes.length);
  });

  it("--base surfaces committed branch drift the working-tree view misses", async () => {
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    const baseSha = run(["rev-parse", "HEAD"]).trim();

    // commit a change to auth's source (not its doc) on a branch; leave the tree clean
    run(["checkout", "-b", "feature"]);
    await scaffold({ "src/auth/login.ts": "export const login = () => 42;\n" });
    run(["add", "-A"]);
    run(["commit", "-m", "change auth source, not its doc"]);

    // the working-tree view sees nothing — the change is committed, not pending
    assert.equal(getWorkingTreeChanges(tmp).length, 0);
    assert.equal(buildReview(tmp).state.staleDocs.length, 0);

    // the two-ref view (merge-base..working-tree) surfaces the committed drift.
    // The per-symbol anchor diff must use the SAME base as the changed-file set,
    // else HEAD (which already has the commit) shows no symbol movement — exactly
    // what `review --base` passes via resolveBase.
    const since = worktreeChangesSince(tmp, baseSha);
    assert.ok(since.includes("src/auth/login.ts"), "two-ref sees the committed change");
    const baseReport = buildReview(tmp, since, baseSha);
    assert.ok(
      baseReport.state.staleDocs.map((d) => d.feature).includes("auth"),
      "two-ref view flags auth's stale doc",
    );
  });

  it("flags out-of-plan changes when an approved plan is present", async () => {
    await scaffold({
      "docs/plans/add-thing.md":
        "---\ntitle: Add Thing\ntype: plan\nstatus: approved\n---\n\n## Scope\n\n- `src/lib/db.ts`\n",
      "src/auth/login.ts": "export const login = () => { return 1; };\n",
      "src/lib/db.ts": "export const db = { ok: true };\n",
    });

    const report = buildReview(tmp);
    assert.ok(report.plan, "approved plan detected");
    assert.deepStrictEqual(report.plan?.scope, ["src/lib/db.ts"]);
    // login.ts is outside the db-only plan scope
    assert.ok(report.state.outOfPlan.includes("src/auth/login.ts"));
    assert.ok(!report.state.outOfPlan.includes("src/lib/db.ts"));
  });

  it("warns, naming every approved plan and the winner, when more than one is approved", async () => {
    await scaffold({
      "docs/plans/add-thing.md": "---\nstatus: approved\n---\n\n## Scope\n\n- `src/lib/db.ts`\n",
      "docs/plans/other-thing.md":
        "---\nstatus: approved\n---\n\n## Scope\n\n- `src/auth/login.ts`\n",
      "src/lib/db.ts": "export const db = { ok: true };\n",
    });

    const out = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    assert.match(out, /2 approved plans/);
    assert.match(out, /add-thing\.md/);
    assert.match(out, /other-thing\.md/);
    assert.match(out, /scope taken from docs\/plans\/add-thing\.md/);
    assert.match(out, /keep exactly one approved/);
  });

  it("a changed non-ASCII / CJK registered source is owned and flags its doc stale, never unmapped (-z path decoding)", async () => {
    // Registry keyed by non-ASCII filenames. Under git's default core.quotePath a
    // changed `src/föo.ts` arrives octal-escaped (`src/f\303\266o.ts`) and never
    // matches this registry key — the file falls into `unmapped` and its doc reads
    // fresh. NUL-framed listing (`-z`) delivers the byte-exact path so it matches.
    const intlRegistry = {
      features: {
        intl: {
          doc: "docs/features/intl.md",
          type: "feature",
          primary_sources: ["src/föo.ts", "src/日本語.ts"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          last_updated: "2026-06-16",
          status: "current",
        },
      },
    };
    await scaffold({
      "docs/.registry.json": JSON.stringify(intlRegistry, null, 2),
      "docs/features/intl.md": "# intl\n",
      "src/föo.ts": "export const alpha = () => {};\n",
      "src/日本語.ts": "export const beta = () => {};\n",
    });
    // Commit the non-ASCII sources so the edit below is a modification of a tracked,
    // registered file rather than an untracked add.
    gitCommitAll(tmp, "add non-ascii sources");

    // Real per-symbol change to both, docs untouched.
    await scaffold({
      "src/föo.ts": "export const alpha = () => { return 1; };\n",
      "src/日本語.ts": "export const beta = () => { return 2; };\n",
    });

    const report = buildReview(tmp);
    assert.deepEqual(report.state.unmapped, [], "no non-ASCII path misclassified as unmapped");
    assert.ok(
      report.state.changedSources.includes("src/föo.ts"),
      "föo.ts recognized as a changed source",
    );
    assert.ok(
      report.state.changedSources.includes("src/日本語.ts"),
      "CJK source recognized as a changed source",
    );
    assert.ok(
      report.state.staleDocs.map((d) => d.feature).includes("intl"),
      "the owning doc is flagged stale with per-symbol drift",
    );
  });
});

describe("acks card — self vs independent (buildReview + review CLI)", () => {
  const AUTHOR = "Test <test@example.com>"; // what gitInit configures as the commit author

  const headSha = (): string =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf-8" }).trim();

  // Commit a body-only move of `login` (authored by AUTHOR, so it is a real change
  // author in base..HEAD), then record an ack for it signed by `signer`. Independence
  // is judged against the COMMIT author, not whoever runs review — so the review must
  // be run with `--base <baseSha>` to see the committed change.
  async function commitLoginMoveAndAck(signer: string): Promise<string> {
    const baseSha = headSha();
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 3; };\n" });
    gitCommitAll(tmp, "refactor login body");
    const since = worktreeChangesSince(tmp, baseSha);
    const f = buildReview(tmp, since, baseSha).drift.find((d) => d.symbol === "login");
    assert.ok(f?.from && f?.to, "login moved (a body-only, ackable change)");
    writeAck(tmp, {
      anchorId: f!.anchorId,
      fromHash: f!.from!,
      toHash: f!.to!,
      reason: "rename only; same call shape",
      signer,
    });
    return baseSha;
  }

  it("an ack signed by a change author is badged self", async () => {
    const baseSha = await commitLoginMoveAndAck(AUTHOR);
    const since = worktreeChangesSince(tmp, baseSha);
    const report = buildReview(tmp, since, baseSha);
    assert.equal(report.coveringAcks.length, 1);
    const ack = report.coveringAcks[0];
    assert.equal(ack.grain, "symbol");
    assert.equal(ack.symbol, "login");
    assert.equal(ack.independent, false, "signer is a commit author → self");

    const out = execFileSync("node", [CLI, "review", "--base", baseSha], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.match(out, /Acknowledgments in this change/);
    assert.match(out, /login \[self\]/);
    assert.match(out, /1 covering \(1 self\)/);
  });

  it("an ack signed by someone other than the change author is badged independent", async () => {
    const baseSha = await commitLoginMoveAndAck("Reviewer <reviewer@example.com>");
    const since = worktreeChangesSince(tmp, baseSha);
    const report = buildReview(tmp, since, baseSha);
    assert.equal(
      report.coveringAcks[0].independent,
      true,
      "signer is not among the commit authors → independent",
    );

    const out = execFileSync("node", [CLI, "review", "--base", baseSha], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.match(out, /login \[independent\]/);
    assert.match(out, /1 covering \(0 self\)/);
  });

  it("independence is keyed to the change author, not the review runner (CI purity)", async () => {
    // The change author's own self-ack must stay `self` even when review runs under a
    // DIFFERENT git identity (a fresh CI clone, a bot). This is the regression the
    // adversarial review caught: keying independence to `git config user.*` of the
    // runner flipped Alice's self-ack to a green [independent] badge in CI.
    const baseSha = await commitLoginMoveAndAck(AUTHOR);
    const since = worktreeChangesSince(tmp, baseSha);
    // Simulate a different runner: change the local git identity after authoring.
    execFileSync("git", ["config", "user.name", "CI Bot"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ci@bot"], { cwd: tmp, stdio: "ignore" });
    const report = buildReview(tmp, since, baseSha);
    assert.equal(
      report.coveringAcks[0].independent,
      false,
      "the AUTHOR's self-ack stays self even when a bot identity runs review",
    );
  });

  it("a file-grain ack appears in the card as a file, with its badge", async () => {
    // an additive export wakes auth file-grain; a file-grain ack covers it
    await scaffold({
      "src/auth/login.ts": "export const login = () => {};\nexport const helper = () => 1;\n",
    });
    const { from, to } = fileContentTransition(tmp, "HEAD", "src/auth/login.ts");
    assert.ok(from && to);
    writeAck(tmp, {
      anchorId: "src/auth/login.ts",
      fromHash: from!,
      toHash: to!,
      reason: "internal helper; no public contract added",
      signer: AUTHOR,
    });
    const report = buildReview(tmp);
    const fileAck = report.coveringAcks.find((a) => a.grain === "file");
    assert.ok(fileAck, "the file-grain ack is surfaced in the card");
    assert.equal(fileAck.symbol, null);
    assert.equal(fileAck.anchorId, "src/auth/login.ts");

    const out = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    assert.match(out, /src\/auth\/login\.ts \(file\)/);
  });

  it("no covering ack → no card (a clean self-review isn't hidden, but there's nothing to show)", async () => {
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 5; };\n" });
    const report = buildReview(tmp);
    assert.deepEqual(report.coveringAcks, []);
    const out = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    assert.doesNotMatch(out, /Acknowledgments in this change/);
  });
});

describe("--require-independent-ack (ADR 006 strict mode)", () => {
  const AUTHOR = "Test <test@example.com>";
  const headSha = (): string =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf-8" }).trim();

  // Commit a body-only move of `login` authored by AUTHOR, then ack it as `signer`.
  async function commitLoginMoveAndAck(
    signer: string,
  ): Promise<{ baseSha: string; since: string[] }> {
    const baseSha = headSha();
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 3; };\n" });
    gitCommitAll(tmp, "refactor login body");
    const since = worktreeChangesSince(tmp, baseSha);
    const f = buildReview(tmp, since, baseSha).drift.find((d) => d.symbol === "login");
    assert.ok(f?.from && f?.to);
    writeAck(tmp, {
      anchorId: f!.anchorId,
      fromHash: f!.from!,
      toHash: f!.to!,
      reason: "internal refactor; same shape",
      signer,
    });
    return { baseSha, since };
  }

  it("a self-signed ack does NOT clear the finding under the flag; it clears without it", async () => {
    const { baseSha, since } = await commitLoginMoveAndAck(AUTHOR);
    // no flag: the self-ack clears (byte-identical to before this step)
    const off = buildReview(tmp, since, baseSha);
    assert.deepEqual(off.state.staleDocs, [], "self-ack clears without the flag");
    assert.equal(off.requireIndependentAck, false);
    // flag on: the self-ack is not honored, so auth stays stale
    const on = buildReview(tmp, since, baseSha, undefined, { requireIndependentAck: true });
    assert.deepEqual(
      on.state.staleDocs.map((d) => d.feature),
      ["auth"],
      "a self-ack does not clear under --require-independent-ack",
    );
    assert.equal(on.requireIndependentAck, true);
    // the ignored self-ack is STILL shown in the card (not silently dropped)
    const ack = on.coveringAcks.find((a) => a.symbol === "login");
    assert.ok(ack, "the ignored self-ack is still surfaced");
    assert.equal(ack.independent, false);
  });

  it("an independent ack DOES clear the finding under the flag", async () => {
    const { baseSha, since } = await commitLoginMoveAndAck("Reviewer <reviewer@example.com>");
    const on = buildReview(tmp, since, baseSha, undefined, { requireIndependentAck: true });
    assert.deepEqual(on.state.staleDocs, [], "an independent ack clears even under the flag");
  });

  it("--strict + --require-independent-ack exits 1 on a self-acked move; the card marks it not counted", async () => {
    const { baseSha } = await commitLoginMoveAndAck(AUTHOR);
    // bare (no --strict) is informational → exit 0, but the card marks the self-ack ignored
    const out = execFileSync(
      "node",
      [CLI, "review", "--base", baseSha, "--require-independent-ack"],
      { cwd: tmp, encoding: "utf-8" },
    );
    assert.match(out, /login \[self — not counted\]/);
    assert.match(out, /self-signed ack does not clear/);
    // with --strict the self-acked stale doc fails the gate
    assert.throws(
      () =>
        execFileSync(
          "node",
          [CLI, "review", "--base", baseSha, "--require-independent-ack", "--strict"],
          { cwd: tmp, encoding: "utf-8" },
        ),
      (e: unknown) => (e as { status?: number }).status === 1,
      "a self-acked stale doc fails --strict under the flag",
    );
  });

  it("an independent ack passes --strict --require-independent-ack (exit 0)", async () => {
    const { baseSha } = await commitLoginMoveAndAck("Reviewer <reviewer@example.com>");
    const out = execFileSync(
      "node",
      [CLI, "review", "--base", baseSha, "--require-independent-ack", "--strict"],
      { cwd: tmp, encoding: "utf-8" },
    );
    assert.match(out, /login \[independent\]/);
  });

  it("fail-open closed: an UNCOMMITTED ack cannot launder past the flag (authorship unverifiable)", async () => {
    // A prior commit by someone else populates the commit-author set; the acked move
    // itself is UNCOMMITTED, so its author is not in that set. Keying independence to
    // committed authorship over an uncommitted change would falsely read "independent"
    // (signer not among the committed authors) and clear the finding — the laundering
    // hole the adversarial review found. It must fail CLOSED: nothing clears.
    const baseSha = headSha();
    execFileSync(
      "git",
      ["commit", "--allow-empty", "-m", "someone else's commit", "--author=Bob <bob@example.com>"],
      { cwd: tmp, stdio: "ignore" },
    );
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 7; };\n" });
    const since = worktreeChangesSince(tmp, baseSha);
    const f = buildReview(tmp, since, baseSha).drift.find((d) => d.symbol === "login");
    assert.ok(f?.from && f?.to);
    // even a "stranger" signer (not Bob) must not clear an uncommitted change
    writeAck(tmp, {
      anchorId: f!.anchorId,
      fromHash: f!.from!,
      toHash: f!.to!,
      reason: "trust me",
      signer: "Mallory <mallory@example.com>",
    });
    const on = buildReview(tmp, since, baseSha, undefined, { requireIndependentAck: true });
    assert.equal(on.independenceUnverifiable, true, "an uncommitted change → unverifiable");
    assert.deepEqual(
      on.state.staleDocs.map((d) => d.feature),
      ["auth"],
      "no ack clears an uncommitted change under the flag (fail closed)",
    );
  });

  it("a signature-move ack is never shown as covering (matches the gate, which never honors it)", async () => {
    const baseSha = headSha();
    await scaffold({ "src/auth/login.ts": "export const login = (x: number) => x;\n" }); // param added → signature move
    gitCommitAll(tmp, "signature change");
    const since = worktreeChangesSince(tmp, baseSha);
    const f = buildReview(tmp, since, baseSha).drift.find((d) => d.symbol === "login");
    assert.ok(f?.signatureChanged, "the move is a signature change");
    // a hand-written / merged ack naming the exact sig-move transition exists...
    writeAck(tmp, {
      anchorId: f!.anchorId,
      fromHash: f!.from!,
      toHash: f!.to!,
      reason: "trust me",
      signer: "Reviewer <reviewer@example.com>",
    });
    const report = buildReview(tmp, since, baseSha);
    assert.ok(
      !report.coveringAcks.some((a) => a.symbol === "login"),
      "a signature-move ack is not shown as a covering ack",
    );
    assert.deepEqual(
      report.state.staleDocs.map((d) => d.feature),
      ["auth"],
      "and the gate keeps the signature move flagged",
    );
  });
});

describe("codument review (CLI)", () => {
  it("--json emits the contract and exits 0", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 2; };\n",
    });
    const out = execFileSync("node", [CLI, "review", "--json"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    const report = JSON.parse(out);
    assert.equal(report.version, 2);
    assert.equal(report.gate, "ok");
    assert.equal(report.isGitRepo, true);
    assert.ok(report.state.staleDocs.some((d: { feature: string }) => d.feature === "auth"));
  });

  it("human output names stale docs", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 3; };\n",
    });
    const out = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    assert.match(out, /Stale docs/);
    assert.match(out, /auth/);
  });

  it("forks each drift finding (update doc vs ack) with the exact ack command + a resolution summary", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 3; };\n",
    });
    const out = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    assert.match(out, /Symbol drift/);
    assert.match(out, /contract changed →/); // the doc-update arm is shown...
    assert.match(out, /codument ack src\/auth\/login\.ts::login/); // ...alongside the ack arm
    assert.match(out, /Drift resolution: 1 owned symbol\(s\) moved/);
    assert.match(out, /1 still flagged/);
  });

  it("a correct intent-altitude doc edit resolves the drift — the surface mirrors the verdict, not co-movement (ADR 010)", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return true; };\n",
      // The doc is updated in plain English, deliberately WITHOUT naming `login`
      // (the standard forbids symbol mirrors). The verdict clears because the doc
      // changed; the surface must agree, not nag via co-movement.
      "docs/features/auth.md":
        "# auth\n\n## In plain terms\nSign-in now succeeds for valid input.\n",
    });
    const report = buildReview(tmp);
    assert.ok(
      !report.state.staleDocs.some((d: { feature: string }) => d.feature === "auth"),
      "verdict: auth is not stale once its doc was edited",
    );
    const out = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    assert.match(out, /1 resolved by doc update/);
    assert.match(out, /0 still flagged/);
    assert.doesNotMatch(out, /Symbol drift/);
  });

  it("lists applied acknowledgments with their reason and counts them in the summary", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 3; };\n",
    });
    const f = buildReview(tmp).drift.find((d) => d.symbol === "login");
    assert.ok(f?.from && f?.to);
    writeAck(tmp, {
      anchorId: f!.anchorId,
      fromHash: f!.from!,
      toHash: f!.to!,
      reason: "rename only; same call shape",
      signer: "agent",
    });
    const out = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    assert.match(out, /Acknowledgments in this change/);
    assert.match(out, /rename only; same call shape/);
    assert.match(out, /1 acked \(contract-neutral\)/);
  });

  it("--log writes a caught snapshot with finding identities", async () => {
    await scaffold({
      "docs/plans/add-thing.md":
        "---\ntitle: Add Thing\ntype: plan\nstatus: approved\n---\n\n## Scope\n\n- `src/lib/db.ts`\n",
      // auth source changes without its doc (stale + risk), and an off-plan file
      "src/auth/login.ts": "export const login = () => { return 9; };\n",
    });
    execFileSync("node", [CLI, "review", "--log"], { cwd: tmp, encoding: "utf-8" });
    const log = await readFile(join(tmp, ".codument", "events.jsonl"), "utf-8");
    const caught = log
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "caught");
    assert.ok(caught, "a caught event was written");
    assert.deepEqual(caught.data.staleDocs, ["docs/features/auth.md"]);
    assert.deepEqual(caught.data.riskTouches, ["auth"]);
    assert.ok(caught.data.offPlan.includes("src/auth/login.ts"));
    assert.equal(typeof caught.data.commit, "string");
  });

  it("--strict exits 1 on an unmapped new source", async () => {
    await scaffold({ "src/lib/cache.ts": "export const cache = {};\n" });
    assert.throws(
      () =>
        execFileSync("node", [CLI, "review", "--strict"], {
          cwd: tmp,
          encoding: "utf-8",
        }),
      (err: unknown) => (err as { status?: number }).status === 1,
    );
  });

  it("--strict exits 1 on a stale doc (mapped source changed, doc did not)", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 6; };\n",
    });
    assert.throws(
      () =>
        execFileSync("node", [CLI, "review", "--strict"], {
          cwd: tmp,
          encoding: "utf-8",
        }),
      (err: unknown) => (err as { status?: number }).status === 1,
    );
  });

  it("--strict exits 0 when new sources are mapped and docs are fresh", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 5; };\n",
      "docs/features/auth.md": "# auth\n\ntouched\n",
    });
    const out = execFileSync("node", [CLI, "review", "--strict"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.match(out, /codument review/);
  });

  it("--strict --json still emits the contract and exits 1 on an unmapped source", async () => {
    await scaffold({ "src/lib/cache.ts": "export const cache = {};\n" });
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [CLI, "review", "--strict", "--json"], {
        cwd: tmp,
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 0;
      stdout = e.stdout ?? "";
    }
    assert.equal(status, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.version, 2);
    assert.equal(report.gate, "ok");
  });

  it("--bundle emits the oracle; --record then --require-review enforces, and a later edit auto-invalidates", async () => {
    // A risk-tagged source change (auth) is non-trivial → the gate requires a review.
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 3; };\n" });

    // --bundle reflects the current diff.
    const bundle = JSON.parse(
      execFileSync("node", [CLI, "review", "--bundle"], { cwd: tmp, encoding: "utf-8" }),
    );
    assert.ok(typeof bundle.base === "string" && bundle.base.length > 0, "bundle has a base");
    assert.ok(
      bundle.changedSources.includes("src/auth/login.ts"),
      "bundle names the changed source",
    );

    const requireReview = (): { status: number; out: string } => {
      try {
        return {
          status: 0,
          out: execFileSync("node", [CLI, "review", "--require-review"], {
            cwd: tmp,
            encoding: "utf-8",
          }),
        };
      } catch (err) {
        const e = err as { status?: number; stdout?: string };
        return { status: e.status ?? 0, out: e.stdout ?? "" };
      }
    };

    // Before any review, a non-trivial diff fails closed.
    const before = requireReview();
    assert.equal(before.status, 1, "unreviewed non-trivial diff is blocked");
    assert.match(before.out, /no current adversarial review/);

    // Record a clean review — the writer computes the fingerprint over THIS diff.
    await writeFile(
      join(tmp, "findings.json"),
      JSON.stringify({
        invariantsChecked: ["login returns a constant"],
        findings: [],
        signer: "test",
      }),
    );
    const recordOut = execFileSync("node", [CLI, "review", "--record", "findings.json"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.match(recordOut, /Recorded adversarial review/);

    // Now the gate is covered and passes.
    const covered = requireReview();
    assert.equal(covered.status, 0, "the recorded review covers the diff");
    assert.match(covered.out, /covers this diff/);

    // Editing a reviewed source moves the fingerprint → the review auto-invalidates.
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 999; };\n" });
    const after = requireReview();
    assert.equal(after.status, 1, "an edit after review reopens the gate");
    assert.match(after.out, /no current adversarial review/);
  });

  it("--bundle scopes to what moved since the last recording; --full forces the whole set", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 3; };\n",
      "src/lib/db.ts": "export const db = () => { return 1; };\n",
    });
    await writeFile(
      join(tmp, "findings.json"),
      JSON.stringify({
        invariantsChecked: ["login returns a constant"],
        findings: [
          { citation: "src/auth/login.ts:1", detail: "returns the wrong constant", status: "advisory", failingTest: null },
        ],
        signer: "test",
      }),
    );

    const readBundle = (args: string[] = []) =>
      JSON.parse(
        execFileSync("node", [CLI, "review", "--bundle", ...args], {
          cwd: tmp,
          encoding: "utf-8",
        }),
      );

    // With no prior review the bundle is full-scoped — byte-identical to the
    // pre-delta behavior, and it says so.
    const first = readBundle();
    assert.equal(first.scope, "full");
    assert.deepEqual(first.alreadyReviewed, []);
    assert.deepEqual(first.priorFindings, []);
    assert.ok(first.changedSources.includes("src/auth/login.ts"));
    assert.ok(first.changedSources.includes("src/lib/db.ts"));

    execFileSync("node", [CLI, "review", "--record", "findings.json"], {
      cwd: tmp,
      encoding: "utf-8",
    });

    // Fix ONE file. The next bundle attacks that file alone and hands the reviewer
    // the untouched files plus the findings the last round raised, as context.
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 4; };\n" });
    const delta = readBundle();
    assert.equal(delta.scope, "delta");
    assert.deepEqual(delta.changedSources, ["src/auth/login.ts"]);
    assert.ok(delta.alreadyReviewed.includes("src/lib/db.ts"), "untouched file is context");
    assert.equal(delta.priorFindings.length, 1);
    assert.match(delta.priorFindings[0].detail, /wrong constant/);
    // The contract block is NEVER scoped: every touched feature keeps its oracle.
    assert.deepEqual(
      delta.features.map((f: { feature: string }) => f.feature).sort(),
      ["auth", "db"],
    );

    // --full is the escape hatch back to a deliberate fresh attack.
    const full = readBundle(["--full"]);
    assert.equal(full.scope, "full");
    assert.ok(full.changedSources.includes("src/lib/db.ts"));
    assert.deepEqual(full.priorFindings, []);

    // And the gate is unmoved by any of this: the fix voided the artifact.
    let status = 0;
    let out = "";
    try {
      out = execFileSync("node", [CLI, "review", "--require-review"], {
        cwd: tmp,
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 0;
      out = e.stdout ?? "";
    }
    assert.equal(status, 1, "a delta bundle does not soften the gate");
    // …and the block names the size of the re-attack instead of demanding the diff
    // be reviewed from scratch again.
    assert.match(out, /1 file moved since your last recorded review/);
    assert.doesNotMatch(out, /Run a fresh adversarial review of this diff/);
  });

  it("--record rejects a malformed review (empty invariantsChecked) without writing it", async () => {
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 4; };\n" });
    await writeFile(
      join(tmp, "bad.json"),
      JSON.stringify({ invariantsChecked: [], findings: [], signer: "test" }),
    );
    let status = 0;
    let out = "";
    try {
      out = execFileSync("node", [CLI, "review", "--record", "bad.json"], {
        cwd: tmp,
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 0;
      out = e.stdout ?? "";
    }
    assert.equal(status, 1, "a silent-pass review is rejected");
    assert.match(out, /invalid review/);
  });
});

describe("review from a subdirectory of a repo (fail closed)", () => {
  function run(args: string[], cwd: string): { status: number; stdout: string } {
    try {
      const stdout = execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8" });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
  }

  it("errors loudly, naming both paths — never a wrong verdict", () => {
    // From src/ git reports toplevel-relative paths that can never match the
    // package-relative registry: every file would read unmapped and every doc
    // fresh. The gate must refuse to answer the wrong question.
    const { status, stdout } = run(["review"], join(tmp, "src"));
    assert.equal(status, 1, "exit 1 even without --strict: the verdict would be wrong");
    assert.match(stdout, /subdirectory/);
    assert.match(stdout, /gate could not run/);
    // The message must name BOTH paths: the offending root and the toplevel to
    // run from. The child realpaths its cwd (macOS /var → /private/var), so
    // compare against the canonical spelling.
    const top = realpathSync.native(tmp);
    assert.ok(stdout.includes(join(top, "src")), "names the offending subdirectory");
    assert.ok(stdout.includes(`run it from ${top}`), "names the toplevel as the fix");
    assert.doesNotMatch(stdout, /Working tree clean/);
  });

  it("--json emits the discriminated unavailable shape and exits 1", () => {
    const { status, stdout } = run(["review", "--json"], join(tmp, "src"));
    assert.equal(status, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.version, 2);
    assert.equal(report.gate, "unavailable");
    assert.match(report.reason, /subdirectory/);
    assert.ok(!("state" in report), "no state emitted for a gate that could not run");
  });
});

describe("--require-review names the could-not-run condition (no resolvable tsx)", () => {
  // The availability probe asks the real npx, which may resolve a global tsx on
  // a dev machine — shadow npx with an exit-1 shim so "cannot resolve without a
  // fetch" is deterministic here.
  let fakeBin: string;
  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), "codument-fake-npx-"));
    await writeFile(join(fakeBin, "npx"), "#!/bin/sh\nexit 1\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(join(fakeBin, "npx"), 0o755);
  });
  afterEach(async () => {
    await rm(fakeBin, { recursive: true, force: true });
  });

  function run(args: string[], cwd: string): { status: number; stdout: string } {
    try {
      const stdout = execFileSync("node", [CLI, ...args], {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
  }

  it("a project without resolvable tsx sees the named condition, not a silent advisory", async () => {
    // non-trivial diff (two changed sources) in a project with no node_modules
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 7; };\n",
      "src/lib/db.ts": "export const db = { v: 7 };\n",
    });
    const { status, stdout } = run(["review", "--require-review"], tmp);
    assert.equal(status, 1, "uncovered non-trivial diff still fails the gate");
    assert.match(stdout, /confirm step could not run/);
    assert.match(stdout, /no local tsx/);
    assert.match(stdout, /--test-command/);
  });

  it("a custom --test-command suppresses the condition (the project owns its runner)", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 8; };\n",
      "src/lib/db.ts": "export const db = { v: 8 };\n",
    });
    const { stdout } = run(
      ["review", "--require-review", "--test-command", "node --test {file}"],
      tmp,
    );
    assert.doesNotMatch(stdout, /confirm step could not run/);
  });

  it("--json carries the condition on the reviewGate shape", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 9; };\n",
      "src/lib/db.ts": "export const db = { v: 9 };\n",
    });
    const { stdout } = run(["review", "--require-review", "--json"], tmp);
    const report = JSON.parse(stdout);
    assert.match(report.reviewGate.confirmUnavailable, /no local tsx/);
  });

  it("a declared testCommand suppresses it too — the runner is project config, not a per-run flag", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 10; };\n",
      "src/lib/db.ts": "export const db = { v: 10 };\n",
      ".codument-meta.json": JSON.stringify({
        version: "0.13.0",
        initialized: "2026-08-05",
        project: {},
        testCommand: "node --test {file}",
      }),
    });
    const { stdout } = run(["review", "--require-review"], tmp);
    assert.doesNotMatch(stdout, /confirm step could not run/);
  });

  it("a declared testCommand with no {file} slot is refused out loud, not silently obeyed", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 11; };\n",
      "src/lib/db.ts": "export const db = { v: 11 };\n",
      ".codument-meta.json": JSON.stringify({
        version: "0.13.0",
        initialized: "2026-08-05",
        project: {},
        // No {file}: this would run the whole suite once per finding.
        testCommand: "npm test",
      }),
    });
    const { status, stdout } = run(["review", "--require-review"], tmp);
    assert.match(stdout, /no \{file\} token/);
    assert.match(stdout, /default runner is used instead/);
    // …and it must not take down the rest of the command.
    assert.equal(status, 1, "the gate verdict is unaffected by the config problem");
  });
});

describe("the could-not-run condition is keyed on OUTCOMES, not on which flag was passed", () => {
  function run(args: string[], cwd: string): { status: number; stdout: string } {
    try {
      return { status: 0, stdout: execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8" }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
  }

  it("names how many findings went unjudged when the configured runner cannot adjudicate", async () => {
    await scaffold({
      "src/auth/login.ts": "export const login = () => { return 12; };\n",
      "src/lib/db.ts": "export const db = { v: 12 };\n",
      // A runner that exits nonzero with no test output — a toolchain failure, the
      // exact shape of a project pointed at a non-TAP-emitting reporter.
      ".codument-meta.json": JSON.stringify({
        version: "0.13.0",
        initialized: "2026-08-05",
        project: {},
        testCommand: "node -e process.exit(1) {file}",
      }),
      "broken.test.ts": "// a real file so the reference resolves\n",
    });
    await writeFile(
      join(tmp, "findings.json"),
      JSON.stringify({
        invariantsChecked: ["login returns a constant"],
        findings: [
          {
            citation: "src/auth/login.ts:1",
            detail: "wrong constant",
            status: "confirmed",
            failingTest: "broken.test.ts",
          },
        ],
        signer: "test",
      }),
    );
    execFileSync("node", [CLI, "review", "--record", "findings.json"], {
      cwd: tmp,
      encoding: "utf-8",
    });

    const { stdout } = run(["review", "--require-review"], tmp);
    // The old flag-keyed condition would say nothing here: a command WAS supplied.
    assert.match(stdout, /1 finding could not be adjudicated/);
    assert.match(stdout, /no test evidence/);
    assert.doesNotMatch(stdout, /no local tsx/);
  });
});

describe("deletions are first-class in the verdict", () => {
  function run(args: string[], cwd: string): { status: number; stdout: string } {
    try {
      const stdout = execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8" });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
  }

  it("deleting a mapped primary source flags its doc stale and fails --strict", async () => {
    await rm(join(tmp, "src", "auth", "login.ts"));

    const report = buildReview(tmp);
    assert.deepEqual(report.deletions, ["src/auth/login.ts"]);
    assert.ok(report.changedFileCount >= 1, "a deletion-only tree is not clean");
    assert.deepEqual(report.state.deletedSources, ["src/auth/login.ts"]);
    assert.ok(
      report.state.staleDocs.some((d) => d.feature === "auth"),
      "the owning doc is woken by the deletion",
    );

    const strict = run(["review", "--strict"], tmp);
    assert.equal(
      strict.status,
      1,
      "--strict fails on a deleted owned source with an unchanged doc",
    );
    assert.match(strict.stdout, /deleted/i);
    assert.doesNotMatch(strict.stdout, /Working tree clean/);
  });

  it("removing the registry entry in the same change cannot dodge the wake", async () => {
    await rm(join(tmp, "src", "auth", "login.ts"));
    // the dodge: drop auth from the registry in the same change
    const gutted = JSON.parse(JSON.stringify(REGISTRY)) as typeof REGISTRY;
    delete (gutted.features as Record<string, unknown>).auth;
    await scaffold({ "docs/.registry.json": JSON.stringify(gutted, null, 2) });

    const report = buildReview(tmp);
    assert.ok(
      report.state.staleDocs.some((d) => d.feature === "auth" && d.doc === "docs/features/auth.md"),
      "the entry that owned the file at base still flags its doc",
    );
    assert.equal(run(["review", "--strict"], tmp).status, 1);
  });

  it("wholesale removal (source + doc + entry) is resolved, not stale", async () => {
    await rm(join(tmp, "src", "auth", "login.ts"));
    await rm(join(tmp, "docs", "features", "auth.md"));
    const gutted = JSON.parse(JSON.stringify(REGISTRY)) as typeof REGISTRY;
    delete (gutted.features as Record<string, unknown>).auth;
    await scaffold({ "docs/.registry.json": JSON.stringify(gutted, null, 2) });

    const report = buildReview(tmp);
    assert.ok(
      !report.state.staleDocs.some((d) => d.feature === "auth"),
      "deleting the doc with its source is the doc attention owed",
    );
  });

  it("a corrupt registry AT THE BASE fails loud — never a silent fallback to the current one", async () => {
    // The base registry is what makes the entry-removal dodge impossible; if it
    // cannot be parsed the gate must say so, not quietly resolve deletions
    // against whatever the working tree claims.
    await scaffold({ "docs/.registry.json": '{ "features": { "auth": broken' });
    gitCommitAll(tmp, "corrupt registry");
    await scaffold({ "docs/.registry.json": JSON.stringify(REGISTRY, null, 2) });
    await rm(join(tmp, "src", "auth", "login.ts"));

    const { status, stdout } = run(["review"], tmp);
    assert.equal(status, 1);
    assert.match(stdout, /unreadable/);
    assert.match(stdout, /@HEAD|HEAD/);
  });

  it("--base surfaces a COMMITTED deletion the working-tree view misses", async () => {
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmp,
      encoding: "utf-8",
    }).trim();
    await rm(join(tmp, "src", "auth", "login.ts"));
    gitCommitAll(tmp, "delete login");

    // working-tree view: clean (the deletion is committed)
    assert.equal(buildReview(tmp).state.staleDocs.length, 0);

    // two-ref view since the baseline: the deletion wakes auth
    const { status, stdout } = run(["review", "--base", baseline, "--json"], tmp);
    assert.equal(status, 0);
    const report = JSON.parse(stdout);
    assert.deepEqual(report.state.deletedSources, ["src/auth/login.ts"]);
    assert.ok(
      report.state.staleDocs.some((d: { feature: string }) => d.feature === "auth"),
      "the committed deletion flags the doc against the merge-base",
    );
  });
});

describe("dependentLines (the section that used to print one line per edge)", () => {
  const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");
  const dep = (feature: string, dependsOn: string[], viaUmbrella = false) => ({
    feature,
    dependsOn,
    viaUmbrella,
  });

  it("renders nothing when there are no dependents", () => {
    assert.deepEqual(dependentLines([]), []);
  });

  it("leads with a count, collapses a feature's edges onto one line, and caps the list", () => {
    const summary = Array.from({ length: 8 }, (_, i) => dep(`f${i}`, ["a", "b"]));
    const lines = dependentLines(summary).map(strip);
    assert.equal(lines[0], "8 dependent features");
    assert.match(lines[1], /^• f0 \(depends on a, b\)$/);
    // 1 count line + 5 named + 1 trailing collapse
    assert.equal(lines.length, 7);
    assert.equal(lines[6], "… and 3 more");
  });

  it("names how many are umbrella-only, and never lists one before a real edge", () => {
    const lines = dependentLines([
      dep("real", ["feat"]),
      dep("weak", ["lib"], true),
    ]).map(strip);
    assert.equal(lines[0], "2 dependent features (1 only via a concept umbrella)");
    assert.match(lines[1], /^• real /);
    assert.match(lines[2], /^• weak /);
  });

  it("says 'feature' not 'features' for one", () => {
    assert.equal(strip(dependentLines([dep("a", ["b"])])[0]), "1 dependent feature");
  });
});

describe("normalizeTestCommand", () => {
  it("splits a single quoted-string command on whitespace (the leading-dash workaround)", () => {
    assert.deepEqual(normalizeTestCommand(["npx tsx --test {file}"]), [
      "npx",
      "tsx",
      "--test",
      "{file}",
    ]);
    assert.deepEqual(normalizeTestCommand(["vitest run {file}"]), ["vitest", "run", "{file}"]);
  });
  it("passes real multi-element argv through unchanged", () => {
    assert.deepEqual(normalizeTestCommand(["vitest", "run", "{file}"]), [
      "vitest",
      "run",
      "{file}",
    ]);
  });
  it("leaves a single whitespace-free token as a one-element argv", () => {
    assert.deepEqual(normalizeTestCommand(["./run-tests"]), ["./run-tests"]);
  });
  it("returns undefined for empty / missing input", () => {
    assert.equal(normalizeTestCommand(undefined), undefined);
    assert.equal(normalizeTestCommand([]), undefined);
  });
});

describe("review in a non-git directory (fail closed)", () => {
  let nonGit: string;
  beforeEach(async () => {
    nonGit = await mkdtemp(join(tmpdir(), "codument-nongit-"));
  });
  afterEach(async () => {
    await rm(nonGit, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number; stdout: string } {
    try {
      const stdout = execFileSync("node", [CLI, ...args], {
        cwd: nonGit,
        encoding: "utf-8",
      });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? "" };
    }
  }

  it("bare review stays informational (exit 0)", () => {
    const r = run(["review"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Not a git repository/);
  });

  it("--strict fails closed (exit 1, gate could not run)", () => {
    const r = run(["review", "--strict"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /gate could not run/);
  });

  it("--require-review fails closed (exit 1)", () => {
    assert.equal(run(["review", "--require-review"]).status, 1);
  });

  it("--json emits a valid discriminated shape, never a null state", () => {
    const j = JSON.parse(run(["review", "--json"]).stdout);
    assert.equal(j.version, 2);
    assert.equal(j.gate, "unavailable");
    assert.equal(j.isGitRepo, false);
    assert.ok(!("state" in j), "unavailable shape carries no state field");
  });

  it("--json --strict emits the shape and exits 1", () => {
    const r = run(["review", "--json", "--strict"]);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).gate, "unavailable");
  });
});

// Plan 17 step 2: a stale doc caused by a FILE-grain (coarse) source must print
// both honest routes — doc update or file-grain ack — right where the pressure
// is, and the --strict epilogue must name the ack path. A precisely-evaluated
// file keeps its per-symbol resolution and gains no file-grain line.
describe("coarse-file ack signpost", () => {
  it("a coarse stale doc prints both routes and strict names the ack path", async () => {
    await scaffold({
      "docs/features/util.md": "# util\n",
      "src/util.js": "export function fmt(x) { return String(x); }\n",
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            util: {
              doc: "docs/features/util.md",
              type: "feature",
              primary_sources: ["src/util.js"],
              related_sources: [],
              docs: [],
              depends_on: [],
              risk: [],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    });
    gitInit(tmp);
    await scaffold({ "src/util.js": "export function fmt(x) { return `v:${x}`; }\n" });
    let out = "";
    try {
      out = execFileSync("node", [CLI, "review", "--strict"], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      assert.fail("strict must exit nonzero on the stale doc");
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      assert.equal(e.status, 1);
      out = e.stdout ?? "";
    }
    assert.ok(out.includes("no doc impact →"), "both-routes signpost missing");
    assert.ok(out.includes('codument ack src/util.js --reason "..."'), "pasteable ack missing");
    assert.ok(out.includes("doc impact    →"), "doc-update route missing");
    assert.ok(
      out.includes("acknowledge a change that owes no doc line"),
      "strict epilogue must name the ack path",
    );
  });

  it("a precise stale doc gets no file-grain line (per-symbol drift owns it)", async () => {
    await scaffold({
      "docs/features/auth.md": "# auth\n",
      "docs/concepts/db.md": "# db\n",
      "src/auth/login.ts": "export function login(u: string) { return u; }\n",
      "src/lib/db.ts": "export const db = 1;\n",
      "docs/.registry.json": JSON.stringify(REGISTRY, null, 2),
    });
    gitInit(tmp);
    await scaffold({
      "src/auth/login.ts": "export function login(u: string) { return u.trim(); }\n",
    });
    let out = "";
    try {
      out = execFileSync("node", [CLI, "review", "--strict"], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? "";
    }
    assert.ok(out.includes("Symbol drift"), "per-symbol drift block expected");
    assert.ok(
      !out.includes("no doc impact →"),
      "a precisely-evaluated file must not get the file-grain signpost",
    );
  });
});

// Plan 41 / probe C: `git mv` on a registered source presented to the gate as a
// bare add. The destination failed as unmapped (correct), the origin was never
// mentioned, and once the new path was registered and the stale doc resolved the
// gate went GREEN with the registry still naming a file that no longer exists.
describe("a rename never leaves the registry pointing at a ghost (probe C)", () => {
  function runReview(args: string[] = ["review", "--strict"]): { code: number; out: string } {
    try {
      const out = execFileSync("node", [CLI, ...args], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? "" };
    }
  }

  const registryFor = (sources: string[]) =>
    JSON.stringify(
      {
        features: {
          i18n: {
            doc: "docs/features/i18n.md",
            type: "feature",
            primary_sources: sources,
            related_sources: [],
            docs: [],
            depends_on: [],
            risk: [],
            status: "current",
          },
        },
      },
      null,
      2,
    );

  it("the field sequence stays RED until the entry stops naming the origin", async () => {
    await scaffold({
      "docs/features/i18n.md": "# i18n\n\nFormats dates for display.\n",
      "i18n/format.ts": "export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n",
      "docs/.registry.json": registryFor(["i18n/format.ts"]),
    });
    gitInit(tmp);

    execFileSync("git", ["mv", "i18n/format.ts", "i18n/dateFormat.ts"], { cwd: tmp });

    // 1. The destination is unmapped (this part always worked) AND the origin is
    //    now named — the half that used to be invisible.
    let r = runReview();
    assert.equal(r.code, 1, `a rename must gate:\n${r.out}`);
    assert.ok(r.out.includes("i18n/format.ts"), `the vanished path must be named:\n${r.out}`);
    assert.ok(
      r.out.includes("Registry names a path this change removed"),
      `the pointer finding must render:\n${r.out}`,
    );

    // 2. Register the new path but leave the old one — the field's end state,
    //    which used to be GREEN with a permanent ghost in the registry.
    await scaffold({
      "docs/.registry.json": registryFor(["i18n/format.ts", "i18n/dateFormat.ts"]),
    });
    r = runReview();
    assert.equal(r.code, 1, `the ghost pointer must keep the gate red:\n${r.out}`);
    assert.ok(r.out.includes("i18n/format.ts"), "the ghost must still be named");

    // 3. Drop the origin: the registry is honest again and the gate goes green.
    await scaffold({ "docs/.registry.json": registryFor(["i18n/dateFormat.ts"]) });
    r = runReview();
    assert.equal(r.code, 0, `re-pointing the entry resolves it:\n${r.out}`);
  });

  it("a file SPLIT stays satisfiable — the origin is still there, so nothing was removed", async () => {
    // `git mv a b` then re-create `a` as a re-export shim: git reports a rename
    // whose origin is present on disk. Read as a move, the gate demanded the
    // registry stop naming a file you can see — and no registry state satisfied
    // it: dropping the entry made the shim unmapped, keeping it re-fired the
    // pointer, and there is no ack for a pointer. An unsatisfiable --strict is
    // worse than the false green this plan set out to close.
    await scaffold({
      "docs/features/i18n.md": "# i18n\n\nFormats dates for display.\n",
      "i18n/format.ts": "export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n",
      "docs/.registry.json": registryFor(["i18n/format.ts"]),
    });
    gitInit(tmp);

    execFileSync("git", ["mv", "i18n/format.ts", "i18n/dateFormat.ts"], { cwd: tmp });
    await scaffold({ "i18n/format.ts": 'export { formatDate } from "./dateFormat.js";\n' });

    // Guard the fixture: this only tests anything while git still calls it a
    // rename. If it stops, the test must fail rather than pass for a new reason.
    const porcelain = execFileSync("git", ["status", "--porcelain", "-uall"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.ok(/^R/m.test(porcelain), `expected git to report a rename:\n${porcelain}`);

    // The origin is NOT a removed path — it is right there — so no pointer fires.
    let r = runReview();
    assert.ok(
      !r.out.includes("Registry names a path this change removed"),
      `a path present on disk was not removed:\n${r.out}`,
    );

    // And the honest end state — both files owned, doc updated — is reachable.
    await scaffold({
      "docs/.registry.json": registryFor(["i18n/format.ts", "i18n/dateFormat.ts"]),
      "docs/features/i18n.md": "# i18n\n\nFormats dates for display, via a re-export shim.\n",
    });
    r = runReview();
    assert.equal(r.code, 0, `the split's correct end state must be reachable:\n${r.out}`);
  });

  it("every surface reports the pointer — none of them says clean while the gate is red", async () => {
    // The state that exposed it: a registered source deleted, the owning doc
    // updated in the same change (so the deletion's DOC debt is paid), the entry
    // still naming the path. `--strict` fails on the pointer alone, which left
    // watch printing ✓ CLEAN, the HTML report saying "Nothing suspicious", and CI
    // uploading a SARIF with zero results beside a check that exited 1.
    await scaffold({
      "docs/features/i18n.md": "# i18n\n\nFormats dates for display.\n",
      "i18n/format.ts": "export const version = 1;\n",
      "docs/.registry.json": registryFor(["i18n/format.ts"]),
    });
    gitInit(tmp);

    execFileSync("git", ["rm", "-q", "i18n/format.ts"], { cwd: tmp });
    await scaffold({ "docs/features/i18n.md": "# i18n\n\nDate formatting was removed.\n" });

    const strict = runReview();
    assert.equal(strict.code, 1, `the pointer alone must fail --strict:\n${strict.out}`);
    // …and the epilogue must not offer a route that cannot clear it.
    assert.match(strict.out, /re-point the entry|drop it/i, "names the fix that works");
    assert.doesNotMatch(
      strict.out.split("--strict:")[1] ?? "",
      /codument ack/,
      "no acknowledgment clears a pointer, so none is offered under it",
    );

    const watch = runReview(["watch", "--once"]);
    assert.match(watch.out, /registry pointer/i, `watch must not omit it:\n${watch.out}`);

    const sarif = runReview(["review", "--format", "sarif"]);
    const results = JSON.parse(sarif.out).runs[0].results as Array<{ ruleId: string }>;
    assert.ok(
      results.some((r) => r.ruleId === "codument/registry-pointer"),
      "a red check must never upload a SARIF that reads as a clean pass",
    );

    runReview(["report", "--no-open"]);
    const html = await readFile(join(tmp, ".codument", "report.html"), "utf-8");
    assert.match(html, /names a path this change removed/, "the report card renders");
    assert.doesNotMatch(html, /Nothing suspicious/, "the page must not call it clear");
  });

  it("a PRE-EXISTING dangle never blocks an unrelated change", async () => {
    await scaffold({
      "docs/features/i18n.md": "# i18n\n",
      "i18n/index.ts": "export const a = 1;\n",
      // `i18n/gone.ts` was never in the tree — old debt, doctor's business.
      "docs/.registry.json": registryFor(["i18n/index.ts", "i18n/gone.ts"]),
    });
    gitInit(tmp);
    await scaffold({
      "i18n/index.ts": "export const a = 2;\n",
      "docs/features/i18n.md": "# i18n\n\nHolds the value.\n",
    });
    const r = runReview();
    assert.equal(r.code, 0, `pre-existing dangles are doctor's, not review's:\n${r.out}`);
    assert.ok(
      !r.out.includes("Registry names a path this change removed"),
      "review must not claim this change removed it",
    );
  });
});

// Plan 39: two rendering findings from the same field session.
describe("the verdict is the last line, and a single-anchor file says something new", () => {
  function run(args: string[]): { code: number; out: string } {
    try {
      return {
        code: 0,
        out: execFileSync("node", [CLI, ...args], {
          cwd: tmp,
          encoding: "utf-8",
          env: { ...process.env, NO_COLOR: "1" },
        }),
      };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? "" };
    }
  }
  const lastLine = (out: string): string => out.trimEnd().split("\n").pop() ?? "";

  const REGISTRY = JSON.stringify(
    {
      features: {
        ui: {
          doc: "docs/features/ui.md",
          type: "feature",
          primary_sources: ["app/Button.tsx", "app/two.ts"],
          status: "current",
        },
      },
    },
    null,
    2,
  );

  async function fixture(): Promise<void> {
    await scaffold({
      "docs/features/ui.md": "# ui\n\n## In plain terms\nButtons.\n",
      "app/Button.tsx":
        "export default function Button(props: { label: string }) {\n  return props.label;\n}\n",
      "app/two.ts": "export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n",
      "docs/.registry.json": REGISTRY,
    });
    gitInit(tmp);
  }

  it("`| tail -1` reads the verdict on a red run and on a clean one", async () => {
    // The report's author grepped piped output instead of trusting the exit code
    // and called the habit fragile — rightly, since `$?` after a pipe is the last
    // command's status, not the gate's. The exit code stays the contract; this
    // stops the fragile habit from producing a false green.
    await fixture();
    await scaffold({
      "app/Button.tsx":
        "export default function Button(props: { label: string }) {\n  return props.label.trim();\n}\n",
    });

    const red = run(["review", "--strict"]);
    assert.equal(red.code, 1);
    assert.match(lastLine(red.out), /^codument review: BLOCKED — 1 stale doc\(s\)$/);

    await scaffold({ "docs/features/ui.md": "# ui\n\n## In plain terms\nButtons, trimmed.\n" });
    const green = run(["review", "--strict"]);
    assert.equal(green.code, 0);
    assert.equal(lastLine(green.out), "codument review: clean");

    // And bare `review` — informational, exit 0 — still ends with a verdict.
    assert.equal(lastLine(run(["review"]).out), "codument review: clean");
  });

  it("a file whose only anchor is the module one is named by file, and says body vs contract", async () => {
    // ADR 014 gives every default-exported component one `default.` anchor, so the
    // drift line read `default (changed)` — the symbol name IS the file, and the
    // line told the reader nothing the change list had not. Name the file, and
    // spend the line on what was never visible: whether the contract moved.
    await fixture();
    await scaffold({
      "app/Button.tsx":
        "export default function Button(props: { label: string }) {\n  return props.label.trim();\n}\n",
      "app/two.ts": "export function alpha() {\n  return 11;\n}\nexport function beta() {\n  return 2;\n}\n",
    });
    const out = run(["review", "--strict"]).out;
    assert.match(out, /• app\/Button\.tsx \(body changed\) in ui/);
    assert.doesNotMatch(out, /• default \(changed\)/, "the symbol name added nothing");
    // A multi-symbol file is untouched: there the symbol name is the information.
    assert.match(out, /• alpha \(changed\) in ui/);
    // The ack route still names the precise anchor — the collapse is rendering only.
    assert.match(out, /codument ack app\/Button\.tsx::default\. --reason/);
  });

  it("a contract move on that same shape says contract, not body", async () => {
    await fixture();
    await scaffold({
      "app/Button.tsx":
        "export default function Button(props: { label: string; tone: string }) {\n  return props.label;\n}\n",
    });
    const out = run(["review", "--strict"]).out;
    assert.match(out, /• app\/Button\.tsx \(contract changed\) in ui/);
    assert.match(out, /signature move/, "and a signature move still refuses the ack route");
  });
});

// Plan 36 / the 2026-08-07 field report's "worst part by far": a one-line edit to a
// file three features claim left three docs stale, no ack cleared it, and the agent
// paid with prose written into five docs. The WAKE is ADR 004 working — an unclaimed
// shared symbol wakes every candidate rather than guessing. What failed was routing:
// the resolution printed as a ⚠ advisory below the blocking line (ignored 25 times in
// one run), and the stale-doc hint recommended a file-grain ack, which structurally
// cannot clear a wake driven by a changed unassigned anchor (two dead acks banked).
describe("an unclaimed shared file says how to stop being one (plan 36)", () => {
  function runReview(args: string[] = ["review", "--strict"]): { code: number; out: string } {
    try {
      const out = execFileSync("node", [CLI, ...args], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? "" };
    }
  }

  const CONTESTED = "app/components/Button.tsx";
  const feature = (key: string, extra: Record<string, unknown> = {}) => ({
    doc: `docs/features/${key}.md`,
    type: "feature",
    primary_sources: [CONTESTED],
    status: "current",
    ...extra,
  });

  async function threeOwners(extra: Record<string, Record<string, unknown>> = {}): Promise<void> {
    await scaffold({
      "docs/features/cart.md": "# cart\n\n## In plain terms\nThe cart.\n",
      "docs/features/checkout.md": "# checkout\n\n## In plain terms\nCheckout.\n",
      "docs/features/product.md": "# product\n\n## In plain terms\nProduct.\n",
      [CONTESTED]:
        "export default function Button(props: { label: string }) {\n  return props.label;\n}\n",
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            cart: feature("cart", extra.cart),
            checkout: feature("checkout", extra.checkout),
            product: feature("product", extra.product),
          },
        },
        null,
        2,
      ),
    });
    gitInit(tmp);
    await scaffold({
      [CONTESTED]:
        "export default function Button(props: { label: string }) {\n  return props.label.trim();\n}\n",
    });
  }

  it("the field replay: the fix is on the blocking line, stated once, and no dead ack is offered", async () => {
    await threeOwners();
    const r = runReview();
    assert.equal(r.code, 1);

    // The condition is named ON the red line — the whole defect was that these
    // words printed somewhere else.
    const epilogue = r.out.split("--strict:")[1] ?? "";
    assert.match(epilogue, /shared file .*no feature claims per-symbol/);
    assert.match(epilogue, /owned_symbols.*related_sources|related_sources.*owned_symbols/);

    // The ack route is withheld: every stale doc here traces to the unclaimed
    // symbol, and no ack of any grain clears one. Offering it is what banked two
    // inert acks in the field.
    assert.doesNotMatch(epilogue, /codument ack/, "no ack can clear this, so none is offered");
    assert.doesNotMatch(
      r.out,
      /no doc impact →/,
      "and the per-file file-ack hint is withheld for the same reason",
    );

    // Both real fixes are printed, with the paste-ready registry fragment…
    assert.match(r.out, /"owned_symbols": \{ "app\/components\/Button\.tsx": \["default\."\] \}/);
    assert.match(r.out, /related_sources of checkout and product/);
    // …exactly once, though three docs woke: it is one file, so one registry edit.
    const shown = r.out.match(/shared symbol no feature claims/g) ?? [];
    assert.equal(shown.length, 1, `stated once, not once per woken doc:\n${r.out}`);
    assert.equal((r.out.match(/woken by the same unclaimed shared file/g) ?? []).length, 2);
  });

  it("a whole-file anchor leads with the demotion, since claiming it IS file ownership", async () => {
    // ADR 014's shape — a default-exported component or config has ONE anchor, so
    // "claim the symbol" and "own the file" are the same act said two ways. The
    // field's contested files were all this shape.
    await threeOwners();
    const out = runReview(["review"]).out;
    const demote = out.indexOf("demote it →");
    const claim = out.indexOf("claim it  →");
    assert.ok(demote > 0 && claim > 0, `both fixes printed:\n${out}`);
    assert.ok(demote < claim, "the demotion leads for a single whole-file anchor");
  });

  it("a per-symbol split leads with the claim, because there is something to split", async () => {
    await scaffold({
      "docs/features/cart.md": "# cart\n\n## In plain terms\nThe cart.\n",
      "docs/features/checkout.md": "# checkout\n\n## In plain terms\nCheckout.\n",
      "src/shared.ts": "export function priceOf() {\n  return 1;\n}\nexport function taxOf() {\n  return 2;\n}\n",
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            cart: { ...feature("cart"), primary_sources: ["src/shared.ts"] },
            checkout: { ...feature("checkout"), primary_sources: ["src/shared.ts"] },
          },
        },
        null,
        2,
      ),
    });
    gitInit(tmp);
    await scaffold({
      "src/shared.ts": "export function priceOf() {\n  return 11;\n}\nexport function taxOf() {\n  return 2;\n}\n",
    });
    const out = runReview(["review"]).out;
    const demote = out.indexOf("demote it →");
    const claim = out.indexOf("claim it  →");
    assert.ok(demote > 0 && claim > 0, `both fixes printed:\n${out}`);
    assert.ok(claim < demote, "with real symbols to divide, claiming leads");
  });

  it("the file-ack hint survives where a file ack genuinely clears the wake", async () => {
    // The control for the withheld hint above: withholding must come from
    // clearability, not from suppressing the hint whenever ownership is contested.
    await scaffold({
      "docs/features/site.md": "# site\n\n## In plain terms\nStyles.\n",
      "app/site.css": "body { color: red; }\n",
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            site: { ...feature("site"), primary_sources: ["app/site.css"] },
          },
        },
        null,
        2,
      ),
    });
    gitInit(tmp);
    await scaffold({ "app/site.css": "body { color: blue; }\n" });
    const r = runReview();
    assert.equal(r.code, 1);
    assert.match(r.out, /no doc impact →/, "a coarse file's ack route still prints");
    assert.match(r.out, /codument ack app\/site\.css/);
  });

  it("either fix ends the churn: one wake, and one ack clears it", async () => {
    // The acceptance criterion, and the proof that this plan changed no semantics —
    // both resolutions were always available, they were just never named.
    await threeOwners({ cart: { owned_symbols: { [CONTESTED]: ["default."] } } });
    let r = runReview();
    assert.equal((r.out.match(/^ {4}⚠ \w+: docs/gm) ?? []).length, 1, "one doc wakes, not three");
    const m = r.out.match(/codument ack (\S+) --reason/);
    assert.ok(m, `a claimed symbol is ackable again:\n${r.out}`);
    execFileSync("node", [CLI, "ack", m![1], "--reason", "same props in, same node out"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.equal(runReview().code, 0, "and the ack clears the gate");

    // The demotion reaches the same place by the other route.
    rmSync(join(tmp, ".codument", "acks"), { recursive: true, force: true });
    await scaffold({
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            cart: feature("cart"),
            checkout: { ...feature("checkout"), primary_sources: [], related_sources: [CONTESTED] },
            product: { ...feature("product"), primary_sources: [], related_sources: [CONTESTED] },
          },
        },
        null,
        2,
      ),
    });
    r = runReview();
    assert.equal((r.out.match(/^ {4}⚠ \w+: docs/gm) ?? []).length, 1, "one wake by demotion too");
  });

  it("a symbol two features BOTH claim gets the opposite fix, not the same one", async () => {
    await threeOwners({
      cart: { owned_symbols: { [CONTESTED]: ["default."] } },
      checkout: { owned_symbols: { [CONTESTED]: ["default."] } },
    });
    const out = runReview(["review"]).out;
    assert.match(out, /shared symbol claimed by more than one feature/);
    assert.match(out, /remove .* from owned_symbols in all but one of cart and checkout/);
    assert.doesNotMatch(out, /claim it {2}→/, "adding another claim would make it worse");
  });
});

// ADR 017 SUPERSEDES the plan-17 info-only stance for OWNED unjudgeable files.
// This suite used to assert that a changed registered .css left `--strict` green
// with a grey advisory — which is exactly the false green a field probe caught on
// a registered locale pack (the app's whole user-visible string surface, rewritten
// to a different contract, exit 0). A registration is an explicit claim that a file
// is load-bearing to a named doc, so an OWNED one is now governed at file grain.
// The info-only surface survives for what is genuinely ungoverned: an impact-only
// (`related_sources`) registration, and one the exclusion spec drops.
describe("governed registered changes in review (ADR 017)", () => {
  function runReview(): { code: number; out: string } {
    try {
      const out = execFileSync("node", [CLI, "review", "--strict"], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? "" };
    }
  }

  const registryWith = (site: Record<string, unknown>) =>
    JSON.stringify({ features: { site: { doc: "docs/features/site.md", type: "feature", docs: [], depends_on: [], risk: [], status: "current", ...site } } }, null, 2);

  it("FIELD REPLAY: rewriting an owned unjudgeable file gates, and both resolutions clear it", async () => {
    await scaffold({
      "docs/features/site.md": "# site\n",
      "app/site.css": ".hero { color: red; }\n",
      "docs/.registry.json": registryWith({
        primary_sources: ["app/site.css"],
        related_sources: [],
      }),
    });
    gitInit(tmp);

    // 1. The false green, closed: an owned unjudgeable file's content moved.
    await scaffold({ "app/site.css": ".hero { color: green; }\n" });
    let r = runReview();
    assert.equal(r.code, 1, `an owned unjudgeable change must gate, got:\n${r.out}`);
    assert.ok(r.out.includes("app/site.css"), "file not named");
    assert.ok(r.out.includes("docs/features/site.md"), "owning doc not named");

    // 2. A file-grain ack clears it — the ack route reaches unjudgeable files.
    execFileSync("node", [CLI, "ack", "app/site.css", "--reason", "palette only; no documented contract moved"], {
      cwd: tmp,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    r = runReview();
    assert.equal(r.code, 0, `a file-grain ack must clear it, got:\n${r.out}`);

    // 3. The ack is content-bound: the next edit re-wakes it (no ride-forever).
    await scaffold({ "app/site.css": ".hero { color: blue; }\n" });
    r = runReview();
    assert.equal(r.code, 1, "the ack must auto-invalidate when the file moves again");

    // 4. Doc attention clears it too — the other honest resolution.
    await scaffold({ "docs/features/site.md": "# site\n\nThe hero reads blue.\n" });
    r = runReview();
    assert.equal(r.code, 0, `a doc update must clear it, got:\n${r.out}`);
  });

  it("the counts line names governed changes instead of burying them in 'other'", async () => {
    await scaffold({
      "docs/features/site.md": "# site\n",
      "app/site.css": ".hero { color: red; }\n",
      "docs/.registry.json": registryWith({
        primary_sources: ["app/site.css"],
        related_sources: [],
      }),
    });
    gitInit(tmp);
    await scaffold({ "app/site.css": ".hero { color: green; }\n", "notes.txt": "scratch\n" });
    const r = runReview();
    assert.ok(r.out.includes("1 governed"), `governed not named:\n${r.out}`);
    assert.ok(r.out.includes("1 other"), `the ungoverned remainder is still other:\n${r.out}`);
    assert.ok(!r.out.includes("2 other"), "a governed file must not be counted as other too");
  });

  it("the residue splits: an excluded registration reads as a contradiction, not 'verify by hand'", async () => {
    await scaffold({
      "docs/features/site.md": "# site\n",
      "src/site.ts": "export const a = 1;\n",
      "types/api.d.ts": "export declare const x: number;\n",
      "docs/.registry.json": registryWith({
        primary_sources: ["src/site.ts", "types/api.d.ts"],
        related_sources: [],
      }),
    });
    gitInit(tmp);
    await scaffold({ "types/api.d.ts": "export declare const x: string;\n" });
    const r = runReview();
    assert.equal(r.code, 0, "exclusion still overrides registration — no gate");
    assert.ok(
      r.out.includes("Registered but excluded"),
      `the contradiction must be named as such:\n${r.out}`,
    );
    assert.ok(r.out.includes("types/api.d.ts"), "file not named");
  });

  it("a governed DELETION is visible, not silent (probe D)", async () => {
    await scaffold({
      "docs/features/site.md": "# site\n",
      "app/site.css": ".hero { color: red; }\n",
      "docs/.registry.json": registryWith({
        primary_sources: ["app/site.css"],
        related_sources: [],
      }),
    });
    gitInit(tmp);
    rmSync(join(tmp, "app/site.css"));
    let r = runReview();
    assert.equal(r.code, 1, `deleting an owned governed file must gate:\n${r.out}`);
    // The deletions section is what NAMES the removal. Asserting the header is the
    // bite: drop the governed half of that section and the header disappears
    // entirely, leaving an anonymous "1 deleted" in the headline — probe D's
    // original silence. (The filename alone would not prove it: other sections
    // mention the path too.)
    assert.ok(
      r.out.includes("Deleted sources"),
      `the deletions section must render for a governed deletion:\n${r.out}`,
    );
    assert.ok(r.out.includes("app/site.css"), `the removed file must be named:\n${r.out}`);

    // Full resolution takes both halves: the doc owes attention for the removal,
    // and the registry must stop naming a path that no longer exists (plan 41).
    await scaffold({
      "docs/features/site.md": "# site\n\nThe hero style was removed.\n",
      "docs/.registry.json": registryWith({ primary_sources: [], related_sources: [] }),
    });
    r = runReview();
    assert.equal(r.code, 0, `doc attention + a clean registry resolves it:\n${r.out}`);
  });

  it("an impact-only registration stays info-only and green", async () => {
    await scaffold({
      "docs/features/site.md": "# site\n",
      "src/site.ts": "export const a = 1;\n",
      "app/site.css": ".hero { color: red; }\n",
      "docs/.registry.json": registryWith({
        primary_sources: ["src/site.ts"],
        related_sources: ["app/site.css"],
      }),
    });
    gitInit(tmp);
    await scaffold({ "app/site.css": ".hero { color: green; }\n" });
    const r = runReview();
    assert.equal(r.code, 0, `related_sources claims impact, never ownership:\n${r.out}`);
    assert.ok(r.out.includes("Registered as impact only"), "info section missing");
    assert.ok(r.out.includes("app/site.css"), "file not named");
  });
});

// Plan 17 acceptance: the full config-file arc, end to end — the exact friction
// from the website dogfood, proven dead at the root.
describe("config-file grain arc (nuxt.config.ts shape)", () => {
  const CONFIG_REGISTRY = JSON.stringify(
    {
      features: {
        site: {
          doc: "docs/features/site.md",
          type: "feature",
          primary_sources: ["nuxt.config.ts"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current",
        },
      },
    },
    null,
    2,
  );
  const BASE = [
    "// site config",
    "export default defineNuxtConfig({",
    "  modules: ['@nuxt/content'],",
    "})",
    "",
  ].join("\n");

  function runReview(): { code: number; out: string } {
    try {
      const out = execFileSync("node", [CLI, "review", "--strict"], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? "" };
    }
  }

  it("comment edit silent; value edit one ackable finding; ack clears; callee swap refused", async () => {
    await scaffold({
      "docs/features/site.md": "# site\n",
      "nuxt.config.ts": BASE,
      "docs/.registry.json": CONFIG_REGISTRY,
    });
    gitInit(tmp);

    // 1. A comment-only edit fires nothing (the pre-ALGO-4 behavior fired here).
    await scaffold({ "nuxt.config.ts": BASE.replace("// site config", "// reworded") });
    let r = runReview();
    assert.equal(r.code, 0, `comment edit must be silent, got:\n${r.out}`);

    // 2. A value edit is ONE named body-only finding with a pasteable per-symbol ack.
    await scaffold({
      "nuxt.config.ts": BASE.replace("'@nuxt/content'", "'@nuxt/content', '@nuxt/image'"),
    });
    r = runReview();
    assert.equal(r.code, 1, "value edit must gate");
    assert.ok(r.out.includes("default"), "the default anchor must be named");
    assert.ok(
      r.out.includes("codument ack nuxt.config.ts::default."),
      "pasteable per-symbol ack expected",
    );

    // 3. The pasted ack clears it.
    execFileSync(
      "node",
      [CLI, "ack", "nuxt.config.ts::default.", "--reason", "module list grew; site contract unchanged"],
      { cwd: tmp, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );
    r = runReview();
    assert.equal(r.code, 0, `ack must clear the gate, got:\n${r.out}`);

    // 4. Swapping the producing callee is a signature move: ack refused, doc owed.
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "--no-verify", "-m", "config change"], {
      cwd: tmp,
      stdio: "ignore",
    });
    await scaffold({
      "nuxt.config.ts": BASE.replace("'@nuxt/content'", "'@nuxt/content', '@nuxt/image'").replace(
        "defineNuxtConfig",
        "defineOtherConfig",
      ),
    });
    r = runReview();
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("[signature changed]"), "callee swap must read as a signature move");
    assert.throws(
      () =>
        execFileSync(
          "node",
          [CLI, "ack", "nuxt.config.ts::default.", "--reason", "should be refused"],
          { cwd: tmp, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" }, stdio: "pipe" },
        ),
      "a signature move must not be ackable",
    );
  });
});

describe("python settings arc (Django settings.py shape)", () => {
  const PY_REGISTRY = JSON.stringify(
    {
      features: {
        settings: {
          doc: "docs/features/settings.md",
          type: "feature",
          primary_sources: ["app/settings.py"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current",
        },
      },
    },
    null,
    2,
  );
  const BASE = [
    '"""Project settings."""',
    "",
    "DEBUG = True",
    'ALLOWED_HOSTS = ["localhost"]  # hosts allowed in dev',
    "",
    'def get_database_url(name="default"):',
    "    # resolved lazily in dev",
    "    return DATABASES[name]",
    "",
    'register_app("web")',
    "",
  ].join("\n");

  function runReview(...extra: string[]): { code: number; out: string } {
    try {
      const out = execFileSync("node", [CLI, "review", "--strict", ...extra], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? "" };
    }
  }

  it("comment edit silent; value edit one ackable finding; ack clears; signature move refused; never ungated", async () => {
    await scaffold({
      "docs/features/settings.md": "# settings\n\nDEBUG and the database url resolver.\n",
      "app/settings.py": BASE,
      "docs/.registry.json": PY_REGISTRY,
    });
    gitInit(tmp);

    // 1. A comment-only edit fires nothing — token-stream invariance for Python.
    await scaffold({
      "app/settings.py": BASE.replace("# hosts allowed in dev", "# reworded comment"),
    });
    let r = runReview();
    assert.equal(r.code, 0, `comment edit must be silent, got:\n${r.out}`);

    // 2. A settings VALUE edit is ONE named, body-only, ackable finding — and the
    // file is GATED per-symbol, never riding the ungated-registered surface.
    await scaffold({ "app/settings.py": BASE.replace("DEBUG = True", "DEBUG = False") });
    r = runReview();
    assert.equal(r.code, 1, "value edit must gate");
    assert.ok(r.out.includes("DEBUG"), "the DEBUG anchor must be named");
    assert.ok(
      r.out.includes("codument ack app/settings.py::DEBUG."),
      `pasteable per-symbol ack expected, got:\n${r.out}`,
    );
    const json = JSON.parse(
      execFileSync("node", [CLI, "review", "--json"], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      }),
    );
    assert.deepEqual(json.state.ungatedRegistered, [], "a governed .py is never 'ungated'");
    assert.deepEqual(
      json.state.staleDocs.map((d: { feature: string }) => d.feature),
      ["settings"],
    );

    // 3. The pasted ack clears it.
    execFileSync(
      "node",
      [CLI, "ack", "app/settings.py::DEBUG.", "--reason", "dev default flipped; contract unchanged"],
      { cwd: tmp, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );
    r = runReview();
    assert.equal(r.code, 0, `ack must clear the gate, got:\n${r.out}`);

    // 4. A default-value change on a documented def is a SIGNATURE move: the gate
    // says so and the ack path refuses it.
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "--no-verify", "-m", "settings change"], {
      cwd: tmp,
      stdio: "ignore",
    });
    await scaffold({
      "app/settings.py": BASE.replace("DEBUG = True", "DEBUG = False").replace(
        'name="default"',
        'name="primary"',
      ),
    });
    r = runReview();
    assert.equal(r.code, 1);
    assert.ok(
      r.out.includes("[signature changed]"),
      `a default-value change must read as a signature move, got:\n${r.out}`,
    );
    assert.throws(
      () =>
        execFileSync(
          "node",
          [CLI, "ack", "app/settings.py::get_database_url().", "--reason", "should be refused"],
          { cwd: tmp, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" }, stdio: "pipe" },
        ),
      "a signature move must not be ackable",
    );
  });
});

describe("sfc component arc (the website dogfood shape)", () => {
  const SFC_REGISTRY = JSON.stringify(
    {
      features: {
        hero: {
          doc: "docs/features/hero.md",
          type: "feature",
          primary_sources: ["components/Hero.vue"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current",
        },
        footer: {
          doc: "docs/features/footer.md",
          type: "feature",
          primary_sources: ["components/Footer.vue"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current",
        },
      },
    },
    null,
    2,
  );
  const HERO = [
    "<template>",
    "  <!-- hero headline -->",
    "  <h1>{{ headline() }}</h1>",
    "</template>",
    "",
    '<script setup lang="ts">',
    "function headline(): string {",
    '  return "hi";',
    "}",
    "</script>",
    "",
    "<style scoped>",
    ".hero { color: red; }",
    "</style>",
    "",
  ].join("\n");
  const FOOTER = "<template><footer>© zenzero</footer></template>\n";

  function runReview(): { code: number; out: string } {
    try {
      const out = execFileSync("node", [CLI, "review", "--strict"], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? "" };
    }
  }

  it("a component edit wakes exactly its owning doc; a template tweak is one ackable finding; a script contract change refuses the ack", async () => {
    await scaffold({
      "docs/features/hero.md": "# hero\n\nThe headline component.\n",
      "docs/features/footer.md": "# footer\n",
      "components/Hero.vue": HERO,
      "components/Footer.vue": FOOTER,
      "docs/.registry.json": SFC_REGISTRY,
    });
    gitInit(tmp);

    // 1. A markup comment reword fires nothing.
    await scaffold({
      "components/Hero.vue": HERO.replace("<!-- hero headline -->", "<!-- reworded -->"),
    });
    let r = runReview();
    assert.equal(r.code, 0, `comment edit must be silent, got:\n${r.out}`);

    // 2. A real template tweak is ONE named ackable finding on the owning
    // feature only — Footer's doc must not wake (the cascade stays dissolved).
    await scaffold({
      "components/Hero.vue": HERO.replace("<h1>{{ headline() }}</h1>", "<h2>{{ headline() }}</h2>"),
    });
    r = runReview();
    assert.equal(r.code, 1, "template tweak must gate");
    assert.ok(r.out.includes("template"), "the template pseudo-anchor must be named");
    assert.ok(!r.out.includes("footer"), `footer must not wake, got:\n${r.out}`);
    assert.ok(
      r.out.includes("codument ack components/Hero.vue::template."),
      `pasteable template ack expected, got:\n${r.out}`,
    );

    // 3. The pasted ack clears it.
    execFileSync(
      "node",
      [CLI, "ack", "components/Hero.vue::template.", "--reason", "heading level; content unchanged"],
      { cwd: tmp, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } },
    );
    r = runReview();
    assert.equal(r.code, 0, `template ack must clear the gate, got:\n${r.out}`);

    // 4. A script CONTRACT change (setup surface: return type) is a signature
    // move and the ack path refuses it.
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "--no-verify", "-m", "template tweak + ack"], {
      cwd: tmp,
      stdio: "ignore",
    });
    await scaffold({
      "components/Hero.vue": HERO.replace(
        "function headline(): string {",
        "function headline(loud = false): string {",
      ).replace("<h1>{{ headline() }}</h1>", "<h2>{{ headline() }}</h2>"),
    });
    r = runReview();
    assert.equal(r.code, 1);
    assert.ok(
      r.out.includes("[signature changed]"),
      `a setup-surface param add must read as a signature move, got:\n${r.out}`,
    );
    assert.throws(
      () =>
        execFileSync(
          "node",
          [CLI, "ack", "components/Hero.vue::headline().", "--reason", "should be refused"],
          { cwd: tmp, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" }, stdio: "pipe" },
        ),
      "a signature move must not be ackable",
    );
  });
});

describe("go handler arc", () => {
  it("a body refactor is ackable; a param add is a signature move the ack refuses", async () => {
    const GO = "package server\n\nfunc Handle(n int) int {\n\treturn n\n}\n";
    await scaffold({
      "docs/features/handler.md": "# handler\n",
      "server/handler.go": GO,
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            handler: {
              doc: "docs/features/handler.md",
              type: "feature",
              primary_sources: ["server/handler.go"],
              related_sources: [],
              docs: [],
              depends_on: [],
              risk: [],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    });
    gitInit(tmp);
    const env = { ...process.env, NO_COLOR: "1" };

    // Body refactor: one ackable finding, and the pasted ack clears it.
    await scaffold({ "server/handler.go": GO.replace("return n", "return n * 1") });
    assert.throws(() =>
      execFileSync("node", [CLI, "review", "--strict"], { cwd: tmp, encoding: "utf-8", env, stdio: "pipe" }),
    );
    execFileSync(
      "node",
      [CLI, "ack", "server/handler.go::Handle().", "--reason", "identity refactor; contract unchanged"],
      { cwd: tmp, encoding: "utf-8", env },
    );
    execFileSync("node", [CLI, "review", "--strict"], { cwd: tmp, encoding: "utf-8", env });

    // A param add is a signature move: refused.
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "--no-verify", "-m", "ack landed"], { cwd: tmp, stdio: "ignore" });
    await scaffold({
      "server/handler.go": GO.replace("Handle(n int) int", "Handle(n, pad int) int").replace(
        "return n",
        "return n * 1",
      ),
    });
    assert.throws(
      () =>
        execFileSync(
          "node",
          [CLI, "ack", "server/handler.go::Handle().", "--reason", "should refuse"],
          { cwd: tmp, encoding: "utf-8", env, stdio: "pipe" },
        ),
      "a signature move must not be ackable",
    );
  });
});

describe("jvm controller arc", () => {
  it("Java: a body refactor acks; adding @GetMapping to the method refuses the ack", async () => {
    const JAVA =
      "package server;\n\npublic class Controller {\n    public int handle(int n) {\n        return n;\n    }\n}\n";
    await scaffold({
      "docs/features/controller.md": "# controller\n",
      "server/Controller.java": JAVA,
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            controller: {
              doc: "docs/features/controller.md",
              type: "feature",
              primary_sources: ["server/Controller.java"],
              related_sources: [],
              docs: [],
              depends_on: [],
              risk: [],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    });
    gitInit(tmp);
    const env = { ...process.env, NO_COLOR: "1" };

    // Body refactor: one ackable finding, cleared by the pasted ack.
    await scaffold({ "server/Controller.java": JAVA.replace("return n;", "return n * 1;") });
    assert.throws(() =>
      execFileSync("node", [CLI, "review", "--strict"], { cwd: tmp, encoding: "utf-8", env, stdio: "pipe" }),
    );
    execFileSync(
      "node",
      [CLI, "ack", "server/Controller.java::Controller#handle().", "--reason", "identity refactor; contract unchanged"],
      { cwd: tmp, encoding: "utf-8", env },
    );
    execFileSync("node", [CLI, "review", "--strict"], { cwd: tmp, encoding: "utf-8", env });

    // Adding a framework annotation is a contract move the ack refuses.
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "--no-verify", "-m", "ack landed"], { cwd: tmp, stdio: "ignore" });
    await scaffold({
      "server/Controller.java": JAVA.replace("    public int handle(int n)", '    @GetMapping("/h")\n    public int handle(int n)').replace(
        "return n;",
        "return n * 1;",
      ),
    });
    assert.throws(
      () =>
        execFileSync(
          "node",
          [CLI, "ack", "server/Controller.java::Controller#handle().", "--reason", "should refuse"],
          { cwd: tmp, encoding: "utf-8", env, stdio: "pipe" },
        ),
      "an annotation add is a signature move and must not be ackable",
    );
  });

  it("Kotlin: a default-visibility function is gated with no modifier present", async () => {
    const KOTLIN = "package app\n\nfun greet(name: String): String {\n    return \"hi \" + name\n}\n";
    await scaffold({
      "docs/features/greeter.md": "# greeter\n",
      "app/Greeter.kt": KOTLIN,
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            greeter: {
              doc: "docs/features/greeter.md",
              type: "feature",
              primary_sources: ["app/Greeter.kt"],
              related_sources: [],
              docs: [],
              depends_on: [],
              risk: [],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    });
    gitInit(tmp);
    const env = { ...process.env, NO_COLOR: "1" };

    // No `public` keyword anywhere, yet the function gates per symbol: a body
    // edit is one ackable finding addressable by its precise anchor id.
    await scaffold({ "app/Greeter.kt": KOTLIN.replace('return "hi " + name', 'return "hey " + name') });
    assert.throws(() =>
      execFileSync("node", [CLI, "review", "--strict"], { cwd: tmp, encoding: "utf-8", env, stdio: "pipe" }),
    );
    execFileSync(
      "node",
      [CLI, "ack", "app/Greeter.kt::greet().", "--reason", "wording only; contract unchanged"],
      { cwd: tmp, encoding: "utf-8", env },
    );
    execFileSync("node", [CLI, "review", "--strict"], { cwd: tmp, encoding: "utf-8", env });
  });
});

describe("review scopes the gate to the project's declared exclusions", () => {
  it("stops treating a declared build tree as an unmapped source change", async () => {
    await scaffold({
      "out/bundle.js": "exports.b = 1;\n",
      "out/vendor.js": "exports.v = 2;\n",
    });

    // Precondition: undeclared, the build output lands in the gate's change set
    // as unmapped source — noise a scan would then propose into the registry.
    const before = buildReview(tmp);
    assert.ok(
      before.state.unmapped.some((f) => f.startsWith("out/")),
      `expected out/ in unmapped: ${before.state.unmapped.join(", ")}`,
    );

    await scaffold({
      ".codument-meta.json": JSON.stringify({
        version: "0.9.0",
        initialized: "2026-07-21",
        project: { srcDir: "src" },
        exclude: { dirs: ["out"] },
      }),
    });

    const after = buildReview(tmp);
    assert.ok(
      !after.state.unmapped.some((f) => f.startsWith("out/")),
      `still flagged: ${after.state.unmapped.join(", ")}`,
    );
  });

  it("still flags a real unmapped source when a declaration exists", async () => {
    await scaffold({
      "src/lib/cache.ts": "export const cache = {};\n",
      ".codument-meta.json": JSON.stringify({
        version: "0.9.0",
        initialized: "2026-07-21",
        project: { srcDir: "src" },
        exclude: { dirs: ["out"] },
      }),
    });
    const report = buildReview(tmp);
    assert.ok(report.state.unmapped.includes("src/lib/cache.ts"));
  });

  it("declaring nothing leaves the verdict identical to no config at all", async () => {
    await scaffold({ "src/auth/login.ts": "export const login = () => true;\n" });
    const without = buildReview(tmp);
    await scaffold({
      ".codument-meta.json": JSON.stringify({
        version: "0.9.0",
        initialized: "2026-07-21",
        project: { srcDir: "src" },
        exclude: {},
      }),
    });
    const withEmpty = buildReview(tmp);
    assert.deepEqual(withEmpty.state.staleDocs, without.state.staleDocs);
    assert.deepEqual(withEmpty.state.changedSources, without.state.changedSources);
  });
});

describe("the gate sees changes inside a nested member repository", () => {
  // THE regression. A monorepo whose packages are their own repos: an owned
  // source changed inside a member surfaced to the outer repo as `M child` — a
  // gitlink, no extension — so isSourceFile rejected it into otherChanged and
  // the stale-doc verdict never fired while --strict exited 0. The worst thing a
  // gate can do: answer green over a tree it could not see. The workspace layer
  // makes the outer view the union of each member's own view.
  const g = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });

  const CHILD_DOC =
    "---\ntitle: Child\nstatus: current\ntype: feature\n---\n\n## In plain terms\n\nThe child.\n";
  const registry = (source: string) =>
    JSON.stringify({
      features: {
        child: {
          doc: "docs/features/child.md",
          type: "feature",
          primary_sources: [source],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "current",
        },
      },
    });

  let ws: string;
  afterEach(async () => {
    forgetWorkspace();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  // Build the same project as a flat repo (control) and as a root-with-member
  // (nested), so the two verdicts can be compared directly.
  const buildNested = async (): Promise<void> => {
    ws = await mkdtemp(join(tmpdir(), "codument-ws-"));
    await mkdir(join(ws, "child", "src"), { recursive: true });
    await mkdir(join(ws, "docs", "features"), { recursive: true });
    await writeFile(join(ws, "child", "src", "app.ts"), "export function hello() {\n  return 1;\n}\n");
    await writeFile(join(ws, "docs", "features", "child.md"), CHILD_DOC);
    await writeFile(join(ws, "docs", ".registry.json"), registry("child/src/app.ts"));
    g(join(ws, "child"), ["init", "-q"]);
    g(join(ws, "child"), ["add", "-A"]);
    g(join(ws, "child"), ["commit", "-m", "init"]);
    g(ws, ["init", "-q"]);
    g(ws, ["add", "-A"]);
    g(ws, ["commit", "-m", "init"]);
    // The contract change that must fire: an owned symbol's body moves.
    await writeFile(join(ws, "child", "src", "app.ts"), "export function hello() {\n  return 99;\n}\n");
    forgetWorkspace();
  };

  const buildFlat = async (): Promise<string> => {
    const flat = await mkdtemp(join(tmpdir(), "codument-flat-"));
    await mkdir(join(flat, "child", "src"), { recursive: true });
    await mkdir(join(flat, "docs", "features"), { recursive: true });
    await writeFile(join(flat, "child", "src", "app.ts"), "export function hello() {\n  return 1;\n}\n");
    await writeFile(join(flat, "docs", "features", "child.md"), CHILD_DOC);
    await writeFile(join(flat, "docs", ".registry.json"), registry("child/src/app.ts"));
    g(flat, ["init", "-q"]);
    g(flat, ["add", "-A"]);
    g(flat, ["commit", "-m", "init"]);
    await writeFile(join(flat, "child", "src", "app.ts"), "export function hello() {\n  return 99;\n}\n");
    forgetWorkspace();
    return flat;
  };

  it("flags the stale doc and drift, identically to the flat-repo control", async () => {
    await buildNested();
    const nested = buildReview(ws);
    forgetWorkspace();
    const flat = await buildFlat();
    try {
      const control = buildReview(flat);

      // The change is a SOURCE change, not "other" — the false green is gone.
      assert.deepEqual(nested.state.changedSources, ["child/src/app.ts"]);
      assert.deepEqual(nested.state.otherChanged, []);
      assert.deepEqual(
        nested.state.staleDocs.map((d) => d.feature),
        ["child"],
      );

      // And the grain is genuine: a modification, reported as "changed" (not the
      // "added" it degraded to before routing HEAD to the member's own HEAD).
      assert.deepEqual(
        nested.drift.map((d) => `${d.symbol}:${d.kind}`),
        control.drift.map((d) => `${d.symbol}:${d.kind}`),
      );
      assert.ok(nested.drift.some((d) => d.symbol === "hello" && d.kind === "changed"));

      // The verdict is byte-identical to the flat control on every field a
      // consumer reads for pass/fail.
      assert.deepEqual(nested.state.staleDocs, control.state.staleDocs);
      assert.deepEqual(nested.state.changedSources, control.state.changedSources);
    } finally {
      await rm(flat, { recursive: true, force: true });
    }
  });

  it("names the member repositories and their bases", async () => {
    await buildNested();
    const report = buildReview(ws);
    assert.ok(report.workspace, "workspace verdict carries member provenance");
    assert.deepEqual(report.workspace?.members, ["<root>", "child"]);
    assert.equal(report.workspace?.bases.length, 2);
    for (const b of report.workspace!.bases) {
      assert.match(b.sha, /^[0-9a-f]{7,}$/, `member ${b.prefix} has a real base sha`);
    }
  });

  it("leaves a plain single repo's report unchanged (workspace is null)", () => {
    const report = buildReview(tmp);
    assert.equal(report.workspace, null);
  });
});
