import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseReviewArtifact,
  diffFingerprint,
  gatherDiffFingerprint,
  findLatestReviewForBase,
  gatherReviewedFiles,
  gatherReviewFingerprint,
  reviewedDelta,
  reviewCoversDiff,
  reviewFileName,
  readReviews,
  writeReview,
  findCoveringReviews,
  mergeCoveringFindings,
  type ReviewArtifact,
  type ReviewFinding,
} from "../src/lib/review-artifact.js";

// A resolver mirroring the gate's: a bare ref resolves under the repo root, else null.
function makeResolver(root: string) {
  return (ref: string): string | null => {
    const abs = join(root, ref);
    return existsSync(abs) ? abs : null;
  };
}

function artifact(partial: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    base: "HEAD",
    diffFingerprint: "abc123",
    invariantsChecked: ["X holds"],
    findings: [],
    signer: "claude",
    ...partial,
  };
}

describe("parseReviewArtifact", () => {
  it("accepts a well-formed artifact", () => {
    const r = parseReviewArtifact(artifact());
    assert.ok(r);
    assert.equal(r?.base, "HEAD");
    assert.deepEqual(r?.invariantsChecked, ["X holds"]);
  });

  it("rejects missing base / diffFingerprint / signer", () => {
    assert.equal(parseReviewArtifact({ ...artifact(), base: "" }), null);
    assert.equal(parseReviewArtifact({ ...artifact(), diffFingerprint: "  " }), null);
    assert.equal(parseReviewArtifact({ ...artifact(), signer: undefined }), null);
  });

  it("rejects an empty invariantsChecked — silence is not a pass", () => {
    assert.equal(parseReviewArtifact({ ...artifact(), invariantsChecked: [] }), null);
    assert.equal(parseReviewArtifact({ ...artifact(), invariantsChecked: ["", "  "] }), null);
    // not even an array
    assert.equal(parseReviewArtifact({ ...artifact(), invariantsChecked: "X" }), null);
  });

  it("rejects a mixed array with a non-string element, never silently dropping it", () => {
    assert.equal(
      parseReviewArtifact({ ...artifact(), invariantsChecked: [42, "real invariant"] }),
      null,
    );
  });

  it("rejects a malformed finding, invalidating the whole artifact", () => {
    assert.equal(
      parseReviewArtifact({ ...artifact(), findings: [{ detail: "no citation", status: "advisory" }] }),
      null,
    );
    assert.equal(
      parseReviewArtifact({ ...artifact(), findings: [{ citation: "a.ts:1", detail: "d", status: "bogus" }] }),
      null,
    );
  });

  it("normalizes an empty/absent failingTest to null and keeps a real one", () => {
    const r1 = parseReviewArtifact({
      ...artifact(),
      findings: [{ citation: "a.ts:1", detail: "d", status: "advisory", failingTest: "" }],
    });
    assert.equal(r1?.findings[0].failingTest, null);
    const r2 = parseReviewArtifact({
      ...artifact(),
      findings: [{ citation: "a.ts:1", detail: "d", status: "confirmed", failingTest: "a.test.ts" }],
    });
    assert.equal(r2?.findings[0].failingTest, "a.test.ts");
  });
});

describe("diffFingerprint", () => {
  const files = [
    { path: "src/b.ts", content: "b" },
    { path: "src/a.ts", content: "a" },
  ];

  it("is deterministic and order-independent over the file list", () => {
    assert.equal(diffFingerprint("HEAD", files), diffFingerprint("HEAD", [...files].reverse()));
  });

  it("moves when a reviewed file's content changes", () => {
    const edited = [
      { path: "src/a.ts", content: "a2" },
      { path: "src/b.ts", content: "b" },
    ];
    assert.notEqual(diffFingerprint("HEAD", files), diffFingerprint("HEAD", edited));
  });

  it("moves when the file set changes", () => {
    const added = [...files, { path: "src/c.ts", content: "c" }];
    assert.notEqual(diffFingerprint("HEAD", files), diffFingerprint("HEAD", added));
  });

  it("moves when the base changes", () => {
    assert.notEqual(diffFingerprint("HEAD", files), diffFingerprint("abc", files));
  });

  it("distinguishes a deleted file from an empty present one", () => {
    const present = [{ path: "src/a.ts", content: "" }];
    const deleted = [{ path: "src/a.ts", content: null }];
    assert.notEqual(diffFingerprint("HEAD", present), diffFingerprint("HEAD", deleted));
  });

  it("byte-normalizes content: LF, CRLF, and BOM variants of one source hash identically", () => {
    const lf = [{ path: "src/a.ts", content: "line1\nline2\n" }];
    const crlf = [{ path: "src/a.ts", content: "line1\r\nline2\r\n" }];
    const bom = [{ path: "src/a.ts", content: "﻿line1\nline2\n" }];
    assert.equal(diffFingerprint("HEAD", lf), diffFingerprint("HEAD", crlf));
    assert.equal(diffFingerprint("HEAD", lf), diffFingerprint("HEAD", bom));
  });

  it("a newline in a path cannot collide with a two-file set (NUL-separated entries)", () => {
    const single = diffFingerprint("HEAD", [{ path: "a\nb.ts", content: "x" }]);
    const pair = diffFingerprint("HEAD", [
      { path: "a", content: "x" },
      { path: "b.ts", content: "x" },
    ]);
    assert.notEqual(single, pair);
  });
});

describe("reviewCoversDiff (auto-invalidation)", () => {
  it("covers an unchanged diff and invalidates a changed one", () => {
    const a = artifact({ diffFingerprint: "fp1" });
    assert.equal(reviewCoversDiff(a, "fp1"), true);
    assert.equal(reviewCoversDiff(a, "fp2"), false);
  });
});

describe("reviewFileName is keyed on what the artifact attests (plan 49)", () => {
  it("is idempotent for an identical attestation", () => {
    assert.equal(
      reviewFileName(artifact({ diffFingerprint: "fp1" })),
      reviewFileName(artifact({ diffFingerprint: "fp1" })),
    );
    assert.notEqual(
      reviewFileName(artifact({ diffFingerprint: "fp1" })),
      reviewFileName(artifact({ diffFingerprint: "fp2" })),
    );
  });

  it("separates two genuine reviews of one change set", () => {
    // The field's loss: a second review of the same diff silently overwrote the
    // first. Each of these differs from the base artifact in exactly one attested
    // way, and each must land in its own file.
    const base = artifact({ diffFingerprint: "fp1" });
    const differing = [
      artifact({ diffFingerprint: "fp1", signer: "someone-else" }),
      artifact({ diffFingerprint: "fp1", invariantsChecked: ["a different invariant"] }),
      artifact({
        diffFingerprint: "fp1",
        findings: [{ citation: "x.ts:1", detail: "d", status: "advisory", failingTest: null }],
      }),
    ];
    for (const other of differing) {
      assert.notEqual(reviewFileName(base), reviewFileName(other));
    }
    // And they are distinct from each other, not merely from the base.
    const names = new Set([base, ...differing].map(reviewFileName));
    assert.equal(names.size, differing.length + 1);
  });

  it("ignores `files`, which scopes the next bundle and attests nothing", () => {
    assert.equal(
      reviewFileName(artifact({ diffFingerprint: "fp1" })),
      reviewFileName(artifact({ diffFingerprint: "fp1", files: [{ path: "a.ts", hash: "h" }] })),
    );
  });
});

describe("read/write + findCoveringReviews", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-review-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("round-trips an artifact and finds the one covering the current diff", () => {
    writeFileSync(join(tmp, "a.ts"), "source one");
    const resolve = makeResolver(tmp);
    const findings: ReviewFinding[] = [
      { citation: "a.ts:1", detail: "d", status: "advisory", failingTest: null },
    ];
    const fp = gatherReviewFingerprint(tmp, "HEAD", ["a.ts"], findings, resolve);
    const a = artifact({ diffFingerprint: fp, findings });
    writeReview(tmp, a);
    const all = readReviews(tmp);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], a);
    assert.deepEqual(findCoveringReviews(tmp, "HEAD", ["a.ts"], resolve), [a]);
    // a moved source finds no covering review (auto-invalidated)
    writeFileSync(join(tmp, "a.ts"), "source two");
    assert.deepEqual(findCoveringReviews(tmp, "HEAD", ["a.ts"], resolve), []);
  });

  it("returns empty / null when the reviews dir is absent", () => {
    assert.deepEqual(readReviews(tmp), []);
    assert.deepEqual(findCoveringReviews(tmp, "HEAD", [], makeResolver(tmp)), []);
  });

  it("keeps two reviews of one change set, and returns both", () => {
    // The field's loss, end to end: recording a second review used to overwrite the
    // first, and what went with it was the invariants that review had enumerated.
    writeFileSync(join(tmp, "a.ts"), "source one");
    const resolve = makeResolver(tmp);
    const shared: ReviewFinding[] = [
      { citation: "a.ts:1", detail: "d", status: "advisory", failingTest: null },
    ];
    const fp = gatherReviewFingerprint(tmp, "HEAD", ["a.ts"], shared, resolve);
    const first = artifact({ diffFingerprint: fp, findings: shared, signer: "alice" });
    const second = artifact({
      diffFingerprint: fp,
      findings: shared,
      signer: "bob",
      invariantsChecked: ["something else entirely"],
    });
    assert.notEqual(writeReview(tmp, first), writeReview(tmp, second));
    assert.equal(readReviews(tmp).length, 2, "neither review destroyed the other");

    const covering = findCoveringReviews(tmp, "HEAD", ["a.ts"], resolve);
    assert.equal(covering.length, 2, "both cover this diff, so both are enforced");
    assert.deepEqual(
      covering.map((r) => r.signer).sort(),
      ["alice", "bob"],
      "neither signer's review is the one that lost a toss",
    );
  });
});

describe("mergeCoveringFindings (plan 49)", () => {
  const finding = (partial: Partial<ReviewFinding> = {}): ReviewFinding => ({
    citation: "a.ts:1",
    detail: "the same claim",
    status: "advisory",
    failingTest: null,
    ...partial,
  });
  const withFindings = (findings: ReviewFinding[]) => artifact({ findings });

  it("folds a claim two reviewers raised identically into one", () => {
    // Otherwise its test runs twice and the adjudicated/unjudged tallies count how
    // many people looked rather than what they found.
    const merged = mergeCoveringFindings([
      withFindings([finding()]),
      withFindings([finding()]),
    ]);
    assert.equal(merged.length, 1);
  });

  it("keeps claims that differ in any field, however slightly", () => {
    const merged = mergeCoveringFindings([
      withFindings([finding()]),
      withFindings([finding({ detail: "a different reading of the same line" })]),
      withFindings([finding({ failingTest: "a.test.ts", status: "confirmed" })]),
      withFindings([finding({ citation: "a.ts:2" })]),
    ]);
    assert.equal(merged.length, 4, "a different claim is a different claim");
  });

  it("is empty for no reviews, and preserves each review's own order", () => {
    assert.deepEqual(mergeCoveringFindings([]), []);
    const merged = mergeCoveringFindings([
      withFindings([finding({ citation: "a.ts:1" }), finding({ citation: "a.ts:2" })]),
      withFindings([finding({ citation: "a.ts:3" })]),
    ]);
    assert.deepEqual(
      merged.map((f) => f.citation),
      ["a.ts:1", "a.ts:2", "a.ts:3"],
    );
  });
});

describe("gatherReviewFingerprint (test-content binding — the green-wash guard)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-bind-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const findings: ReviewFinding[] = [
    { citation: "src/buggy.ts:1", detail: "bug", status: "confirmed", failingTest: "bug.test.ts" },
  ];

  it("moves when a named test's content changes — editing a finding's test invalidates the review", () => {
    writeFileSync(join(tmp, "src.ts"), "the reviewed source");
    writeFileSync(join(tmp, "bug.test.ts"), "assert(broken)");
    const resolve = makeResolver(tmp);
    const before = gatherReviewFingerprint(tmp, "HEAD", ["src.ts"], findings, resolve);
    // Green-wash attempt: tamper ONLY the test, never the source.
    writeFileSync(join(tmp, "bug.test.ts"), "assert(true) // neutered");
    const after = gatherReviewFingerprint(tmp, "HEAD", ["src.ts"], findings, resolve);
    assert.notEqual(before, after);
  });

  it("moves when a named test is deleted (absence marker)", () => {
    writeFileSync(join(tmp, "src.ts"), "the reviewed source");
    writeFileSync(join(tmp, "bug.test.ts"), "assert(broken)");
    const resolve = makeResolver(tmp);
    const before = gatherReviewFingerprint(tmp, "HEAD", ["src.ts"], findings, resolve);
    rmSync(join(tmp, "bug.test.ts"));
    const after = gatherReviewFingerprint(tmp, "HEAD", ["src.ts"], findings, resolve);
    assert.notEqual(before, after);
  });

  it("is stable when neither source nor named test changes", () => {
    writeFileSync(join(tmp, "src.ts"), "the reviewed source");
    writeFileSync(join(tmp, "bug.test.ts"), "assert(broken)");
    const resolve = makeResolver(tmp);
    assert.equal(
      gatherReviewFingerprint(tmp, "HEAD", ["src.ts"], findings, resolve),
      gatherReviewFingerprint(tmp, "HEAD", ["src.ts"], findings, resolve),
    );
  });

  it("a finding with no failingTest contributes no test binding", () => {
    writeFileSync(join(tmp, "src.ts"), "the reviewed source");
    const resolve = makeResolver(tmp);
    const advisory: ReviewFinding[] = [
      { citation: "src.ts:1", detail: "judgment", status: "advisory", failingTest: null },
    ];
    // Equals the bare source fingerprint — no test entries fold in.
    assert.equal(
      gatherReviewFingerprint(tmp, "HEAD", ["src.ts"], advisory, resolve),
      gatherReviewFingerprint(tmp, "HEAD", ["src.ts"], [], resolve),
    );
  });
});

describe("gatherDiffFingerprint (impure shell)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-gather-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("moves when a reviewed file's on-disk content changes", () => {
    writeFileSync(join(tmp, "a.ts"), "one");
    const fp1 = gatherDiffFingerprint(tmp, "HEAD", ["a.ts"]);
    writeFileSync(join(tmp, "a.ts"), "two");
    const fp2 = gatherDiffFingerprint(tmp, "HEAD", ["a.ts"]);
    assert.notEqual(fp1, fp2);
  });

  it("treats a missing/unreadable file as deleted (content null)", () => {
    assert.equal(
      gatherDiffFingerprint(tmp, "HEAD", ["gone.ts"]),
      diffFingerprint("HEAD", [{ path: "gone.ts", content: null }]),
    );
  });
});

describe("reviewed files (scoping information, never coverage)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-files-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("hashes byte-normalized content, sorts by path, and nulls an absent file", () => {
    writeFileSync(join(tmp, "b.ts"), "one\r\n");
    writeFileSync(join(tmp, "a.ts"), "one\n");
    const files = gatherReviewedFiles(tmp, ["b.ts", "gone.ts", "a.ts"]);
    assert.deepEqual(
      files.map((f) => f.path),
      ["a.ts", "b.ts", "gone.ts"],
    );
    // CRLF folds to LF before hashing, so a line-ending flip is not a move.
    assert.equal(files[0].hash, files[1].hash);
    assert.equal(files[2].hash, null);
  });

  it("moves a file's hash when its content moves", () => {
    writeFileSync(join(tmp, "a.ts"), "one");
    const before = gatherReviewedFiles(tmp, ["a.ts"])[0].hash;
    writeFileSync(join(tmp, "a.ts"), "two");
    assert.notEqual(gatherReviewedFiles(tmp, ["a.ts"])[0].hash, before);
  });

  it("parses a well-formed files[] and rejects a malformed entry", () => {
    const files = [{ path: "a.ts", hash: "deadbeef" }, { path: "gone.ts", hash: null }];
    assert.deepEqual(parseReviewArtifact(artifact({ files }))?.files, files);
    assert.equal(parseReviewArtifact({ ...artifact(), files: "a.ts" }), null);
    assert.equal(parseReviewArtifact({ ...artifact(), files: [{ path: "", hash: "x" }] }), null);
    assert.equal(parseReviewArtifact({ ...artifact(), files: [{ path: "a.ts", hash: 7 }] }), null);
    assert.equal(parseReviewArtifact({ ...artifact(), files: [null] }), null);
  });

  it("round-trips a legacy artifact without inventing the key", () => {
    const parsed = parseReviewArtifact(artifact());
    assert.ok(parsed);
    assert.ok(!("files" in (parsed as object)));
  });

  it("reviewedDelta names new and moved paths, sorted, and ignores departed ones", () => {
    const prior = [
      { path: "a.ts", hash: "h1" },
      { path: "b.ts", hash: "h2" },
      { path: "gone.ts", hash: "h3" },
    ];
    const current = [
      { path: "a.ts", hash: "h1" }, // unchanged
      { path: "b.ts", hash: "CHANGED" }, // moved
      { path: "c.ts", hash: "h4" }, // new
    ];
    assert.deepEqual(reviewedDelta(prior, current), ["b.ts", "c.ts"]);
    assert.deepEqual(reviewedDelta(prior, prior), []);
    // A recorded null hash that is now readable counts as moved (and vice versa).
    assert.deepEqual(reviewedDelta([{ path: "a.ts", hash: null }], [{ path: "a.ts", hash: "h" }]), [
      "a.ts",
    ]);
  });

  it("findLatestReviewForBase picks the newest artifact recorded against that base", () => {
    const older = artifact({ base: "sha-old", diffFingerprint: "fp-old" });
    const newer = artifact({ base: "sha-new", diffFingerprint: "fp-new" });
    const olderPath = writeReview(tmp, older);
    const newerPath = writeReview(tmp, newer);
    // Pin mtimes: filenames are digests and carry no order.
    utimesSync(olderPath, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newerPath, new Date(2_000_000), new Date(2_000_000));

    assert.deepEqual(findLatestReviewForBase(tmp, "sha-new"), newer);
    assert.deepEqual(findLatestReviewForBase(tmp, "sha-old"), older);
    assert.equal(findLatestReviewForBase(tmp, "sha-absent"), null);

    // Same base, two artifacts → the most recently written one wins.
    const newest = artifact({ base: "sha-old", diffFingerprint: "fp-newest" });
    utimesSync(writeReview(tmp, newest), new Date(3_000_000), new Date(3_000_000));
    assert.deepEqual(findLatestReviewForBase(tmp, "sha-old"), newest);
  });

  it("refuses to guess when two artifacts for one base share an mtime", () => {
    // A coarse-granularity filesystem or a copied .codument/reviews/ can genuinely
    // tie, and the filename tie-break is a content digest — arbitrary. Guessing
    // wrong would tell the adversary a file was already attacked when a different
    // review attacked it, so ambiguity falls back to full scope.
    const tie = new Date(5_000_000);
    utimesSync(writeReview(tmp, artifact({ base: "sha", diffFingerprint: "fp-a" })), tie, tie);
    utimesSync(writeReview(tmp, artifact({ base: "sha", diffFingerprint: "fp-b" })), tie, tie);
    assert.equal(findLatestReviewForBase(tmp, "sha"), null);

    // One of them touched later breaks the tie and resolution resumes.
    const winner = artifact({ base: "sha", diffFingerprint: "fp-c" });
    utimesSync(writeReview(tmp, winner), new Date(6_000_000), new Date(6_000_000));
    assert.deepEqual(findLatestReviewForBase(tmp, "sha"), winner);
  });

  it("does NOT soften the gate: an artifact with files[] still voids on any edit", () => {
    writeFileSync(join(tmp, "a.ts"), "source one");
    writeFileSync(join(tmp, "b.ts"), "source two");
    const resolve = makeResolver(tmp);
    const paths = ["a.ts", "b.ts"];
    const fp = gatherReviewFingerprint(tmp, "HEAD", paths, [], resolve);
    writeReview(tmp, artifact({ diffFingerprint: fp, files: gatherReviewedFiles(tmp, paths) }));
    assert.equal(findCoveringReviews(tmp, "HEAD", paths, resolve).length, 1);
    // Editing ONE recorded file voids the whole artifact — the per-file hashes are
    // scoping information and must never let the untouched file stay covered.
    writeFileSync(join(tmp, "a.ts"), "fixed");
    assert.deepEqual(findCoveringReviews(tmp, "HEAD", paths, resolve), []);
  });
});

describe("an artifact records the oracle it answered, or records that it had none (plan 49)", () => {
  it("round-trips a stamp, and keeps 'said none' distinct from 'never said'", () => {
    // Three different facts, and folding any two of them together lets the weakest
    // hide inside a stronger one: a review that named its oracle, one that recorded
    // explicitly that it had none, and an artifact written before stamps existed.
    assert.equal(parseReviewArtifact({ ...artifact(), bundleStamp: "abc" })?.bundleStamp, "abc");
    assert.equal(parseReviewArtifact({ ...artifact(), bundleStamp: null })?.bundleStamp, null);
    const legacy = parseReviewArtifact(artifact());
    assert.ok(legacy && !("bundleStamp" in legacy), "a pre-stamp artifact carries no key at all");
  });

  it("refuses a stamp that is present but not a token", () => {
    // Corruption, not absence. Accepting it as "unstamped" would let a broken writer
    // read as an honest one.
    assert.equal(parseReviewArtifact({ ...artifact(), bundleStamp: 42 }), null);
    assert.equal(parseReviewArtifact({ ...artifact(), bundleStamp: "   " }), null);
  });

  it("is part of what the artifact attests, so two oracles are two attestations", () => {
    assert.notEqual(
      reviewFileName(artifact({ bundleStamp: "one" })),
      reviewFileName(artifact({ bundleStamp: "two" })),
    );
    // And an explicit "none" names the same file a legacy artifact would: both say
    // nothing about an oracle, and neither claims to.
    assert.equal(reviewFileName(artifact({ bundleStamp: null })), reviewFileName(artifact()));
  });
});
