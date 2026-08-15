import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
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

export interface ReviewedFile {
  /** A repo-relative path that was in the change set when the review was recorded. */
  path: string;
  /** sha256 of the byte-normalized content at record time, or null when the file was
   *  absent or unreadable then (the same fail-safe conflation the fingerprint makes). */
  hash: string | null;
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
  /** The `--bundle` stamp this review answers, or null when it recorded none.
   *  Optional and NEVER required: refusing an unstamped review would dead-end the
   *  first review of any diff — whose own printed route never mentions `--bundle` —
   *  and would be trivially bypassed by anyone willing to omit the field, so the
   *  guard would bind only the honest actor. It is disclosure: an artifact that
   *  says what oracle it answered can be checked against one, and an artifact that
   *  says nothing is reported as saying nothing. */
  bundleStamp?: string | null;
  /** Per-file hashes of the change set at record time. SCOPING INFORMATION ONLY —
   *  the gate never reads it, so this cannot become a per-file coverage claim. Its
   *  one job is letting `--bundle` compute what moved since the last recording, so
   *  a re-review after a fix attacks the delta instead of the whole diff. Optional:
   *  an artifact written before this existed simply carries no delta information and
   *  the bundle falls back to the full change set. */
  files?: ReviewedFile[];
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

  // `files` is optional (absent = a legacy artifact carrying no delta information),
  // but a present one is parsed as strictly as everything else: one malformed entry
  // rejects the whole artifact rather than silently narrowing the recorded set.
  let files: ReviewedFile[] | null = null;
  if (v.files !== undefined) {
    if (!Array.isArray(v.files)) return null;
    files = [];
    for (const raw of v.files) {
      if (typeof raw !== "object" || raw === null) return null;
      const e = raw as Record<string, unknown>;
      const path = nonEmptyStr(e.path);
      if (!path) return null;
      const hash = e.hash === null ? null : nonEmptyStr(e.hash);
      if (hash === null && e.hash !== null) return null;
      files.push({ path, hash });
    }
  }

  // A stamp is optional, but a present one must be a real token: a non-string or a
  // blank is corruption, and accepting it as "unstamped" would let a broken writer
  // read as an honest one.
  let bundleStamp: string | null | undefined;
  if (v.bundleStamp !== undefined) {
    if (v.bundleStamp === null) bundleStamp = null;
    else {
      bundleStamp = nonEmptyStr(v.bundleStamp);
      if (!bundleStamp) return null;
    }
  }

  // Spread conditionally: an artifact without `files` must round-trip to an object
  // without the key, so deep-equality against a legacy artifact still holds. Same
  // for `bundleStamp` — an artifact written before stamps existed is not the same
  // as one that explicitly recorded having none.
  return {
    base,
    diffFingerprint,
    invariantsChecked,
    findings,
    signer,
    ...(bundleStamp !== undefined ? { bundleStamp } : {}),
    ...(files ? { files } : {}),
  };
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

// Read one change-set path. Intentional conflation: a missing file and an unreadable
// one (permission denied, EISDIR) both read as null. Both mean "the reviewed content
// is not recoverable here", which fails safe — the fingerprint moves, so the review
// reopens rather than passing on a file we cannot re-verify. Shared so the
// fingerprint and the recorded per-file hashes see byte-identical content.
function readChangeSetFile(root: string, path: string): string | null {
  const abs = join(root, path);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// Impure wrapper: read each changed source off disk (deleted/unreadable → null)
// and compute the diff fingerprint. Thin, beside the pure core.
export function gatherDiffFingerprint(
  root: string,
  base: string,
  changedSources: string[],
): string {
  const files = changedSources.map((path) => ({
    path,
    content: readChangeSetFile(root, path),
  }));
  return diffFingerprint(base, files);
}

// The per-file hashes `--record` stores on the artifact. Same content and the same
// byte normalization the fingerprint uses, so a file that did not move between
// record time and bundle time hashes identically. Not a coverage claim: nothing on
// the gate's path reads the result (see `ReviewArtifact.files`).
export function gatherReviewedFiles(root: string, changeSetPaths: string[]): ReviewedFile[] {
  return [...changeSetPaths]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => {
      const content = readChangeSetFile(root, path);
      return {
        path,
        hash:
          content === null
            ? null
            : createHash("sha256").update(byteNormalize(content), "utf8").digest("hex"),
      };
    });
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
  /** A digest of the oracle the reviewer was handed (`oracleFingerprint`). Folded
   *  in so a rewritten contract or invariant list reopens the gate exactly as a
   *  rewritten source does — a review of invariants that no longer exist is not a
   *  review of this change. Defaulted so a caller with no oracle to bind (a unit
   *  test of the source/test binding alone) keeps the pre-oracle value. */
  oracleFp = "",
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
  // Appended rather than mixed into either half: an empty oracle reproduces the
  // pre-oracle value exactly, so the one caller that binds no oracle is unchanged
  // and the component is legible in the hash's own structure.
  return createHash("sha256")
    .update(`${sourcesFp}\n${testsFp}${oracleFp ? `\n${oracleFp}` : ""}`, "utf8")
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

// A deterministic filename keyed on WHAT THE ARTIFACT ATTESTS (no clock / no
// randomness), so re-recording an identical review is still idempotent and
// overwrites in place, while two genuinely different attestations of one change set
// are two files.
//
// Keyed on the diff alone, the name was a claim the artifact never made. The
// fingerprint says which change set was reviewed; it says nothing about who
// reviewed it, what they enumerated as checked, or what they found — so a second
// review of the same diff silently overwrote the first, and in the field that
// destroyed a record whose loss was ten CHECKED INVARIANTS, not ten findings.
// Keying on findings alone would not have saved it either: a finding's named test
// is already folded into the fingerprint, so what collides is precisely the part
// that was not — the invariants and the signer.
//
// `files` is deliberately excluded: it is scoping information for the next
// bundle, not part of the attestation, and including it would split one review
// into two files whenever the change set moved beneath an unchanged verdict.
export function reviewFileName(artifact: ReviewArtifact): string {
  // JSON of an ordered array: no key-order ambiguity, and its escaping makes the
  // serialization unambiguous even when a detail contains the separators a
  // hand-rolled scheme would need.
  const attested = JSON.stringify([
    artifact.base,
    artifact.diffFingerprint,
    artifact.signer,
    artifact.invariantsChecked,
    artifact.findings.map((f) => [f.citation, f.detail, f.failingTest, f.status]),
    // What it was grounded in is part of what it attests: two reviews of one change
    // set that answered different oracles are two different claims about it.
    artifact.bundleStamp ?? null,
  ]);
  const h = createHash("sha256").update(attested, "utf8").digest("hex").slice(0, 16);
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

// The paths in the CURRENT change set that moved since a prior recording: a path the
// prior artifact never hashed, or one whose hash changed. Pure. A path the prior
// artifact hashed but that has since left the change set is not a delta — there is
// nothing left to attack. This is the whole delta-bundle mechanism, and it is
// deliberately outside the gate: scoping what the reviewer READS can never widen
// what the gate ACCEPTS, which stays whole-set fingerprint equality.
export function reviewedDelta(
  prior: readonly ReviewedFile[],
  current: readonly ReviewedFile[],
): string[] {
  const priorByPath = new Map(prior.map((f) => [f.path, f.hash]));
  return current
    .filter((f) => !priorByPath.has(f.path) || priorByPath.get(f.path) !== f.hash)
    .map((f) => f.path)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// The most recently WRITTEN review recorded against `base` — "your last review",
// which is what a delta is relative to. Ordered by mtime (filenames are digests, so
// they carry no order), tie-broken by filename for determinism. Using a clock here
// is safe precisely because the result only scopes the bundle: a mis-picked prior
// artifact can produce a differently-scoped read, never a different verdict.
export function findLatestReviewForBase(root: string, base: string): ReviewArtifact | null {
  const dir = join(root, REVIEWS_DIR);
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const candidates: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      candidates.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch {
      // unreadable entry: not a candidate
    }
  }
  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? -1 : 1));
  const matching: Array<{ mtimeMs: number; artifact: ReviewArtifact }> = [];
  for (const c of candidates) {
    try {
      const r = parseReviewArtifact(JSON.parse(readFileSync(join(dir, c.name), "utf8")));
      if (r && r.base === base) matching.push({ mtimeMs: c.mtimeMs, artifact: r });
    } catch {
      // skip malformed/unreadable review file
    }
  }
  if (matching.length === 0) return null;
  // Ambiguity refuses rather than guesses. A filename tie-break would be arbitrary
  // (filenames are content digests), and a coarse-granularity filesystem or a
  // copied/restored reviews directory can genuinely tie. Returning null costs a
  // full-scope bundle — the safe direction, since a wrong pick would tell the
  // adversary a file was already attacked when the wrong review attacked it.
  if (matching.length > 1 && matching[0].mtimeMs === matching[1].mtimeMs) return null;
  return matching[0].artifact;
}

// EVERY review whose binding covers the current diff, in `readReviews` order.
// Recomputed PER review because each review's binding folds in the tests ITS
// findings name (`gatherReviewFingerprint`): a stored review covers iff the
// reviewed sources AND the tests it relied on are all unchanged since it was
// recorded. The gate uses this: covering reviews with every blocking finding
// resolved clear it; none means the diff is unreviewed (or its review
// auto-invalidated).
//
// All of them, not the first one found. Once two attestations of one change set can
// coexist, picking one is picking a verdict — and the arbitrary pick is the lenient
// direction, since a finding raised by the review that lost the toss would go
// unenforced. Every covering artifact is a genuine review of exactly this diff, so
// every one of their findings is owed a run.
export function findCoveringReviews(
  root: string,
  base: string,
  changeSetPaths: string[],
  resolveTest: (ref: string) => string | null,
  /** The current oracle digest, identical for every artifact because it describes
   *  today's docs rather than the artifact. */
  oracleFp = "",
): ReviewArtifact[] {
  return readReviews(root).filter(
    (r) =>
      r.diffFingerprint ===
      gatherReviewFingerprint(root, base, changeSetPaths, r.findings, resolveTest, oracleFp),
  );
}

/** The findings of every covering review, with the literally-identical ones folded
 *  together. Two reviewers raising the same claim about the same place with the same
 *  test is one claim, and counting it twice would run its test twice and make the
 *  adjudicated/unjudged tallies depend on how many people looked rather than on what
 *  they found. Anything that differs in any field is a different claim and survives. */
export function mergeCoveringFindings(
  reviews: readonly ReviewArtifact[],
): ReviewFinding[] {
  const seen = new Set<string>();
  const merged: ReviewFinding[] = [];
  for (const r of reviews) {
    for (const f of r.findings) {
      const key = JSON.stringify([f.citation, f.detail, f.failingTest, f.status]);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }
  }
  return merged;
}
