import { createHash } from "node:crypto";
import { type ChangeSet, type ChangeSetBinding, changeSetBinding, sameChangeSetBinding } from "./change-set.js";
import type { ReviewArtifact, ReviewFindingStatus } from "./review-artifact.js";
import { ConfigValueError } from "./state-io.js";
import { byteNormalize } from "./two-ref.js";

export const REVIEW_MANIFEST_PATH = ".codument-review.json";
class ReviewTransferError extends ConfigValueError {
  constructor(message: string) { super(REVIEW_MANIFEST_PATH, "review evidence", message); }
}
const MAX_RECORD_BYTES = 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface TransferBinding {
  base: string;
  content: string;
  policy: string;
  oracle: string;
  approval: { path: string; planId: string; digest: string } | null;
}

export interface TransferTest {
  reference: string;
  path: string | null;
  digest: string | null;
}

export interface TransferAttestation {
  id: string;
  source: string;
  reviewer: string;
  checked: string[];
  findings: Array<{ id: string; test: string | null; disposition: ReviewFindingStatus }>;
}

export interface ReviewTransfer {
  version: 1;
  binding: TransferBinding;
  attestations: TransferAttestation[];
  tests: TransferTest[];
  attribution: "self-reported";
  digest: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function transferDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function testContentDigest(content: string): string { return transferDigest(byteNormalize(content)); }

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function label(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function portablePath(value: unknown): value is string {
  return label(value) && !value.includes("\\") && !value.startsWith("/") && !value.includes(":") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function hash(value: unknown): value is string { return typeof value === "string" && SHA.test(value); }

function bindingValid(value: unknown): value is TransferBinding {
  if (!exact(value, ["base", "content", "policy", "oracle", "approval"]) || typeof value.base !== "string" || !COMMIT.test(value.base) || !hash(value.content) || !hash(value.policy) || !hash(value.oracle)) return false;
  return value.approval === null || (exact(value.approval, ["path", "planId", "digest"]) && portablePath(value.approval.path) && label(value.approval.planId) && hash(value.approval.digest));
}

/** Strict transport schema. Unknown fields cannot smuggle private prose into the manifest. */
export function parseReviewTransfer(raw: string): ReviewTransfer {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) throw new ReviewTransferError("review evidence exceeds the supported size");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ReviewTransferError("review evidence is not valid JSON"); }
  if (!exact(value, ["version", "binding", "attestations", "tests", "attribution", "digest"]) || value.version !== 1 || value.attribution !== "self-reported" || !bindingValid(value.binding) || !hash(value.digest) || !Array.isArray(value.attestations) || value.attestations.length === 0 || value.attestations.length > 256 || !Array.isArray(value.tests) || value.tests.length > 2048) throw new ReviewTransferError("review evidence has an unsupported or malformed schema");
  const testRefs = new Set<string>();
  for (const test of value.tests) {
    if (!exact(test, ["reference", "path", "digest"]) || !portablePath(test.reference) || (test.path !== null && !portablePath(test.path)) || (test.digest !== null && !hash(test.digest)) || (test.path === null) !== (test.digest === null) || testRefs.has(test.reference)) throw new ReviewTransferError("review evidence has invalid test references");
    testRefs.add(test.reference);
  }
  const ids = new Set<string>();
  const citedTests = new Set<string>();
  for (const attestation of value.attestations) {
    if (!exact(attestation, ["id", "source", "reviewer", "checked", "findings"]) || !hash(attestation.id) || !hash(attestation.source) || ids.has(attestation.id) || !label(attestation.reviewer) || !Array.isArray(attestation.checked) || attestation.checked.length === 0 || attestation.checked.length > 2048 || attestation.checked.some((item) => !hash(item)) || new Set(attestation.checked).size !== attestation.checked.length || !Array.isArray(attestation.findings) || attestation.findings.length > 2048) throw new ReviewTransferError("review evidence has invalid attestations");
    const { id, ...attested } = attestation;
    if (transferDigest(attested) !== id) throw new ReviewTransferError("review evidence attestation fields are inconsistent");
    ids.add(attestation.id);
    for (const finding of attestation.findings) {
      if (!exact(finding, ["id", "test", "disposition"]) || !hash(finding.id) || (finding.test !== null && (!portablePath(finding.test) || !testRefs.has(finding.test))) || !["confirmed", "advisory", "resolved"].includes(String(finding.disposition))) throw new ReviewTransferError("review evidence has invalid finding references");
      if (typeof finding.test === "string") citedTests.add(finding.test);
    }
  }
  if (testRefs.size !== citedTests.size) throw new ReviewTransferError("review evidence contains tests no attestation cites");
  const { digest, ...body } = value;
  if (transferDigest(body) !== digest) throw new ReviewTransferError("review evidence integrity check failed");
  return value as unknown as ReviewTransfer;
}

/** Only a complete repository range can acquire portable review coverage. */
export function portableReviewBoundary(boundary: ChangeSet, manifest: string | null): ChangeSetBinding {
  if (boundary.mode !== "range" || !boundary.complete || boundary.bases.length !== 1 || boundary.bases[0].prefix !== "") throw new ReviewTransferError("portable review requires one complete repository range");
  const hasManifest = boundary.changes.some((change) => change.path === REVIEW_MANIFEST_PATH);
  if (hasManifest) {
    if (manifest === null) throw new ReviewTransferError("the reserved review manifest must contain valid evidence to be excluded");
    parseReviewTransfer(manifest);
  }
  return { ...changeSetBinding(boundary), paths: boundary.changes.filter((change) => change.path !== REVIEW_MANIFEST_PATH).map((change) => change.path).sort(), head: "HEAD", fingerprint: transferDigest({ bases: boundary.bases, changes: boundary.changes.filter((change) => change.path !== REVIEW_MANIFEST_PATH) }) };
}

export function buildReviewTransfer(binding: TransferBinding, boundary: ChangeSetBinding, reviews: ReviewArtifact[], tests: TransferTest[]): ReviewTransfer {
  if (boundary.mode !== "range" || boundary.bases.length !== 1 || boundary.bases[0].prefix !== "" || binding.base !== boundary.bases[0].sha || binding.content !== boundary.fingerprint || reviews.length === 0 || reviews.some((review) => !sameChangeSetBinding(review.boundary, boundary))) throw new ReviewTransferError("no complete range review covers this export");
  const attestations = reviews.map((review): TransferAttestation => {
    const body = {
      source: transferDigest({ base: review.base, fingerprint: review.diffFingerprint, signer: review.signer, checked: review.invariantsChecked, findings: review.findings, bundleStamp: review.bundleStamp ?? null }),
      reviewer: review.signer,
      checked: [...new Set(review.invariantsChecked.map((item) => transferDigest(item)))].sort(),
      findings: review.findings.map((finding) => ({ id: transferDigest({ citation: finding.citation, detail: finding.detail, test: finding.failingTest }), test: finding.failingTest, disposition: finding.status })),
    };
    return { id: transferDigest(body), ...body };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const body = { version: 1 as const, binding, attestations, tests: [...tests].sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0), attribution: "self-reported" as const };
  return parseReviewTransfer(JSON.stringify({ ...body, digest: transferDigest(body) }));
}

export function validateReviewTransfer(raw: string, expected: TransferBinding, readTest: (path: string) => string | null): ReviewTransfer {
  const record = parseReviewTransfer(raw);
  if (transferDigest(record.binding) !== transferDigest(expected)) throw new ReviewTransferError("review evidence does not match this complete range, approval, policy, or contract");
  for (const test of record.tests) {
    const content = test.path === null ? null : readTest(test.path);
    if ((content === null ? null : testContentDigest(content)) !== test.digest) throw new ReviewTransferError(`review evidence test changed or is unavailable: ${test.reference}`);
  }
  return record;
}

/** Opaque references retain every attestation and disposition without exporting private findings. */
export function transferredReviews(record: ReviewTransfer): ReviewArtifact[] {
  return record.attestations.map((attestation) => ({
    base: record.binding.base,
    diffFingerprint: record.binding.content,
    signer: attestation.reviewer,
    invariantsChecked: attestation.checked.map((id) => `contract:${id}`),
    findings: attestation.findings.map((finding) => ({ citation: `finding:${finding.id}`, detail: `Exported finding ${finding.id}`, failingTest: record.tests.find((test) => test.reference === finding.test)?.path ?? finding.test, status: finding.disposition })),
  }));
}
