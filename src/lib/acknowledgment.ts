import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./events.js";
import { isSourcePattern } from "./registry.js";

// A recorded, attributed, fingerprint-bound decision that a moved anchor needs no
// doc change (a refactor / behavior-preserving move). The gate NEVER verifies the
// reason — code/doc equivalence is undecidable — it verifies only that the ack
// EXISTS, is attributed, and names the EXACT moved fingerprint. Because it binds
// the `from`->`to` transition, it auto-invalidates the next time the anchor moves:
// a later move produces a new `to` that no prior ack matches, so there is no
// ride-forever exemption (the property a presence-only artifact lacks). Acks are
// loose, reviewable files (changesets `.changeset/`-style) so they show up in the
// PR diff and are merge-friendly.
export interface Acknowledgment {
  /** `<path>::<descriptor>` — the anchor this decision vouches for. */
  anchorId: string;
  /** The base fingerprint the move started from. */
  fromHash: string;
  /** The head fingerprint the ack vouches for (the current state). */
  toHash: string;
  /** Recorded rationale. NOT verified by the gate — a reviewable assertion. */
  reason: string;
  /** Who attested. An identity; independence (signer != author) is an opt-in check. */
  signer: string;
  /** File grain, where no adapter can name a symbol: the lines this vouch actually
   *  covered. Same principle as `covers` one grain up, applied where the signer is
   *  blindest — a hash transition tells them nothing, so a truthful reason about
   *  one part of the file bought silence over all of it. Absent where symbols carry
   *  the disclosure instead. */
  coveredLines?: string[];
  /** Tree grain only, and required there: the matched set this ack vouched for,
   *  path by path. A combined digest would be cheaper and would leave the record
   *  unreadable — a signature on a blank page — so the set is written out and
   *  judged whole. */
  covered?: CoveredFile[];
}

/** One file inside a tree acknowledgment's vouched set, with the transition it was
 *  bound to — the same `from`->`to` a file-grain ack binds, recorded per member. */
export interface CoveredFile {
  path: string;
  from: string;
  to: string;
}

export const ACKS_DIR = ".codument/acks";

// Validate an arbitrary parsed value into an Acknowledgment, or null. Every field
// must be a non-empty string — a malformed ack is ignored, never trusted.
export function parseAck(value: unknown): Acknowledgment | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof v[k] === "string" && (v[k] as string).trim().length > 0 ? (v[k] as string) : null;
  const anchorId = str("anchorId");
  const fromHash = str("fromHash");
  const toHash = str("toHash");
  const reason = str("reason");
  const signer = str("signer");
  if (!anchorId || !fromHash || !toHash || !reason || !signer) return null;
  // A tree ack without its set is unreadable, and an unreadable vouch is exactly
  // what the explicit-set decision refuses — so it is malformed, not trusted-with-
  // less. A set on a symbol or file ack is equally malformed: two grains disagreeing
  // about what one record covers is worse than either.
  // Asked of the ID SHAPE exactly as the grain predicates ask it — a `::descriptor`
  // is never a pattern however it is spelled. Reading the whole id as a glob would
  // condemn a symbol ack whose descriptor happens to carry a `*` (an `export *`
  // barrel) as malformed, silently dropping a recorded judgment.
  const wantsSet = !anchorId.includes("::") && isSourcePattern(anchorId);
  const covered = parseCovered(v.covered);
  if (wantsSet !== (covered !== null && covered.length > 0)) return null;
  // The disclosure survives the round trip or it is not a record. Rebuilding the
  // object from known fields silently dropped it on read, so the ack file held what
  // the vouch covered while every surface that reads one showed nothing.
  const lines =
    Array.isArray(v.coveredLines) && v.coveredLines.every((l: unknown) => typeof l === "string")
      ? { coveredLines: v.coveredLines as string[] }
      : {};
  const base = { anchorId, fromHash, toHash, reason, signer, ...lines };
  return covered ? { ...base, covered } : base;
}

function parseCovered(value: unknown): CoveredFile[] | null {
  if (!Array.isArray(value)) return null;
  const out: CoveredFile[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const c = raw as Record<string, unknown>;
    const ok = (k: string): boolean => typeof c[k] === "string" && (c[k] as string).length > 0;
    if (!ok("path") || !ok("from") || !ok("to")) return null;
    const path = c.path as string;
    if (seen.has(path)) return null; // a path vouched for twice has two answers
    seen.add(path);
    out.push({ path, from: c.from as string, to: c.to as string });
  }
  return out;
}

/**
 * An anchor or path as it has to be written on a command line. Descriptors are not
 * shell-safe: `foo().` and `<module>` are a syntax error and a redirection pasted
 * bare, so every per-symbol ack command this tool printed was a command the reader
 * had to repair before it would run — the same class of defect as printing one that
 * cannot clear the finding, arrived at one layer further out. Left bare where a shell
 * would not touch it, because a quoted token the reader must strip is its own
 * friction, and quoted with the four characters double quotes still interpret escaped.
 */
export function shellArg(token: string): string {
  return /^[A-Za-z0-9_.:@/+-]+$/.test(token) ? token : `"${token.replace(/(["\\$`])/g, "\\$1")}"`;
}

// Whether an ack covers a specific moved anchor: it must name the same anchor AND
// the exact `from`->`to` fingerprint transition. The `to` match is what makes it
// auto-invalidate on the next move (a new `to` won't match a recorded one); the
// `from` match pins it to this exact transition rather than a stale earlier one.
export function ackCovers(
  ack: Acknowledgment,
  anchorId: string,
  fromHash: string,
  toHash: string,
): boolean {
  return ack.anchorId === anchorId && ack.fromHash === fromHash && ack.toHash === toHash;
}

// A file-grain acknowledgment vouches for a whole file's CURRENT content, not a
// single symbol: its `anchorId` is a bare repo-relative path (no `::descriptor`),
// and its `from`->`to` bind the file's coarse content fingerprint. It clears the
// additive / concept / coarse staleness a per-symbol ack cannot reach, and — by the
// conservative resolution rule — never masks a moved (changed) owned symbol. It is
// told apart from a symbol ack purely by the anchorId shape: a symbol ack's id is
// always `<path>::<descriptor>`.
export function isFileGrainAck(ack: Acknowledgment): boolean {
  return !ack.anchorId.includes("::") && !isSourcePattern(ack.anchorId);
}

// A tree-grain acknowledgment vouches for every file a REGISTERED pattern source
// matched at the moment it was recorded: its `anchorId` is that pattern, and its
// `covered` set names each matched path with the transition it was bound to. It is
// the same judgment a file ack makes, made once for a tree that is governed as one
// thing — because a grain that only ever answers for one file makes answering for a
// 380-file locale drop cost 380 signatures, which is how the largest surface in the
// field repo came to be governed by nothing at all. It is told apart from a file ack
// purely by the anchorId's shape, exactly as a symbol ack is.
export function isTreeGrainAck(ack: Acknowledgment): boolean {
  return !ack.anchorId.includes("::") && isSourcePattern(ack.anchorId);
}

// The digest of one side of a vouched set — path and hash, sorted, so the record's
// `from`/`to` summarize the whole tree the way a file ack's summarize one file.
// Order-independent by construction: the same set recorded twice hashes the same,
// which is what keeps the ack filename idempotent.
export function treeSetHash(covered: readonly CoveredFile[], side: "from" | "to"): string {
  const h = createHash("sha256");
  for (const c of [...covered].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${c.path}\u0000${side === "from" ? c.from : c.to}\n`, "utf8");
  }
  return h.digest("hex");
}

// Whether a tree ack vouches for exactly the set in front of it now: same paths,
// same transitions, nothing more and nothing less. Judged WHOLE, never per member —
// the wake it answers is all-or-nothing at the tree, and coverage that disagreed
// with the wake would leave files reading "covered" under a doc that is stale
// anyway. So one file moving again decays it, and a file APPEARING in the tree
// decays it too: a new file under a pattern is a new governed unit, not the
// additive residue a file ack is allowed to sweep up.
export function ackCoversTree(ack: Acknowledgment, current: readonly CoveredFile[]): boolean {
  const covered = ack.covered;
  if (!covered || covered.length === 0 || covered.length !== current.length) return false;
  const byPath = new Map(covered.map((c) => [c.path, c]));
  return current.every((c) => {
    const recorded = byPath.get(c.path);
    return recorded !== undefined && recorded.from === c.from && recorded.to === c.to;
  });
}

// A deterministic filename for an ack (no clock / no randomness): a short digest
// of the anchor + transition, so re-recording the same decision is idempotent and
// two acks for the same transition never collide-but-differ.
export function ackFileName(ack: Acknowledgment): string {
  const h = createHash("sha256")
    .update(`${ack.anchorId}\n${ack.fromHash}\n${ack.toHash}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${h}.json`;
}

// Read every acknowledgment under `.codument/acks/`, skipping malformed files.
// Sorted by filename for determinism.
export function readAcks(root: string): Acknowledgment[] {
  const dir = join(root, ACKS_DIR);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const acks: Acknowledgment[] = [];
  for (const f of files) {
    try {
      const ack = parseAck(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (ack) acks.push(ack);
    } catch {
      // skip malformed/unreadable ack file
    }
  }
  return acks;
}

// Write an acknowledgment to `.codument/acks/<digest>.json` (idempotent filename),
// returning the path. The agent (or a human) records a decision this way.
export function writeAck(root: string, ack: Acknowledgment): string {
  const dir = join(root, ACKS_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ackFileName(ack));
  atomicWriteFileSync(path, JSON.stringify(ack, null, 2) + "\n");
  return path;
}

// The canonical form of a signer/author identity for comparison: trimmed and
// case-folded, so "Alice <A@x.com>" and "alice <a@x.com>" are one person. Shared by
// every independence check (single-author and change-author-set) so they agree.
export function normalizeIdentity(id: string): string {
  return id.trim().toLowerCase();
}

// A signer is independent of the change author when the two identities differ — a
// second-party sign-off, like CODEOWNERS. The single-author form; the review card
// and `--require-independent-ack` gate compare a signer against the SET of a change's
// commit authors instead (see `getChangeAuthors`), using the same normalization.
export function signerIsIndependent(signer: string, changeAuthor: string): boolean {
  return normalizeIdentity(signer) !== normalizeIdentity(changeAuthor);
}

// Opt-in strict independence: an ack is independent only when its signer differs
// from the change author. Off by default (agent-self-resolve); when enabled, a
// self-signed ack does not clear the finding — it is kept honest instead by being
// recorded and auto-invalidating.
export function isIndependent(ack: Acknowledgment, changeAuthor: string): boolean {
  return signerIsIndependent(ack.signer, changeAuthor);
}
