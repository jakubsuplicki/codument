import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { byteNormalize, readBlobAtRef, refReachable } from "./two-ref.js";
import { classifyTsFile, tsAdapter } from "./ts-adapter.js";

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

// Diff two anchor sets by id: present only at head = "added", only at base =
// "removed", a differing fingerprint = "changed". A null set means the file was
// absent at that ref (added/removed wholesale). Sorted by id.
function diffAnchorSets(
  base: Anchor[] | null,
  head: Anchor[] | null,
): AnchorChange[] {
  const baseById = new Map((base ?? []).map((a) => [a.id, a]));
  const headById = new Map((head ?? []).map((a) => [a.id, a]));
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

// The anchors that changed for a file between two refs, by id. For TS this is
// PER-SYMBOL (cascade-dissolving — a single-symbol edit yields one change); for
// coarse it is the single whole-file anchor. Fails loud (GateError) via
// readBlobAtRef on an unresolvable ref. Sorted by id. This is the CI path (two
// committed refs); `review`/`watch` evaluate the working tree via the helper below.
export function changedAnchors(
  root: string,
  base: string,
  head: string,
  path: string,
): AnchorChange[] {
  return diffAnchorSets(anchorsAtRef(root, base, path), anchorsAtRef(root, head, path));
}

// True when a precise (per-symbol) adapter handles this path — i.e. the symbol-
// grained gate applies rather than the coarse whole-file fallback. Used by callers
// to decide which changed files get per-symbol anchor diffs.
export function isPreciseFile(path: string): boolean {
  return adapterFor(path) !== coarseAdapter;
}

// Per-symbol anchor changes between a base REF and the current WORKING TREE (the
// file on disk) — the head `review`/`watch` actually evaluate (default base HEAD,
// or the merge-base for `review --base`). Base content is read from git; head from
// disk and byte-normalized so it hashes identically to a committed blob. Throws
// GateError (via readBlobAtRef) when `base` is unreachable; a file absent from disk
// (deleted) reads as all-anchors-removed.
export function changedAnchorsAgainstWorktree(
  root: string,
  base: string,
  path: string,
): AnchorChange[] {
  const baseAnchors = anchorsAtRef(root, base, path);
  let headContent: string | null;
  try {
    headContent = byteNormalize(readFileSync(join(root, path), "utf-8"));
  } catch {
    headContent = null; // deleted / unreadable in the working tree
  }
  const headAnchors =
    headContent === null ? null : adapterFor(path).anchors(path, headContent);
  return diffAnchorSets(baseAnchors, headAnchors);
}

export interface GatheredAnchors {
  /** Per-file anchor changes for files classified `precise` (≥1 per-symbol anchor),
   *  keyed by repo-relative path. The change-state resolves these per-symbol. */
  anchorChanges: Record<string, AnchorChange[]>;
  /** Precise-by-extension TS files that did not parse (syntax errors, conflict
   *  markers, syntax newer than the pinned parser). They are OMITTED from
   *  `anchorChanges` so the gate falls back to file-grain (never read as fresh) AND
   *  surfaced so the parse error is fixed rather than silently coarse-gated. */
  unevaluable: string[];
}

// Best-effort per-symbol anchor changes for the changed files among `paths`,
// comparing `base` to the working tree. A file is classified from its head content
// (`classifyTsFile`): only `precise` files (≥1 exported symbol) get per-symbol
// anchors; `coarse` files (non-TS, declaration/generated, re-export barrels,
// `export =`, namespace, comments-only) are omitted so the change-state falls back
// to file-grain ownership — this is what stops a `.ts` file whose real surface the
// precise extractor can't anchor from reading as fresh through an empty anchor set;
// `unevaluable` files (parse errors) are omitted (file-grain) AND surfaced. If
// `base` is unreachable (e.g. a fresh repo with no HEAD) the result is empty and
// the gate degrades to file-grain. Reads git + disk, no clock — deterministic.
export function gatherAnchorChanges(
  root: string,
  base: string,
  paths: string[],
): GatheredAnchors {
  const anchorChanges: Record<string, AnchorChange[]> = {};
  const unevaluable: string[] = [];
  if (!refReachable(root, base)) return { anchorChanges, unevaluable };
  for (const path of paths) {
    if (!isPreciseFile(path)) continue; // non-TS → coarse → file-grain (omit)
    let headContent: string;
    try {
      headContent = byteNormalize(readFileSync(join(root, path), "utf-8"));
    } catch {
      continue; // deleted/unreadable in the working tree → file-grain
    }
    const klass = classifyTsFile(path, headContent);
    if (klass.mode === "unevaluable") {
      unevaluable.push(path);
      continue; // omit → file-grain (never fresh) + surfaced
    }
    if (klass.mode !== "precise") continue; // coarse → file-grain (omit)
    try {
      anchorChanges[path] = diffAnchorSets(
        anchorsAtRef(root, base, path),
        adapterFor(path).anchors(path, headContent),
      );
    } catch {
      // base unreadable mid-loop → omit → file-grain fallback
    }
  }
  unevaluable.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { anchorChanges, unevaluable };
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
