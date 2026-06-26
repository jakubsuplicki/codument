import { createHash } from "node:crypto";
import { basename } from "node:path";
import { byteNormalize, readBlobAtRef } from "./two-ref.js";
import { tsAdapter } from "./ts-adapter.js";

// An anchor binds an identity to a content fingerprint. The coarse adapter emits
// one whole-file anchor; the precise TS adapter emits one per exported symbol —
// which is what dissolves the shared-file cascade. The gate compares anchor sets
// across two refs and never looks inside one. Adding a language is registering an
// adapter, with ZERO changes to the determinism core, the two-ref harness, or the
// gate.
export interface Anchor {
  /** Identity: the file path (coarse) or a SCIP-shaped symbol FQN (precise). */
  id: string;
  /** Deterministic content hash of the anchored declaration. */
  fingerprint: string;
  /** Display name: the symbol name, or the file basename for the coarse anchor. */
  name: string;
  /** "file" for the coarse anchor; a symbol kind for precise anchors. */
  kind: string;
}

export interface LanguageAdapter {
  readonly language: string;
  matches(path: string): boolean;
  /** The anchors for a file's content at a given path. */
  anchors(path: string, content: string): Anchor[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The universal fallback and the non-TS gate: a single whole-file anchor hashing
// byte-normalized content (BOM stripped, CRLF/CR folded to LF). Cosmetic churn
// and the date-bump game normalize away before hashing, so they never move it.
export const coarseAdapter: LanguageAdapter = {
  language: "coarse",
  matches: () => true,
  anchors(path, content) {
    return [
      {
        id: path,
        fingerprint: sha256(byteNormalize(content)),
        name: basename(path),
        kind: "file",
      },
    ];
  },
};

// Adapter registry, most-specific first: the precise TS adapter ahead of the
// coarse fallback.
const ADAPTERS: LanguageAdapter[] = [tsAdapter, coarseAdapter];

export function adapterFor(path: string): LanguageAdapter {
  return ADAPTERS.find((a) => a.matches(path)) ?? coarseAdapter;
}

export type AnchorChangeKind = "added" | "removed" | "changed";

export interface AnchorChange {
  id: string;
  name: string;
  kind: AnchorChangeKind;
}

function anchorsAtRef(root: string, ref: string, path: string): Anchor[] | null {
  const content = readBlobAtRef(root, ref, path);
  return content === null ? null : adapterFor(path).anchors(path, content);
}

// The anchors that changed for a file between two refs, by id: present only at
// head = "added", only at base = "removed", a differing fingerprint = "changed".
// For TS this is PER-SYMBOL (cascade-dissolving — a single-symbol edit yields one
// change); for coarse it is the single whole-file anchor. Fails loud (GateError)
// via readBlobAtRef on an unresolvable ref. Sorted by id.
export function changedAnchors(
  root: string,
  base: string,
  head: string,
  path: string,
): AnchorChange[] {
  const baseById = new Map(
    (anchorsAtRef(root, base, path) ?? []).map((a) => [a.id, a]),
  );
  const headById = new Map(
    (anchorsAtRef(root, head, path) ?? []).map((a) => [a.id, a]),
  );
  const changes: AnchorChange[] = [];
  for (const [id, h] of headById) {
    const b = baseById.get(id);
    if (!b) changes.push({ id, name: h.name, kind: "added" });
    else if (b.fingerprint !== h.fingerprint)
      changes.push({ id, name: h.name, kind: "changed" });
  }
  for (const [id, b] of baseById) {
    if (!headById.has(id)) changes.push({ id, name: b.name, kind: "removed" });
  }
  return changes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type FileChange = "added" | "removed" | "changed" | "unchanged";

// Whether a file's CONTENT changed between two refs — file-grain, over the
// whole-file coarse hash (so a non-exported-only change is never missed, unlike
// the per-symbol view which dissolves the cascade but needs the closure/backstop
// landing in a later slice). Absent at base = added; absent at head = removed;
// otherwise "changed" iff the normalized content moved (cosmetic-only = unchanged).
export function fileContentChange(
  root: string,
  base: string,
  head: string,
  path: string,
): FileChange {
  const baseContent = readBlobAtRef(root, base, path);
  const headContent = readBlobAtRef(root, head, path);
  if (baseContent === null && headContent === null) return "unchanged";
  if (baseContent === null) return "added";
  if (headContent === null) return "removed";
  const before = coarseAdapter.anchors(path, baseContent)[0].fingerprint;
  const after = coarseAdapter.anchors(path, headContent)[0].fingerprint;
  return before === after ? "unchanged" : "changed";
}

// The subset of `paths` whose content actually changed between the two refs
// (added / removed / changed), with cosmetic-only churn filtered out. Sorted,
// deduped.
export function contentChangedFiles(
  root: string,
  base: string,
  head: string,
  paths: string[],
): string[] {
  const changed = new Set<string>();
  for (const path of paths) {
    if (fileContentChange(root, base, head, path) !== "unchanged") {
      changed.add(path);
    }
  }
  return [...changed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
