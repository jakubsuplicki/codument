import { createHash } from "node:crypto";
import { byteNormalize, readBlobAtRef } from "./two-ref.js";

// The language seam for the freshness gate. A LanguageAdapter turns file content
// into a deterministic fingerprint; the gate compares fingerprints across two
// refs and never looks inside one. Adding a language = registering an adapter
// here, with ZERO changes to the determinism core, the two-ref harness, or the
// gate. Phase 1 ships only the coarse adapter; Phase 2 adds a precise TS adapter
// ahead of it (per-symbol anchors), and later phases add tree-sitter adapters.
export interface LanguageAdapter {
  /** A short language id, e.g. "coarse" or "typescript". */
  readonly language: string;
  /** True when this adapter handles the given repo-relative path. */
  matches(path: string): boolean;
  /**
   * A deterministic fingerprint of the file's content. The coarse adapter hashes
   * the whole byte-normalized file; precise adapters fingerprint finer structure
   * (Phase 2's TS adapter fingerprints per exported symbol).
   */
  fingerprintFile(content: string): string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The universal fallback and the non-TS gate: a whole-file content hash over
// byte-normalized content (BOM stripped, CRLF/CR folded to LF). Cosmetic churn
// (line-ending flips, a leading BOM, a re-saved trailing newline) and the
// date-bump game cannot move this fingerprint, because they normalize away before
// hashing. It is structure-blind — any real content edit moves it — which is
// exactly why TS gets the precise adapter in Phase 2 to dissolve the cascade.
export const coarseAdapter: LanguageAdapter = {
  language: "coarse",
  matches: () => true,
  fingerprintFile(content: string): string {
    return sha256(byteNormalize(content));
  },
};

// Adapter registry, most-specific first. Phase 1 has only the coarse adapter, so
// every path resolves to it; Phase 2 inserts the TS adapter ahead of it.
const ADAPTERS: LanguageAdapter[] = [coarseAdapter];

// The adapter that handles a path (coarse is the guaranteed fallback).
export function adapterFor(path: string): LanguageAdapter {
  return ADAPTERS.find((a) => a.matches(path)) ?? coarseAdapter;
}

export type FileChange = "added" | "removed" | "changed" | "unchanged";

// Whether a file's CONTENT changed between two refs — not merely whether its path
// appeared in the diff. The adapter's fingerprint decides, so a cosmetic-only
// edit (CRLF, BOM, trailing newline) reads as "unchanged". Absent at base =
// added; absent at head = removed; absent at both = unchanged. Fails loud
// (GateError) via readBlobAtRef when a ref itself is unresolvable.
export function fileContentChange(
  root: string,
  base: string,
  head: string,
  path: string,
): FileChange {
  const adapter = adapterFor(path);
  const baseContent = readBlobAtRef(root, base, path);
  const headContent = readBlobAtRef(root, head, path);
  if (baseContent === null && headContent === null) return "unchanged";
  if (baseContent === null) return "added";
  if (headContent === null) return "removed";
  return adapter.fingerprintFile(baseContent) === adapter.fingerprintFile(headContent)
    ? "unchanged"
    : "changed";
}

// The subset of `paths` whose content actually changed between the two refs
// (added / removed / changed), with cosmetic-only churn filtered out. Sorted,
// deduped. This is the coarse gate signal that refines "path in the diff" down to
// "content really moved".
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
