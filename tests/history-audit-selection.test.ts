import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { auditRange } from "../src/lib/history-audit.js";
import { resolveWorkspace, selectRepository, withRepositoryView } from "../src/lib/git.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const env = { ...process.env, NO_COLOR: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim(); }
function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
}
function repo(root: string, feature: string, source = "src/value.ts"): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  put(root, source, `export function ${feature}Value(value: number): number { return value; }\n`);
  put(root, `docs/features/${feature}.md`, "# Contract\nThe input is returned.\n");
  put(root, "docs/.registry.json", JSON.stringify({ features: { [feature]: { doc: `docs/features/${feature}.md`, type: "feature", primary_sources: [source], related_sources: [], docs: [], depends_on: [], risk: [], status: "current", last_updated: "2026-09-10" } } }));
  git(root, "add", "-A"); git(root, "commit", "-qm", "base"); git(root, "tag", "r1");
  put(root, source, `export function ${feature}Value(value: string): string { return value; }\n`);
  git(root, "add", "-A"); git(root, "commit", "-qm", "changed"); git(root, "tag", "r2");
}
function run(root: string, ...args: string[]) {
  try { return { code: 0, text: execFileSync(process.execPath, [CLI, "audit", "r1..r2", "--dir", root, ...args], { env, encoding: "utf8", stdio: "pipe" }) }; }
  catch (error) { const result = error as { status: number; stdout: string }; return { code: result.status, text: result.stdout }; }
}
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "codument-selected-history-"));
  const root = join(temp, "root");
  repo(root, "outer", "child/src/value.ts");
  const child = join(root, "child");
  repo(child, "member");
  return { root, child, temp };
}

describe("one explicitly selected repository for history audit", () => {
  it("keeps root refs and overlapping blobs separate from member history", () => {
    const { root } = fixture();
    const outer = run(root, "--repo", ".", "--json");
    const member = run(root, "--repo", "child", "--json");
    assert.equal(outer.code, 0, outer.text); assert.equal(member.code, 0, member.text);
    const a = JSON.parse(outer.text); const b = JSON.parse(member.text);
    assert.equal(a.repository, "."); assert.equal(b.repository, "child");
    assert.equal(a.drifted[0].feature, "outer"); assert.equal(b.drifted[0].feature, "member");
    assert.equal(a.drifted[0].symbolMoves[0].symbol, "outerValue");
    assert.equal(b.drifted[0].symbolMoves[0].symbol, "memberValue");
    assert.notEqual(a.headSha, b.headSha);
    assert.equal(a.driftedCount, 1); assert.equal(b.driftedCount, 1);
    assert.equal(run(root, "--json").code, 1, "unselected workspace remains refused");
    assert.throws(() => auditRange(root, "r1", "r2"), /selected repository/);
  });

  it("uses an explicitly selected member even when that member has a nested repository", () => {
    const { root, child } = fixture();
    repo(join(child, "grandchild"), "nested");
    const selected = selectRepository(root, "child");
    const result = auditRange(root, "r1", "r2", selected);
    assert.equal(result.drifted[0].feature, "member");
    assert.equal(result.documented, 1);
    assert.equal(resolveWorkspace(child).isWorkspace, true, "selection cannot change later aggregate reads");
  });

  it("selects a member below a non-repository workspace and refuses its non-repository root", () => {
    const root = mkdtempSync(join(tmpdir(), "codument-selected-nonrepo-"));
    repo(join(root, "member with spaces"), "member");
    const selected = run(root, "--repo", "member with spaces", "--json");
    assert.equal(selected.code, 0, selected.text);
    assert.equal(JSON.parse(selected.text).repository, "member with spaces");
    for (const args of [["--json"], ["--repo", ".", "--json"]]) {
      const result = run(root, ...args); assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.text).audit, "unavailable");
    }
  });

  it("refuses outside, missing, non-repository and broken selectors with JSON and human diagnostics", () => {
    const { root, temp } = fixture();
    repo(join(temp, "outside"), "foreign");
    symlinkSync(join(temp, "outside"), join(root, "outside-alias"), process.platform === "win32" ? "junction" : "dir");
    mkdirSync(join(root, "broken")); put(root, "broken/.git", "gitdir: /not-a-real-repository\n");
    for (const selector of ["../outside", "outside-alias", "missing", "child/src", "broken"]) {
      const machine = run(root, "--repo", selector, "--json");
      assert.equal(machine.code, 1, selector);
      const unavailable = JSON.parse(machine.text);
      assert.equal(unavailable.audit, "unavailable");
      assert.ok(unavailable.reason.length > 10);
      assert.equal(unavailable.driftedCount, undefined);
      const human = run(root, "--repo", selector);
      assert.equal(human.code, 1); assert.ok(human.text.trim().length > 10);
    }
  });

  it("preserves the ordinary single-repository result and informational success on drift", () => {
    const root = mkdtempSync(join(tmpdir(), "codument-selected-control-")); repo(root, "single");
    const normal = run(root, "--json"); const explicit = run(root, "--repo", ".", "--json");
    assert.equal(normal.code, 0); assert.equal(explicit.code, 0);
    const { repository, ...rest } = JSON.parse(explicit.text);
    assert.equal(repository, "."); assert.deepEqual(rest, JSON.parse(normal.text));
  });

  it("does not borrow a root-only ref and names an unreadable selected registry", () => {
    const { root, child } = fixture();
    git(root, "tag", "root-only");
    let failure: { status?: number; stdout?: string } = {};
    try { execFileSync(process.execPath, [CLI, "audit", "root-only..r2", "--repo", "child", "--dir", root, "--json"], { env, encoding: "utf8", stdio: "pipe" }); }
    catch (error) { failure = error as typeof failure; }
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(failure.stdout!).audit, "unavailable");
    put(child, "docs/.registry.json", "{broken");
    const unreadable = run(root, "--repo", "child", "--json");
    assert.equal(unreadable.code, 1);
    assert.equal(JSON.parse(unreadable.text).audit, "unavailable");
    assert.equal(JSON.parse(unreadable.text).driftedCount, undefined);
  });

  it("restores read scopes on exceptions and keeps concurrent selections isolated", async () => {
    const a = fixture(); const b = fixture();
    const first = selectRepository(a.root, "."); const second = selectRepository(b.root, ".");
    assert.throws(() => withRepositoryView(first, () => { assert.equal(resolveWorkspace(a.root).isWorkspace, false); throw new Error("stop"); }), /stop/);
    assert.equal(resolveWorkspace(a.root).isWorkspace, true);
    await Promise.all([first, second].map(view => withRepositoryView(view, async () => {
      await Promise.resolve(); assert.equal(resolveWorkspace(view.root).isWorkspace, false);
    })));
    assert.equal(resolveWorkspace(a.root).isWorkspace, true); assert.equal(resolveWorkspace(b.root).isWorkspace, true);
  });
});
