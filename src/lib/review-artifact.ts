import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { atomicWriteFileSync } from "./events.js";
import { join } from "node:path";
import { byteNormalize } from "./two-ref.js";

// A recorded, attributed, fingerprint-bound adversarial review of a diff — the
// artifact the gate (step 4) requires before a behavior-change commit. Like an
// acknowledgment it binds to a fingerprint and auto-invalidates, but the binding
// here is the REVIEW fingerprint: the reviewed change set PLUS the tests its
// findings name (`gatherReviewFingerprint`). Any edit to a reviewed source — or to
// a finding's named test — moves the fingerprint, so no recorded review matches and
// the gate reopens. That dual binding is deliberate: a finding blocks only once its
// test goes red (step 3), so binding the test too is what stops a confirmed finding
// from being green-washed by editing its test instead of fixing the code. The gate
// never trusts the reviewer's prose; a finding blocks only once a test confirms it
// (step 3, re-derived live), and
// `invariantsChecked` makes a clean pass auditable (silence is not a pass).
// Reviews are loose, reviewable files under `.codument/reviews/`, mirroring the
// acknowledgment protocol. (The read/write/digest-filename boilerplate parallels
// acknowledgment.ts; a shared loose-file store is deferred — extracting it now
// would refactor the change-control gate for ~15 lines, not worth the coupling.)

export type ReviewFindingStatus = "confirmed" | "advisory" | "resolved";

export interface ReviewFinding {
  /** Where the finding lives: `file:line` or an invariant reference. */
  citation: string;
  /** A short description of what is wrong. */
  detail: string;
  /** The test that demonstrates it. A finding WITH a failing test is a blocking
   *  candidate (confirmed in step 3); WITHOUT one it is advisory — a judgment call
   *  routed to the user decision point. Null when none was provided. */
  failingTest: string | null;
  /** `confirmed` — a failing test reproduces it (blocking); `advisory` — a judgment
   *  call (non-blocking, user-adjudicated); `resolved` — fixed or deferred. The
   *  test-driven transition to `confirmed` is step 3; step 2 only records the value. */
  status: ReviewFindingStatus;
}

export interface ReviewArtifact {
  /** The base ref the reviewed diff was computed against. */
  base: string;
  /** The review fingerprint (`gatherReviewFingerprint`): the reviewed change set
   *  (sorted sources + each file's content hash) folded together with the content
   *  of every test the findings name. Any edit to a reviewed source OR a named
   *  test, or a change to either set, moves this, so a later edit — including
   *  tampering a test to clear its finding — auto-invalidates the review. */
  diffFingerprint: string;
  /** The invariants the reviewer enumerated as checked. MUST be non-empty — a
   *  clean pass has to say what it verified. */
  invariantsChecked: string[];
  /** Findings the reviewer raised (may be empty: a genuinely clean review). */
  findings: ReviewFinding[];
  /** Who attested. An identity; second-party independence is the spawn's job. */
  signer: string;
}

export const REVIEWS_DIR = ".codument/reviews";

const FINDING_STATUSES: ReadonlySet<string> = new Set<ReviewFindingStatus>([
  "confirmed",
  "advisory",
  "resolved",
]);

function nonEmptyStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function parseFinding(value: unknown): ReviewFinding | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const citation = nonEmptyStr(v.citation);
  const detail = nonEmptyStr(v.detail);
  if (!citation || !detail) return null;
  const status =
    typeof v.status === "string" && FINDING_STATUSES.has(v.status)
      ? (v.status as ReviewFindingStatus)
      : null;
  if (!status) return null;
  // failingTest is optional: a non-empty string, or null/absent. An empty string
  // normalizes to null (no test), never accepted as a test name.
  return { citation, detail, failingTest: nonEmptyStr(v.failingTest), status };
}

// Validate an arbitrary parsed value into a ReviewArtifact, or null. Mirrors
// parseAck: every required field must be present and well-formed, and a malformed
// review is ignored, never trusted. `invariantsChecked` MUST be non-empty — the
// "silence is not a pass" rule lives here. A single malformed finding invalidates
// the whole artifact rather than being silently dropped.
export function parseReviewArtifact(value: unknown): ReviewArtifact | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const base = nonEmptyStr(v.base);
  const diffFingerprint = nonEmptyStr(v.diffFingerprint);
  const signer = nonEmptyStr(v.signer);
  if (!base || !diffFingerprint || !signer) return null;

  if (!Array.isArray(v.invariantsChecked)) return null;
  // Strict, mirroring the findings rule below: a non-string or blank element is
  // corruption, not noise to silently drop — reject the whole artifact so a
  // partially-corrupt review can never be accepted with its bad elements erased.
  if (v.invariantsChecked.some((x) => typeof x !== "string" || x.trim().length === 0)) {
    return null;
  }
  const invariantsChecked = v.invariantsChecked as string[];
  // silence is not a pass: a review must enumerate what it checked
  if (invariantsChecked.length === 0) return null;

  if (!Array.isArray(v.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const raw of v.findings) {
    const f = parseFinding(raw);
    if (!f) return null;
    findings.push(f);
  }

  return { base, diffFingerprint, invariantsChecked, findings, signer };
}

// Deterministic fingerprint of a reviewed change set: the base ref plus, for each
// changed source (sorted), its content hash or a deletion marker. Pure — no fs,
// no clock. Any content edit, deletion, or change to the file set moves it.
export function diffFingerprint(
  base: string,
  files: ReadonlyArray<{ path: string; content: string | null }>,
): string {
  // Separator scheme: `path \0 body` per entry, entries joined by `\n`. The NUL
  // between path and body is what makes this collision-resistant — NUL cannot
  // appear in a real filesystem path on any OS, so no two distinct change sets
  // (even with newlines in a path) can serialize to the same pre-hash string.
  // Content is byteNormalize'd (strip BOM, fold CRLF/CR→LF) before hashing — the
  // same contract every other hasher in the freshness system uses — so a benign
  // line-ending or BOM flip between review-write and gate-check never falsely
  // invalidates a valid review.
  const parts = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => {
      const body =
        f.content === null
          ? "\0deleted"
          : createHash("sha256").update(byteNormalize(f.content), "utf8").digest("hex");
      return `${f.path}\0${body}`;
    });
  return createHash("sha256")
    .update(`${base}\n${parts.join("\n")}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

// Impure wrapper: read each changed source off disk (deleted/unreadable → null)
// and compute the diff fingerprint. Thin, beside the pure core.
export function gatherDiffFingerprint(
  root: string,
  base: string,
  changedSources: string[],
): string {
  const files = changedSources.map((path) => {
    const abs = join(root, path);
    let content: string | null = null;
    if (existsSync(abs)) {
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        // Intentional conflation: an unreadable file (permission denied, EISDIR)
        // is treated as deleted (content null). Both mean "the reviewed content
        // is not recoverable here", which fails safe — the fingerprint moves, so
        // the review reopens rather than passing on a file we cannot re-verify.
        content = null;
      }
    }
    return { path, content };
  });
  return diffFingerprint(base, files);
}

// The review fingerprint: the reviewed SOURCES (the change set) folded together
// with the content of the tests its findings name. Binding the named tests is what
// closes the green-wash gap — editing or deleting a finding's test to clear its
// verdict moves this, so the review auto-invalidates exactly as a source edit does;
// you cannot keep the reviewed source while quietly tampering its test. Pure given
// the filesystem: the step-5 artifact writer MUST compute this identically (same
// base, same change set, same named tests) for its recorded fingerprint to match.
export function gatherReviewFingerprint(
  root: string,
  base: string,
  changeSetPaths: string[],
  findings: readonly ReviewFinding[],
  resolveTest: (ref: string) => string | null,
): string {
  const sourcesFp = gatherDiffFingerprint(root, base, changeSetPaths);
  // Each distinct named test, keyed by the finding's raw ref (stable across the
  // writer and the gate) and bound to its current content — or an absence marker
  // when it no longer resolves, so a deletion moves the fingerprint too.
  const refs = [
    ...new Set(findings.map((f) => f.failingTest).filter((t): t is string => !!t)),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const testParts = refs.map((ref) => {
    const resolved = resolveTest(ref);
    let body = "\0absent";
    if (resolved) {
      try {
        body = createHash("sha256")
          .update(byteNormalize(readFileSync(resolved, "utf8")), "utf8")
          .digest("hex");
      } catch {
        body = "\0absent";
      }
    }
    return `${ref}\0${body}`;
  });
  const testsFp = createHash("sha256").update(testParts.join("\n"), "utf8").digest("hex").slice(0, 32);
  return createHash("sha256")
    .update(`${sourcesFp}\n${testsFp}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

// Whether a review still covers the current diff: its bound fingerprint must equal
// the current one. A mismatch means a reviewed file (or the set) changed, so the
// review auto-invalidates — the review-once-then-edit guard.
export function reviewCoversDiff(
  artifact: ReviewArtifact,
  currentDiffFingerprint: string,
): boolean {
  return artifact.diffFingerprint === currentDiffFingerprint;
}

// A deterministic filename keyed on the diff fingerprint (no clock / no
// randomness), so re-reviewing the same diff is idempotent and overwrites in place.
export function reviewFileName(artifact: ReviewArtifact): string {
  const h = createHash("sha256")
    .update(artifact.diffFingerprint, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${h}.json`;
}

// Read every review under `.codument/reviews/`, skipping malformed files. Sorted
// by filename for determinism.
export function readReviews(root: string): ReviewArtifact[] {
  const dir = join(root, REVIEWS_DIR);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const reviews: ReviewArtifact[] = [];
  for (const f of files) {
    try {
      const r = parseReviewArtifact(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (r) reviews.push(r);
    } catch {
      // skip malformed/unreadable review file
    }
  }
  return reviews;
}

// Write a review to `.codument/reviews/<digest>.json` (idempotent filename),
// returning the path.
export function writeReview(root: string, artifact: ReviewArtifact): string {
  const dir = join(root, REVIEWS_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, reviewFileName(artifact));
  atomicWriteFileSync(path, JSON.stringify(artifact, null, 2) + "\n");
  return path;
}

// The review (if any) whose binding covers the current diff. Recomputed PER review
// because each review's binding folds in the tests ITS findings name
// (`gatherReviewFingerprint`): a stored review covers iff the reviewed sources AND
// the tests it relied on are all unchanged since it was recorded. The gate (step 4)
// uses this: a covering review with all blocking findings resolved clears the gate;
// none means the diff is unreviewed (or its review auto-invalidated).
export function findCoveringReview(
  root: string,
  base: string,
  changeSetPaths: string[],
  resolveTest: (ref: string) => string | null,
): ReviewArtifact | null {
  for (const r of readReviews(root)) {
    if (r.diffFingerprint === gatherReviewFingerprint(root, base, changeSetPaths, r.findings, resolveTest)) {
      return r;
    }
  }
  return null;
}
