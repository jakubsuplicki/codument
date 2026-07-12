import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { auditRange } from "../src/lib/history-audit.js";
import { algoStamp, GateError } from "../src/lib/two-ref.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

async function write(root: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}

function entry(source: string, doc: string): object {
  return {
    doc,
    type: "feature",
    primary_sources: [source],
    related_sources: [],
    docs: [],
    depends_on: [],
    risk: [],
    status: "current",
  };
}

function registryJson(features: Record<string, object>): string {
  return JSON.stringify({ features }, null, 2) + "\n";
}

describe("auditRange — retroactive drift over committed history", () => {
  let root: string;

  // One range (r1..r2) carrying every fixture case at once, like a real release
  // range would: a drifting move, a co-moved doc, a cosmetic edit, a deletion
  // that also removes its registry entry, a parse-broken file, and a rename.
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-"));
    git(root, ["init", "-q"]);

    await write(root, "src/alpha.ts", [
      'export function greet(name: string): string { return "hi " + name; }',
      "export const VERSION = 1;",
      "",
    ].join("\n"));
    await write(root, "src/beta.ts", "export function beta(): number { return 2; }\n");
    await write(root, "src/gamma.ts", "export function gamma(): number { return 3; }\n");
    await write(root, "src/delta.ts", "export function delta(): number { return 4; }\n");
    await write(root, "src/epsilon.ts", "export function epsilon(): number { return 5; }\n");
    await write(root, "src/rho.ts", "export function rho(): number { return 6; }\n");
    for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "rho"]) {
      await write(root, `docs/features/${name}.md`, `# ${name}\n\nthe ${name} contract\n`);
    }
    await write(
      root,
      "docs/.registry.json",
      registryJson({
        alpha: entry("src/alpha.ts", "docs/features/alpha.md"),
        beta: entry("src/beta.ts", "docs/features/beta.md"),
        gamma: entry("src/gamma.ts", "docs/features/gamma.md"),
        delta: entry("src/delta.ts", "docs/features/delta.md"),
        epsilon: entry("src/epsilon.ts", "docs/features/epsilon.md"),
        rho: entry("src/rho.ts", "docs/features/rho.md"),
      }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "r1"]);
    git(root, ["tag", "r1"]);

    // drift: greet's body moves, VERSION does not, alpha.md untouched
    await write(root, "src/alpha.ts", [
      'export function greet(name: string): string { return "hello, " + name; }',
      "export const VERSION = 1;",
      "",
    ].join("\n"));
    // co-moved: beta.ts moves AND beta.md is touched in the same range
    await write(root, "src/beta.ts", "export function beta(): number { return 20; }\n");
    await write(root, "docs/features/beta.md", "# beta\n\nthe beta contract, updated\n");
    // cosmetic: a comment-only edit moves no anchor
    await write(root, "src/gamma.ts", "// a comment\nexport function gamma(): number { return 3; }\n");
    // deletion + the registry-entry-removal dodge: delta.ts AND its entry go
    await unlink(join(root, "src/delta.ts"));
    // parse-broken at head: precise-by-extension but unevaluable
    await write(root, "src/epsilon.ts", "export function epsilon( {{{\n");
    // rename with identical content; the registry still maps the old path
    git(root, ["mv", "src/rho.ts", "src/rho2.ts"]);
    await write(
      root,
      "docs/.registry.json",
      registryJson({
        alpha: entry("src/alpha.ts", "docs/features/alpha.md"),
        beta: entry("src/beta.ts", "docs/features/beta.md"),
        gamma: entry("src/gamma.ts", "docs/features/gamma.md"),
        epsilon: entry("src/epsilon.ts", "docs/features/epsilon.md"),
        rho: entry("src/rho.ts", "docs/features/rho.md"),
      }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "r2"]);
    git(root, ["tag", "r2"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports a moved symbol whose owning doc did not change in the range", () => {
    const audit = auditRange(root, "r1", "r2");
    const alpha = audit.drifted.find((d) => d.feature === "alpha");
    assert.ok(alpha, "alpha drifted");
    assert.equal(alpha.doc, "docs/features/alpha.md");
    assert.deepEqual(alpha.changedSources, ["src/alpha.ts"]);
    // per-symbol, not per-file: greet moved, VERSION did not
    assert.deepEqual(alpha.symbolMoves, [
      { file: "src/alpha.ts", symbol: "greet", kind: "changed" },
    ]);
    // the doc was last touched at r1 — the evidence line for "went stale here"
    assert.equal(alpha.docLastTouched, git(root, ["rev-parse", "r1"]));
  });

  it("does not report a move whose doc was touched in the same range", () => {
    const audit = auditRange(root, "r1", "r2");
    assert.ok(!audit.drifted.some((d) => d.feature === "beta"));
  });

  it("does not report a cosmetic-only edit (no anchor moved)", () => {
    const audit = auditRange(root, "r1", "r2");
    assert.ok(!audit.drifted.some((d) => d.feature === "gamma"));
  });

  it("reports a deleted owned file even when its registry entry was removed in the same range", () => {
    const audit = auditRange(root, "r1", "r2");
    const delta = audit.drifted.find((d) => d.feature === "delta");
    assert.ok(delta, "delta drifted via the base-ref registry");
    assert.deepEqual(delta.changedSources, ["src/delta.ts"]);
    assert.deepEqual(delta.symbolMoves, []); // deletions are file-grain
    assert.ok(audit.deletedSources.includes("src/delta.ts"));
    // documented is the current registry (alpha, beta, gamma, epsilon, rho = 5)
    // UNION any base-only entry a deletion woke (delta) = 6. The union keeps the
    // N-of-M denominator coherent: delta drifts and IS counted, so N ≤ M holds
    // instead of "4 of 5" where delta is not one of the 5.
    assert.equal(audit.documented, 6);
    assert.ok(audit.drifted.length <= audit.documented, "N ≤ M");
  });

  it("surfaces a parse-broken file and still audits it file-grain", () => {
    const audit = auditRange(root, "r1", "r2");
    assert.deepEqual(audit.unevaluable, ["src/epsilon.ts"]);
    const epsilon = audit.drifted.find((d) => d.feature === "epsilon");
    assert.ok(epsilon, "unevaluable never reads as fresh");
    assert.deepEqual(epsilon.symbolMoves, []);
  });

  it("treats a rename's old path as a deletion, so a renamed-away owned source still wakes its owner", () => {
    const audit = auditRange(root, "r1", "r2");
    const rho = audit.drifted.find((d) => d.feature === "rho");
    assert.ok(rho, "rho drifted");
    assert.deepEqual(rho.changedSources, ["src/rho.ts"]);
    // the new path has no owner yet — surfaced as uncheckable, not vouched for
    assert.ok(audit.unmapped.includes("src/rho2.ts"));
  });

  it("pins the resolved range and the determinism stamp", () => {
    const audit = auditRange(root, "r1", "r2");
    assert.equal(audit.base, "r1");
    assert.equal(audit.head, "r2");
    assert.equal(audit.baseSha, git(root, ["rev-parse", "r1"]));
    assert.equal(audit.headSha, git(root, ["rev-parse", "r2"]));
    assert.equal(audit.baseEmptyTree, false);
    assert.equal(audit.baseAmbiguous, false);
    assert.equal(audit.algo, algoStamp());
    assert.deepEqual(
      audit.drifted.map((d) => d.feature),
      ["alpha", "delta", "epsilon", "rho"],
    );
    // Ground the negative cases (beta co-moved, gamma cosmetic) in a DETECTED
    // change: without these counts, a path-filter regression that silently drops
    // beta.ts/gamma.ts would make "not drifted" true for the wrong reason.
    // changed sources = alpha, beta, gamma, epsilon, rho2 (rename target); the
    // one changed doc = beta.md.
    assert.equal(audit.changedSources, 5);
    assert.equal(audit.changedDocs, 1);
  });

  it("is deterministic: the same range yields a deep-equal audit", () => {
    assert.deepEqual(auditRange(root, "r1", "r2"), auditRange(root, "r1", "r2"));
  });

  it("fails loud on an unreachable ref — an audit that could not look never reads as no-drift", () => {
    assert.throws(() => auditRange(root, "no-such-ref", "r2"), GateError);
  });
});

describe("auditRange — scan-provisional registry (the unadopted-repo recipe)", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-scan-"));
    git(root, ["init", "-q"]);
    await write(root, "src/a.ts", "export function a(): number { return 1; }\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "v1"]);
    await write(root, "src/a.ts", "export function a(): number { return 10; }\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "v2"]);
    // scan → audit: the registry and doc exist only in the working tree,
    // never committed — the audit reads the registry AS-IS from disk.
    await write(
      root,
      "docs/.registry.json",
      registryJson({ a: entry("src/a.ts", "docs/features/a.md") }),
    );
    await write(root, "docs/features/a.md", "# a\n");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("audits history against an uncommitted registry, with an honest never-committed doc", () => {
    const audit = auditRange(root, "v1", "v2");
    assert.equal(audit.documented, 1);
    const a = audit.drifted.find((d) => d.feature === "a");
    assert.ok(a, "a drifted");
    assert.deepEqual(a.symbolMoves, [{ file: "src/a.ts", symbol: "a", kind: "changed" }]);
    assert.equal(a.docLastTouched, null);
  });
});

describe("auditRange — reads head from the REF, not the worktree", () => {
  let root: string;

  // The module's one deliberate divergence from the live gate is that it reads
  // head content from the head REF, not from disk. Every other fixture leaves
  // the worktree byte-identical to head, so a regression to disk-reads would
  // pass silently. Here the worktree is dirtied PAST head: a disk-reading engine
  // would see the reverted content and report no drift; the ref-reading engine
  // must still report the committed move.
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-ref-"));
    git(root, ["init", "-q"]);
    await write(root, "src/widget.ts", "export function widget(): number { return 1; }\n");
    await write(root, "docs/features/widget.md", "# widget\n");
    await write(
      root,
      "docs/.registry.json",
      registryJson({ widget: entry("src/widget.ts", "docs/features/widget.md") }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "v1"]);
    await write(root, "src/widget.ts", "export function widget(): number { return 42; }\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "v2"]);
    // Dirty the worktree so disk == v1's body again (uncommitted). A disk-read
    // regression would now diff v1-vs-v1 and see nothing.
    await write(root, "src/widget.ts", "export function widget(): number { return 1; }\n");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports the committed v1..v2 move even though the worktree was reverted to v1", () => {
    const audit = auditRange(root, "v1", "v2");
    const widget = audit.drifted.find((d) => d.feature === "widget");
    assert.ok(widget, "the ref-committed move must drift regardless of the dirty worktree");
    assert.deepEqual(widget.symbolMoves, [
      { file: "src/widget.ts", symbol: "widget", kind: "changed" },
    ]);
  });
});

describe("auditRange — shared-file symbol attribution (fail-loud ownership)", () => {
  let root: string;

  // A source shared across two features with no owned_symbols split: a moved
  // symbol resolves to `unassigned`, which the analyzer wakes for EVERY candidate
  // (never under-wakes) and surfaces as an ownership lint so the registry's
  // owned_symbols map gets corrected.
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-shared-"));
    git(root, ["init", "-q"]);
    await write(root, "src/shared.ts", "export function shared(): number { return 1; }\n");
    await write(root, "docs/features/alpha.md", "# alpha\n");
    await write(root, "docs/features/beta.md", "# beta\n");
    await write(
      root,
      "docs/.registry.json",
      registryJson({
        alpha: entry("src/shared.ts", "docs/features/alpha.md"),
        beta: entry("src/shared.ts", "docs/features/beta.md"),
      }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "v1"]);
    await write(root, "src/shared.ts", "export function shared(): number { return 2; }\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "v2"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("wakes every candidate owner and surfaces the unassigned lint", () => {
    const audit = auditRange(root, "v1", "v2");
    assert.deepEqual(
      audit.drifted.map((d) => d.feature),
      ["alpha", "beta"],
    );
    for (const feature of ["alpha", "beta"]) {
      const row = audit.drifted.find((d) => d.feature === feature);
      assert.ok(row, `${feature} drifted`);
      assert.deepEqual(row.symbolMoves, [
        { file: "src/shared.ts", symbol: "shared", kind: "changed" },
      ]);
    }
    assert.equal(audit.ownershipLints.length, 1);
    assert.equal(audit.ownershipLints[0].kind, "unassigned");
    assert.deepEqual(audit.ownershipLints[0].features, ["alpha", "beta"]);
  });
});

describe("codument audit — end-to-end through the real CLI", () => {
  let root: string;
  const env = { ...process.env, NO_COLOR: "1" };

  const run = (args: string[], cwd: string) =>
    execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8", env });

  // The CLI renders its own failure lines on stdout and sets the exit code, so a
  // nonzero run is asserted on the child's status + captured output, not on the
  // thrown wrapper's message.
  const runFail = (args: string[], cwd: string): string => {
    let out: string | null = null;
    try {
      out = run(args, cwd);
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string };
      assert.notEqual(e.status ?? 0, 0, "expected a nonzero exit");
      return e.stdout ?? "";
    }
    assert.fail(`expected a nonzero exit, got 0 with output:\n${out}`);
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-e2e-"));
    git(root, ["init", "-q"]);
    await write(root, "src/a.ts", "export function a(): number { return 1; }\n");
    await write(root, "docs/features/a.md", "# a\n");
    await write(
      root,
      "docs/.registry.json",
      registryJson({ a: entry("src/a.ts", "docs/features/a.md") }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "v1"]);
    await write(root, "src/a.ts", "export function a(): number { return 10; }\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "v2"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports drift over two tagged states and still exits 0 (informational contract)", () => {
    // execFileSync throws on a nonzero exit, so returning at all IS the exit-0 assertion.
    const out = run(["audit", "v1..v2"], root);
    assert.ok(out.includes("1 of 1 documented feature(s) drifted"), out);
    assert.ok(out.includes("a — docs/features/a.md"), out);
    assert.ok(out.includes("src/a.ts :: a (changed)"), out);
    assert.ok(out.includes("doc last touched"), out);
    assert.ok(out.includes("not a quality score"), out);
  });

  it("defaults an empty head to HEAD", () => {
    const out = run(["audit", "v1.."], root);
    assert.ok(out.includes("1 of 1 documented feature(s) drifted"), out);
  });

  it("exits nonzero on a malformed range", () => {
    assert.match(runFail(["audit", "not-a-range"], root), /not a range/);
  });

  it("exits nonzero on an unreachable ref (an audit that could not look is never no-drift)", () => {
    assert.match(runFail(["audit", "no-such-tag..v2"], root), /gate could not run/);
  });

  it("exits nonzero outside a git repository", async () => {
    const bare = await mkdtemp(join(tmpdir(), "codument-audit-nogit-"));
    try {
      assert.match(runFail(["audit", "v1..v2"], bare), /not a git repository/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("--json emits the version-tagged contract, byte-identical across runs", () => {
    const first = run(["audit", "v1..v2", "--json"], root);
    const second = run(["audit", "v1..v2", "--json"], root);
    assert.equal(first, second, "same repo state must serialize byte-identically");
    const parsed = JSON.parse(first);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.audit, "ok");
    assert.equal(parsed.documented, 1);
    assert.equal(parsed.driftedCount, 1);
    assert.equal(parsed.drifted.length, 1);
    assert.equal(parsed.drifted[0].feature, "a");
    assert.deepEqual(parsed.drifted[0].symbolMoves, [
      { file: "src/a.ts", symbol: "a", kind: "changed" },
    ]);
    assert.equal(typeof parsed.baseSha, "string");
    assert.equal(typeof parsed.algo, "string");
  });

  it("the real scan → audit recipe works on a repo with no prior codument state", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "codument-scan-audit-"));
    try {
      git(fresh, ["init", "-q"]);
      await write(fresh, "src/parser/parse.ts", "export function parse(s: string): number { return Number(s); }\n");
      git(fresh, ["add", "-A"]);
      git(fresh, ["commit", "-q", "-m", "v1"]);
      git(fresh, ["tag", "v1"]);
      await write(fresh, "src/parser/parse.ts", "export function parse(s: string): number { return parseInt(s, 10); }\n");
      git(fresh, ["add", "-A"]);
      git(fresh, ["commit", "-q", "-m", "v2"]);
      git(fresh, ["tag", "v2"]);

      // No init, no hand-written registry — scan must stand the project up, then
      // audit reads that real (uncommitted, needs-review) registry off disk.
      run(["scan"], fresh);
      const out = run(["audit", "v1..v2", "--json"], fresh);
      const parsed = JSON.parse(out);
      assert.equal(parsed.audit, "ok");
      const parser = parsed.drifted.find((d: { feature: string }) => d.feature === "parser");
      assert.ok(parser, `scan→audit surfaced no parser drift:\n${out}`);
      assert.equal(parser.docLastTouched, null, "the scanned doc was never committed");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it("--json keeps every could-not-run machine-readable: a discriminated unavailable shape, exit 1", async () => {
    for (const args of [
      ["audit", "not-a-range", "--json"],
      ["audit", "no-such-tag..v2", "--json"],
    ]) {
      const out = runFail(args, root);
      const parsed = JSON.parse(out);
      assert.equal(parsed.version, 1);
      assert.equal(parsed.audit, "unavailable");
      assert.equal(typeof parsed.reason, "string");
    }
    const bare = await mkdtemp(join(tmpdir(), "codument-audit-nogit-json-"));
    try {
      const parsed = JSON.parse(runFail(["audit", "v1..v2", "--json"], bare));
      assert.deepEqual(parsed, { version: 1, audit: "unavailable", reason: "not a git repository" });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("codument audit — python history through the real CLI", () => {
  let root: string;
  const env = { ...process.env, NO_COLOR: "1" };
  const run = (args: string[], cwd: string) =>
    execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8", env });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-py-"));
    git(root, ["init", "-q"]);
    await write(root, "app/settings.py", '"""Settings."""\n\nDEBUG = True\n');
    await write(root, "docs/features/settings.md", "# settings\n");
    await write(
      root,
      "docs/.registry.json",
      registryJson({ settings: entry("app/settings.py", "docs/features/settings.md") }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "py1"]);
    await write(root, "app/settings.py", '"""Settings."""\n\nDEBUG = False\n');
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "py2"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the drifted Python symbol over the range — audit lights up for the second language", () => {
    const out = run(["audit", "py1..py2", "--json"], root);
    const parsed = JSON.parse(out);
    assert.equal(parsed.audit, "ok");
    assert.equal(parsed.driftedCount, 1);
    assert.equal(parsed.drifted[0].feature, "settings");
    assert.deepEqual(
      parsed.drifted[0].symbolMoves.map((m: { file: string; symbol: string }) => `${m.file}::${m.symbol}`),
      ["app/settings.py::DEBUG"],
    );
  });
});

describe("codument audit — go history through the real CLI", () => {
  let root: string;
  const env = { ...process.env, NO_COLOR: "1" };
  const run = (args: string[], cwd: string) =>
    execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8", env });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-go-"));
    git(root, ["init", "-q"]);
    await write(root, "server/handler.go", "package server\n\nfunc Handle(n int) int {\n\treturn n\n}\n");
    await write(root, "docs/features/handler.md", "# handler\n");
    await write(
      root,
      "docs/.registry.json",
      registryJson({ handler: entry("server/handler.go", "docs/features/handler.md") }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "go1"]);
    await write(root, "server/handler.go", "package server\n\nfunc Handle(n int) int {\n\treturn n * 2\n}\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "go2"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the drifted Go symbol over the range — the third language lights up", () => {
    const parsed = JSON.parse(run(["audit", "go1..go2", "--json"], root));
    assert.equal(parsed.audit, "ok");
    assert.equal(parsed.driftedCount, 1);
    assert.deepEqual(
      parsed.drifted[0].symbolMoves.map((m: { symbol: string }) => m.symbol),
      ["Handle"],
    );
  });
});

describe("codument audit — rust history through the real CLI", () => {
  let root: string;
  const env = { ...process.env, NO_COLOR: "1" };
  const run = (args: string[], cwd: string) =>
    execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8", env });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-rs-"));
    git(root, ["init", "-q"]);
    await write(root, "src/handler.rs", "pub fn handle(n: usize) -> usize {\n    n\n}\n");
    await write(root, "docs/features/handler.md", "# handler\n");
    await write(
      root,
      "docs/.registry.json",
      registryJson({ handler: entry("src/handler.rs", "docs/features/handler.md") }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "rs1"]);
    await write(root, "src/handler.rs", "pub fn handle(n: usize) -> usize {\n    n * 2\n}\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "rs2"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the drifted Rust symbol over the range — the fourth language lights up", () => {
    const parsed = JSON.parse(run(["audit", "rs1..rs2", "--json"], root));
    assert.equal(parsed.audit, "ok");
    assert.deepEqual(
      parsed.drifted[0].symbolMoves.map((m: { symbol: string }) => m.symbol),
      ["handle"],
    );
  });
});

describe("codument audit — c# history through the real CLI", () => {
  let root: string;
  const env = { ...process.env, NO_COLOR: "1" };
  const run = (args: string[], cwd: string) =>
    execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8", env });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-cs-"));
    git(root, ["init", "-q"]);
    await write(root, "src/Handler.cs", "public class Handler\n{\n    public int Handle(int n)\n    {\n        return n;\n    }\n}\n");
    await write(root, "docs/features/handler.md", "# handler\n");
    await write(
      root,
      "docs/.registry.json",
      registryJson({ handler: entry("src/Handler.cs", "docs/features/handler.md") }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "cs1"]);
    await write(root, "src/Handler.cs", "public class Handler\n{\n    public int Handle(int n)\n    {\n        return n * 2;\n    }\n}\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "cs2"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the drifted C# member over the range — the fifth language lights up", () => {
    const parsed = JSON.parse(run(["audit", "cs1..cs2", "--json"], root));
    assert.equal(parsed.audit, "ok");
    assert.deepEqual(
      parsed.drifted[0].symbolMoves.map((m: { symbol: string }) => m.symbol),
      ["Handler#Handle"],
    );
  });
});

describe("codument audit — jvm history through the real CLI", () => {
  let root: string;
  const env = { ...process.env, NO_COLOR: "1" };
  const run = (args: string[], cwd: string) =>
    execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8", env });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-audit-jvm-"));
    git(root, ["init", "-q"]);
    await write(root, "src/Handler.java", "public class Handler {\n    public int handle(int n) {\n        return n;\n    }\n}\n");
    await write(root, "src/Greeter.kt", "fun greet(name: String): String {\n    return name\n}\n");
    await write(root, "docs/features/handler.md", "# handler\n");
    await write(root, "docs/features/greeter.md", "# greeter\n");
    await write(
      root,
      "docs/.registry.json",
      registryJson({
        handler: entry("src/Handler.java", "docs/features/handler.md"),
        greeter: entry("src/Greeter.kt", "docs/features/greeter.md"),
      }),
    );
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v1"]);
    git(root, ["tag", "jvm1"]);
    await write(root, "src/Handler.java", "public class Handler {\n    public int handle(int n) {\n        return n * 2;\n    }\n}\n");
    await write(root, "src/Greeter.kt", "fun greet(name: String): String {\n    return \"hi \" + name\n}\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "v2"]);
    git(root, ["tag", "jvm2"]);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the drifted Java member AND Kotlin function over the range — mixed repos light up together", () => {
    const parsed = JSON.parse(run(["audit", "jvm1..jvm2", "--json"], root));
    assert.equal(parsed.audit, "ok");
    const moved = parsed.drifted
      .flatMap((d: { symbolMoves: { symbol: string }[] }) => d.symbolMoves.map((m) => m.symbol))
      .sort();
    assert.deepEqual(moved, ["Handler#handle", "greet"]);
  });
});
