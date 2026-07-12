import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Acknowledgment, isFileGrainAck } from "./acknowledgment.js";
import { getWorkingTreeChanges, listTrackedFiles } from "./git.js";
import { goAdapter } from "./go-adapter.js";
import { pyAdapter } from "./py-adapter.js";
import { sfcAdapter } from "./sfc-adapter.js";
import { TreeSitterError } from "./tree-sitter.js";
import { tsAdapter } from "./ts-adapter.js";
import {
  blobExistsAtRef,
  byteNormalize,
  GateError,
  readBlobAtRef,
  refReachable,
} from "./two-ref.js";

// An anchor binds an identity to a content fingerprint. The coarse adapter emits
// one whole-file anchor; the precise TS adapter emits one per exported symbol —
// which is what dissolves the shared-file cascade. The gate compares anchor sets
// across two refs and never looks inside one. Adding a language is registering an
// adapter, with ZERO changes to the determinism core, the two-ref harness, or the
// gate.
export interface Anchor {
  /** Identity: the file path (coarse) or a SCIP-shaped symbol FQN (precise). */
  id: string;
  /** Deterministic content hash of the anchored declaration — the COMPOSITE over
   *  its signature AND body (and referenced private helpers). Moves on ANY real
   *  change, so it remains the "did it move" key the gate and acks bind to. */
  fingerprint: string;
  /** The hash of the declaration's SIGNATURE alone (a precise TS declaration:
   *  modifiers, name, type params, params, return/type annotation, and any
   *  private helper referenced from the signature). Present ONLY for precise
   *  per-symbol anchors that have a separable signature; `undefined` for the
   *  coarse whole-file anchor and the TS module-residual backstop, which have no
   *  contract/implementation split. A `changed` anchor whose `signature` moved is
   *  a CONTRACT change (ack-ineligible); one whose `signature` held is a body-only
   *  implementation move (still ackable). Absent on both sides ⇒ the legacy
   *  ackable path (coarse/residual), per the coarse non-goal. */
  signature?: string;
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
  /** Refine how the gate treats a matched file: fully per-symbol (`precise`),
   *  whole-file (`coarse`), or fail-loud (`unevaluable`). Absent → precise. */
  classify?(
    path: string,
    content: string,
  ): { mode: "precise" | "coarse" | "unevaluable"; reason: string };
  /** Async pre-load (e.g. a WASM grammar) that the synchronous gate path
   *  requires; the command layer awaits it up front. A cold adapter raises
   *  TreeSitterError — loud, never a silent coarse fallback. */
  warm?(): Promise<void>;
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

// Adapter registry, most-specific first: the precise adapters ahead of the
// coarse fallback.
const ADAPTERS: LanguageAdapter[] = [tsAdapter, pyAdapter, goAdapter, sfcAdapter, coarseAdapter];

export function adapterFor(path: string): LanguageAdapter {
  return ADAPTERS.find((a) => a.matches(path)) ?? coarseAdapter;
}

/** Adapter-dispatched classification — the ONE way any caller decides whether
 *  a file is per-symbol, whole-file, or unevaluable. An adapter with no
 *  classifier is always precise for the files it matches. Callers must never
 *  reach for a language-specific classifier directly: that is how a second
 *  language's files end up classified through the wrong parser. */
export function classifySource(
  path: string,
  content: string,
): { mode: "precise" | "coarse" | "unevaluable"; reason: string } {
  const adapter = adapterFor(path);
  return adapter.classify
    ? adapter.classify(path, content)
    : { mode: "precise", reason: "per-symbol adapter" };
}

/** Warm every adapter that some path in `paths` needs. The command layer
 *  awaits this before entering the synchronous gate path. */
export async function warmAdaptersForPaths(paths: Iterable<string>): Promise<void> {
  for (const adapter of ADAPTERS) {
    if (!adapter.warm) continue;
    for (const p of paths) {
      if (adapter.matches(p)) {
        await adapter.warm();
        break;
      }
    }
  }
}

/** Warm the adapters a repo's content plausibly needs: tracked files plus
 *  working-tree changes (so a just-added, untracked file counts). Cheap for a
 *  repo that needs nothing — one `git ls-files` and no WASM. The listing is
 *  ADVISORY: a broken git read here degrades to "nothing extra to warm" so the
 *  warm never opens a failure channel ahead of the verdict path's own guarded
 *  GateError (which the same broken git raises moments later, in the right
 *  place); a genuinely needed-but-cold adapter still fails loud downstream. */
export async function warmAdaptersForRepo(root: string): Promise<void> {
  let paths: string[];
  try {
    paths = [...listTrackedFiles(root), ...getWorkingTreeChanges(root)];
  } catch {
    return;
  }
  await warmAdaptersForPaths(paths);
}

/** Warm every warmable adapter — for callers that walk HISTORY (audit), where
 *  a language may appear in old commits without existing in the tree today. */
export async function warmAllAdapters(): Promise<void> {
  for (const adapter of ADAPTERS) {
    if (adapter.warm) await adapter.warm();
  }
}

export type AnchorChangeKind = "added" | "removed" | "changed";

export interface AnchorChange {
  id: string;
  name: string;
  kind: AnchorChangeKind;
  /** The base fingerprint (absent for an `added` anchor). */
  from?: string;
  /** The head fingerprint (absent for a `removed` anchor). An acknowledgment binds
   *  to this exact `from`->`to` transition, so it auto-invalidates on the next move. */
  to?: string;
  /** The base SIGNATURE hash (a precise anchor with a separable signature; absent
   *  for coarse/module anchors and for an `added` anchor). */
  fromSig?: string;
  /** The head SIGNATURE hash. When a `changed` anchor's `fromSig` and `toSig` are
   *  both present and differ, the CONTRACT moved — a signature change, which is
   *  ineligible for an ack; equal signatures mean a body-only (implementation)
   *  move that an ack may still clear. Both absent ⇒ the legacy coarse/residual
   *  path (no signature to compare). */
  toSig?: string;
}

// True when a `changed` anchor's SIGNATURE moved — a contract change (ack-
// ineligible). A coarse/module anchor (no signature on either side) is never a
// signature move, so it stays on the legacy ackable path per the coarse non-goal.
export function isSignatureMove(ch: AnchorChange): boolean {
  return (
    ch.kind === "changed" &&
    ch.fromSig !== undefined &&
    ch.toSig !== undefined &&
    ch.fromSig !== ch.toSig
  );
}

function anchorsAtRef(root: string, ref: string, path: string): Anchor[] | null {
  const content = readBlobAtRef(root, ref, path);
  return content === null ? null : adapterFor(path).anchors(path, content);
}

// Diff two anchor sets by id: present only at head = "added", only at base =
// "removed", a differing fingerprint = "changed". A null set means the file was
// absent at that ref (added/removed wholesale). Sorted by id.
function diffAnchorSets(base: Anchor[] | null, head: Anchor[] | null): AnchorChange[] {
  const baseById = new Map((base ?? []).map((a) => [a.id, a]));
  const headById = new Map((head ?? []).map((a) => [a.id, a]));
  const changes: AnchorChange[] = [];
  for (const [id, h] of headById) {
    const b = baseById.get(id);
    if (!b)
      changes.push({ id, name: h.name, kind: "added", to: h.fingerprint, toSig: h.signature });
    else if (b.fingerprint !== h.fingerprint)
      changes.push({
        id,
        name: h.name,
        kind: "changed",
        from: b.fingerprint,
        to: h.fingerprint,
        fromSig: b.signature,
        toSig: h.signature,
      });
  }
  for (const [id, b] of baseById) {
    if (!headById.has(id))
      changes.push({
        id,
        name: b.name,
        kind: "removed",
        from: b.fingerprint,
        fromSig: b.signature,
      });
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
  const headAnchors = headContent === null ? null : adapterFor(path).anchors(path, headContent);
  return diffAnchorSets(baseAnchors, headAnchors);
}

// Per-symbol anchor changes between a base REF and HEAD content the caller has
// ALREADY read and byte-normalized — the two-committed-ref analog of
// changedAnchorsAgainstWorktree for a caller (the history audit) that reads and
// classifies the head blob once and must not pay, or risk, a second `git show`
// for it. Fail-loud where the other two-ref helpers can degrade: the base is
// distinguished absence-from-failure via `blobExistsAtRef` (which RAISES a
// GateError on a broken git read rather than returning the null a diff would
// read as "fresh"), so a transient base-read failure can never collapse to an
// empty, fresh-reading anchor set. A base genuinely absent (an added or
// renamed-in file) yields every head anchor "added". The head is never re-read
// here, so a transient head-side failure is impossible by construction — the
// caller already holds the content and rejects a broken head read itself.
// Sorted by id.
export function changedAnchorsFromHeadContent(
  root: string,
  base: string,
  path: string,
  headContent: string,
): AnchorChange[] {
  let baseAnchors: Anchor[] | null = null;
  if (blobExistsAtRef(root, base, path)) {
    const baseContent = readBlobAtRef(root, base, path);
    if (baseContent === null) {
      // ls-tree proved the blob exists but `git show` could not read it: a
      // broken git, not absence — fail loud rather than mis-diff every symbol
      // as "added" (or, if head is also empty, read the file as fresh).
      throw new GateError(`${path} exists at ${base} but could not be read`, "git-failed");
    }
    baseAnchors = adapterFor(path).anchors(path, baseContent);
  }
  return diffAnchorSets(baseAnchors, adapterFor(path).anchors(path, headContent));
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
// by ITS adapter's classifier: only `precise` files (≥1 public symbol) get
// per-symbol anchors; `coarse` files (unadapted languages, declaration/generated,
// re-export barrels, dynamic `__all__`, namespace, comments-only) are omitted so
// the change-state falls back to file-grain ownership — this is what stops a file
// whose real surface the precise extractor can't anchor from reading as fresh
// through an empty anchor set; `unevaluable` files (parse errors) are omitted
// (file-grain) AND surfaced. If `base` is unreachable (e.g. a fresh repo with no
// HEAD) the result is empty and the gate degrades to file-grain. Reads git +
// disk, no clock — deterministic.
export function gatherAnchorChanges(root: string, base: string, paths: string[]): GatheredAnchors {
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
    const klass = classifySource(path, headContent);
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
    } catch (err) {
      // A cold adapter is a command-layer wiring bug: loud, never file-grain.
      if (err instanceof TreeSitterError) throw err;
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

// The file's whole-file CONTENT fingerprint transition between a base ref and the
// WORKING TREE — the coarse (byte-normalized) hash a file-grain acknowledgment
// binds to (`codument ack <path>`). `from`/`to` are null when the file is absent at
// that side (added at head → null `from`; deleted from the tree → null `to`).
// Because the ack records this exact `from`->`to`, it auto-invalidates the next time
// the file's content moves — exactly as a per-symbol ack binds a symbol's transition.
// The base is read from git; the head from disk, then byte-normalized by the coarse
// adapter so it hashes identically to a committed blob.
export function fileContentTransition(
  root: string,
  base: string,
  path: string,
): { from: string | null; to: string | null } {
  const baseContent = readBlobAtRef(root, base, path);
  let headContent: string | null;
  try {
    headContent = readFileSync(join(root, path), "utf-8");
  } catch {
    headContent = null; // deleted / unreadable in the working tree
  }
  const fp = (content: string): string => coarseAdapter.anchors(path, content)[0].fingerprint;
  return {
    from: baseContent === null ? null : fp(baseContent),
    to: headContent === null ? null : fp(headContent),
  };
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

// The current standing of a recorded acknowledgment against the WORKING TREE —
// recomputed on every render, never a stored status. An ack binds an anchor's
// `to` fingerprint; it is `covering` only while the current content still hashes
// to that exact `to`. `invalidated` is the auto-invalidation the ack model
// promises made observable: the anchor moved past what the ack vouched for (a new
// fingerprint), or the symbol/file it named is gone. `indeterminate` is the honest
// gap — the file cannot be parsed right now (a parse error / conflict markers), so
// the per-symbol fingerprint cannot be computed and the ack is neither confirmed
// covering nor proven stale. Base-independent by construction: it asks only "does
// today's content still match the vouch", so a committed acked change reads
// `covering`, not moot. That makes it one-directional-safe: a gate-honored ack
// (worktree still at the vouched `to`) ALWAYS reads `covering`, so the list never
// mislabels a working ack `invalidated` and tells you to remove it. It does not
// re-check the ack's `from` against a base — that half is base-relative and
// `ack --list` carries no base — so a `review --base X` whose base moved under the
// ack can still re-flag it; run `ack --base` matching `review --base` for exact
// gate agreement.
export type AckValidity = "covering" | "invalidated" | "indeterminate";

export function ackValidity(root: string, ack: Acknowledgment): AckValidity {
  if (isFileGrainAck(ack)) {
    // A file-grain ack binds the whole-file COARSE fingerprint (as
    // `fileContentTransition` records it), so recompute that same coarse hash.
    let content: string;
    try {
      content = readFileSync(join(root, ack.anchorId), "utf-8");
    } catch {
      return "invalidated"; // the file the ack vouched for is gone from the tree
    }
    const fp = coarseAdapter.anchors(ack.anchorId, content)[0].fingerprint;
    return fp === ack.toHash ? "covering" : "invalidated";
  }
  // A per-symbol ack binds one anchor's composite fingerprint. Find that anchor in
  // the current worktree content and compare.
  const file = ack.anchorId.slice(0, ack.anchorId.indexOf("::"));
  let content: string;
  try {
    content = byteNormalize(readFileSync(join(root, file), "utf-8"));
  } catch {
    return "invalidated"; // the file is gone → nothing left to cover
  }
  // Mirror the gate's fail-loud stance: a precise file that no longer parses is
  // `indeterminate`, never silently read as covering or invalidated.
  if (isPreciseFile(file) && classifySource(file, content).mode === "unevaluable") {
    return "indeterminate";
  }
  let anchors: Anchor[];
  try {
    anchors = adapterFor(file).anchors(file, content);
  } catch (err) {
    if (err instanceof TreeSitterError) throw err; // cold adapter — wiring bug, loud
    return "indeterminate";
  }
  // Resolve the anchor exactly as `diffAnchorSets` does — index by id into a Map,
  // so a duplicate descriptor (TypeScript declaration merging: two `export
  // interface Foo`, or `interface Foo` + `class Foo`, emit two anchors with the
  // same id) resolves LAST-WINS, the same entry the gate recorded the ack's `to`
  // from. A `find` (first-wins) would read a still-covering ack as invalidated on
  // an unchanged tree, contradicting the gate's own verdict.
  const anchor = new Map(anchors.map((a) => [a.id, a])).get(ack.anchorId);
  // Symbol renamed/removed → the ack no longer names anything → auto-invalidated.
  if (!anchor) return "invalidated";
  return anchor.fingerprint === ack.toHash ? "covering" : "invalidated";
}
