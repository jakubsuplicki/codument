import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseReviewArtifact,
  diffFingerprint,
  gatherDiffFingerprint,
  gatherReviewFingerprint,
  reviewCoversDiff,
  reviewFileName,
  readReviews,
  writeReview,
  findCoveringReview,
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

describe("reviewFileName", () => {
  it("is keyed on the diff fingerprint only (idempotent re-review)", () => {
    assert.equal(
      reviewFileName(artifact({ diffFingerprint: "fp1" })),
      reviewFileName(artifact({ diffFingerprint: "fp1", signer: "someone-else" })),
    );
    assert.notEqual(
      reviewFileName(artifact({ diffFingerprint: "fp1" })),
      reviewFileName(artifact({ diffFingerprint: "fp2" })),
    );
  });
});

describe("read/write + findCoveringReview", () => {
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
    assert.deepEqual(findCoveringReview(tmp, "HEAD", ["a.ts"], resolve), a);
    // a moved source finds no covering review (auto-invalidated)
    writeFileSync(join(tmp, "a.ts"), "source two");
    assert.equal(findCoveringReview(tmp, "HEAD", ["a.ts"], resolve), null);
  });

  it("returns empty / null when the reviews dir is absent", () => {
    assert.deepEqual(readReviews(tmp), []);
    assert.equal(findCoveringReview(tmp, "HEAD", [], makeResolver(tmp)), null);
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
