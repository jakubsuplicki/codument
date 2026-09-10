import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangeSet } from "../src/lib/change-set.js";
import type { ReviewArtifact } from "../src/lib/review-artifact.js";
import { buildReviewTransfer, parseReviewTransfer, portableReviewBoundary, testContentDigest, transferDigest, transferredReviews, validateReviewTransfer, type TransferBinding } from "../src/lib/review-transfer.js";

const change: ChangeSet = {
  version: 1, mode: "range", bases: [{ prefix: "", sha: "a".repeat(40) }], head: "HEAD", complete: true,
  changes: [{ path: "src/a.ts", status: "modified", contentOid: "b".repeat(40) }],
  changedFiles: ["src/a.ts"], additions: [], deletions: [], renames: [], unselectedStagedPaths: [], dirtyOutside: [], fingerprint: "c".repeat(64),
};
const boundary = portableReviewBoundary(change, null);
const binding: TransferBinding = { base: change.bases[0].sha, content: boundary.fingerprint, policy: transferDigest("policy"), oracle: transferDigest("oracle"), approval: { path: "docs/features/a.md", planId: "plan-a", digest: transferDigest("approved") } };
const review = (partial: Partial<ReviewArtifact> = {}): ReviewArtifact => ({
  base: binding.base, boundary, diffFingerprint: "d".repeat(32), invariantsChecked: ["PRIVATE checked contract prose"],
  findings: [{ citation: "PRIVATE source citation", detail: "PRIVATE finding detail", failingTest: "tests/a.test.ts", status: "resolved" }], signer: "Independent reviewer", bundleStamp: "e".repeat(32), ...partial,
});

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codument-transfer-"));
  const root = join(directory, "author");
  mkdirSync(root);
  const put = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const runAt = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  const run = (...args: string[]) => runAt(root, ...args);
  const ok = (...args: string[]) => { const result = run(...args); assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout; };
  const doc = "docs/features/alpha.md";
  put(".gitignore", ".codument/\n");
  put(".codument-meta.json", JSON.stringify({ testCommand: "node --test {file}" }));
  put(doc, "# Alpha\n\n## Invariants & boundaries\n- The value is positive. See `tests/alpha.test.cjs`.\n");
  put("src/alpha.ts", "export const alpha = 1;\n");
  put("tests/alpha.test.cjs", 'const { test } = require("node:test"); test("value", () => {});\n');
  put("docs/.registry.json", JSON.stringify({ features: { alpha: { doc, type: "feature", primary_sources: ["src/alpha.ts"], related_sources: [], docs: [], depends_on: [], risk: [], status: "current" } } }));
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com"); git("add", "."); git("commit", "-qm", "baseline");
  const base = git("rev-parse", "HEAD");
  const record = (flags: string[], findings: ReviewArtifact["findings"] = [], signer = "Fixture independent reviewer") => {
    const bundle = JSON.parse(ok("review", ...flags, "--bundle"));
    put(".codument/findings.json", JSON.stringify({ invariantsChecked: ["PRIVATE fixture review contract"], findings, signer, bundleStamp: bundle.stamp }));
    ok("review", ...flags, "--record", ".codument/findings.json");
  };
  const clone = () => { const destination = join(directory, "receiver"); git("clone", "-q", root, destination); return destination; };
  return { root, put, git, runAt, run, ok, doc, base, record, clone, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("portable review CLI", () => {
  it("reviews the full pending branch and validates identical committed bytes in a fresh clone", () => {
    const f = fixture();
    try {
      f.put("src/alpha.ts", "export const alpha = 2;\n"); f.git("add", "."); f.git("commit", "-qm", "first slice");
      f.put("src/alpha.ts", "export const alpha = 3;\n");
      f.put(f.doc, "# Alpha\n\n## Invariants & boundaries\n- The value is three. See `tests/alpha.test.cjs`.\n");
      f.git("add", ".");
      f.record(["--staged"]);
      const flags = ["--base", f.base, "--pending"];
      assert.equal(f.run("review", ...flags, "--export", ".codument-review.json").status, 1, "one staged slice cannot certify the branch");
      f.record(flags);
      assert.equal(f.run("review", ...flags, "--test-timeout", "1", "--export", ".codument-review.json").status, 1, "runtime policy changes require their own review");
      f.ok("review", ...flags, "--export", ".codument-review.json");
      assert.doesNotMatch(readFileSync(join(f.root, ".codument-review.json"), "utf8"), /PRIVATE/);
      f.git("add", ".codument-review.json"); f.git("commit", "-qm", "reviewed final slice");
      const receiver = f.clone();
      const checked = f.runAt(receiver, "review", "--base", f.base, "--committed", "--review-file", ".codument-review.json", "--json");
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      assert.equal(f.runAt(receiver, "review", "--base", f.base, "--committed", "--test-command", "node --test {file}", "--test-timeout", "1", "--review-file", ".codument-review.json").status, 1);
      const wrongBase = f.runAt(receiver, "review", "--base", "HEAD~1", "--committed", "--review-file", ".codument-review.json", "--json");
      assert.equal(wrongBase.status, 1);
      assert.match(wrongBase.stdout, /does not match/);
    } finally { f.dispose(); }
  });

  it("retains every attestation and reruns red tests despite a resolved disposition and a clean sibling", () => {
    const f = fixture();
    try {
      f.put("src/alpha.ts", "export const alpha = 2;\n");
      f.put("tests/alpha.test.cjs", 'const { test } = require("node:test"); test("value", () => { throw new Error("fixture failure"); });\n');
      f.git("add", ".");
      const flags = ["--base", f.base, "--pending"];
      f.record(flags, [{ citation: "PRIVATE source", detail: "PRIVATE failure", failingTest: "tests/alpha.test.cjs", status: "resolved" }]);
      f.record(flags, [], "Second fixture reviewer");
      f.ok("review", ...flags, "--export", ".codument-review.json");
      assert.equal(JSON.parse(readFileSync(join(f.root, ".codument-review.json"), "utf8")).attestations.length, 2);
      f.git("add", ".codument-review.json"); f.git("commit", "-qm", "review evidence");
      const result = f.runAt(f.clone(), "review", "--base", f.base, "--committed", "--review-file", ".codument-review.json", "--json");
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /confirmed/);
    } finally { f.dispose(); }
  });

  it("keeps a never-committed single-step approval valid through final compaction and manifest staging", () => {
    const f = fixture();
    try {
      f.put(".codument-meta.json", JSON.stringify({ requireBoundApproval: true, testCommand: "node --test {file}" }));
      f.put(f.doc, "# Alpha\n\n## Delivery Plan\nStatus: approved\n\n- [ ] Return two\n\n### Scope\n- `src/alpha.ts`\n");
      f.ok("work", "approve", "--plan", f.doc);
      f.ok("work", "start", "--plan", f.doc);
      f.put(`.codument/pending-plans/${f.doc}`, readFileSync(join(f.root, f.doc), "utf8").replace("[ ]", "[x]"));
      f.put(f.doc, "# Alpha\n\n## Invariants & boundaries\n- The value is two. See `tests/alpha.test.cjs`.\n");
      f.put("src/alpha.ts", "export const alpha = 2;\n");
      f.git("add", "."); f.ok("work", "finish", "--prepare-final"); f.git("add", "docs/.approvals.json");
      const flags = ["--base", f.base, "--pending"];
      f.record(flags);
      f.ok("review", ...flags, "--export", ".codument-review.json");
      f.git("add", ".codument-review.json");
      f.ok("review", ...flags, "--review-file", ".codument-review.json");
      f.git("commit", "-qm", "complete approved plan");
      const checked = f.runAt(f.clone(), "review", "--base", f.base, "--committed", "--review-file", ".codument-review.json", "--json");
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      assert.ok(JSON.parse(checked.stdout).plan.approvalDigest);
    } finally { f.dispose(); }
  });

  it("returns structured refusal for malformed reserved evidence instead of excluding it", () => {
    const f = fixture();
    try {
      f.put(".codument-review.json", "{}"); f.git("add", "."); f.git("commit", "-qm", "invalid evidence");
      const result = f.run("review", "--base", f.base, "--committed", "--review-file", ".codument-review.json", "--json");
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).gate, "unavailable");
    } finally { f.dispose(); }
  });

  it("uses the branch baseline for committed contract drift and binds changed executable modes", () => {
    const f = fixture();
    try {
      f.put("src/alpha.ts", 'export function alpha(value: string): string { return value; }\n');
      f.git("add", "."); f.git("commit", "-qm", "signature baseline");
      const base = f.git("rev-parse", "HEAD");
      f.put("src/alpha.ts", 'export function alpha(value: number): number { return value; }\n');
      f.git("add", "."); f.git("commit", "-qm", "changed signature");
      const result = f.run("review", "--base", base, "--committed", "--strict", "--json");
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(JSON.parse(result.stdout).state.staleDocs.length > 0);
      const flags = ["--base", base, "--pending"];
      f.record(flags);
      f.ok("review", ...flags, "--export", ".codument-review.json");
      f.git("add", ".codument-review.json");
      f.git("update-index", "--chmod=+x", "src/alpha.ts");
      f.git("commit", "-qm", "changed mode after review");
      const changed = f.runAt(f.clone(), "review", "--base", base, "--committed", "--review-file", ".codument-review.json", "--json");
      assert.equal(changed.status, 1, changed.stdout + changed.stderr);
      assert.match(changed.stdout, /does not match/);
    } finally { f.dispose(); }
  });
});
const evidence = () => buildReviewTransfer(binding, boundary, [review()], [{ reference: "tests/a.test.ts", path: "tests/a.test.ts", digest: testContentDigest("test\n") }]);

describe("portable review evidence", () => {
  it("exports only opaque references and declared attribution, retaining every covering attestation", () => {
    const record = buildReviewTransfer(binding, boundary, [review(), review({ bundleStamp: "f".repeat(32) })], [{ reference: "tests/a.test.ts", path: "tests/a.test.ts", digest: testContentDigest("test\n") }]);
    assert.equal(record.attestations.length, 2);
    assert.notEqual(record.attestations[0].id, record.attestations[1].id);
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE/);
    assert.equal(record.attribution, "self-reported");
    assert.deepEqual(validateReviewTransfer(JSON.stringify(record), binding, () => "test\r\n"), record);
    assert.equal(transferredReviews(record).length, 2);
  });
  it("refuses missing, malformed, unknown-field, inconsistent, and empty review evidence", () => {
    assert.throws(() => parseReviewTransfer(""), /JSON/);
    assert.throws(() => parseReviewTransfer(JSON.stringify({ ...evidence(), privateNotes: "do not export" })), /schema/);
    const corrupt = structuredClone(evidence());
    corrupt.attestations[0].reviewer = "someone else";
    const { digest: _digest, ...body } = corrupt;
    corrupt.digest = transferDigest(body);
    assert.throws(() => parseReviewTransfer(JSON.stringify(corrupt)), /inconsistent/);
    assert.throws(() => buildReviewTransfer(binding, boundary, [], []), /no complete/);
  });
  it("rejects a wrong base, changed content, approval, policy, oracle or named test", () => {
    const raw = JSON.stringify(evidence());
    for (const key of ["base", "content", "policy", "oracle"] as const) {
      assert.throws(() => validateReviewTransfer(raw, { ...binding, [key]: "0".repeat(key === "base" ? 40 : 64) }, () => "test\n"), /does not match/);
    }
    assert.throws(() => validateReviewTransfer(raw, { ...binding, approval: null }, () => "test\n"), /does not match/);
    assert.throws(() => validateReviewTransfer(raw, binding, () => "changed test\n"), /test changed/);
    assert.throws(() => validateReviewTransfer(raw, binding, () => null), /unavailable/);
  });
  it("cannot promote staged or partial review into committed-range coverage", () => {
    assert.throws(() => portableReviewBoundary({ ...change, mode: "staged" }, null), /complete repository/);
    assert.throws(() => portableReviewBoundary({ ...change, complete: false }, null), /complete repository/);
    assert.throws(() => buildReviewTransfer(binding, boundary, [review({ boundary: { ...boundary, mode: "staged" } })], []), /no complete/);
  });
  it("excludes only a valid reserved manifest, retaining all other changed inputs", () => {
    const withManifest = { ...change, changes: [...change.changes, { path: ".codument-review.json", status: "added" as const, contentOid: "1".repeat(40) }] };
    assert.throws(() => portableReviewBoundary(withManifest, null), /valid evidence/);
    assert.throws(() => portableReviewBoundary(withManifest, "{}"), /schema/);
    assert.deepEqual(portableReviewBoundary(withManifest, JSON.stringify(evidence())), boundary);
    const other = { ...change, changes: [...change.changes, { path: "another-review.json", status: "added" as const, contentOid: "1".repeat(40) }] };
    assert.notEqual(portableReviewBoundary(other, null).fingerprint, boundary.fingerprint);
  });
  it("retains advisory and unresolved tests without claiming reproduction", () => {
    const record = buildReviewTransfer(binding, boundary, [review({ findings: [{ citation: "private", detail: "private", failingTest: "missing.test.ts", status: "advisory" }] })], [{ reference: "missing.test.ts", path: null, digest: null }]);
    const received = validateReviewTransfer(JSON.stringify(record), binding, () => null);
    assert.equal(transferredReviews(received)[0].findings[0].status, "advisory");
    assert.equal(transferredReviews(received)[0].findings[0].failingTest, "missing.test.ts");
    assert.throws(() => buildReviewTransfer(binding, boundary, [review({ findings: [{ citation: "p", detail: "p", failingTest: "../private.test.ts", status: "advisory" }] })], [{ reference: "../private.test.ts", path: null, digest: null }]), /test references/);
  });
});
