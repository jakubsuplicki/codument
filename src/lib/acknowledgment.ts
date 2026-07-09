import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./events.js";

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
  return { anchorId, fromHash, toHash, reason, signer };
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
  return !ack.anchorId.includes("::");
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
