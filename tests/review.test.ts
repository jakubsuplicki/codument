import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildReview, normalizeTestCommand } from "../src/commands/review.js";
import { getWorkingTreeChanges } from "../src/lib/git.js";
import { worktreeChangesSince } from "../src/lib/two-ref.js";
import { writeAck } from "../src/lib/acknowledgment.js";

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
    assert.deepEqual(
      report.state.unmapped,
      [],
      "no non-ASCII path misclassified as unmapped",
    );
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
      "docs/features/auth.md": "# auth\n\n## In plain terms\nSign-in now succeeds for valid input.\n",
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
    assert.match(out, /Acknowledged — no doc change owed/);
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
    assert.ok(bundle.changedSources.includes("src/auth/login.ts"), "bundle names the changed source");

    const requireReview = (): { status: number; out: string } => {
      try {
        return {
          status: 0,
          out: execFileSync("node", [CLI, "review", "--require-review"], { cwd: tmp, encoding: "utf-8" }),
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
      JSON.stringify({ invariantsChecked: ["login returns a constant"], findings: [], signer: "test" }),
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

  it("--record rejects a malformed review (empty invariantsChecked) without writing it", async () => {
    await scaffold({ "src/auth/login.ts": "export const login = () => { return 4; };\n" });
    await writeFile(
      join(tmp, "bad.json"),
      JSON.stringify({ invariantsChecked: [], findings: [], signer: "test" }),
    );
    let status = 0;
    let out = "";
    try {
      out = execFileSync("node", [CLI, "review", "--record", "bad.json"], { cwd: tmp, encoding: "utf-8" });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 0;
      out = e.stdout ?? "";
    }
    assert.equal(status, 1, "a silent-pass review is rejected");
    assert.match(out, /invalid review/);
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
