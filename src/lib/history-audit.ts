import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  blobExistsAtRef,
  changedPathsBetween,
  GateError,
  algoStamp,
  readBlobAtRef,
  resolveBase,
} from "./two-ref.js";
import {
  changedAnchorsFromHeadContent,
  isPreciseFile,
  type AnchorChange,
  type AnchorChangeKind,
} from "./fingerprint.js";
import { classifyTsFile } from "./ts-adapter.js";
import { computeChangeState, type OwnershipLint } from "./change-state.js";
import {
  parseRegistryOrThrow,
  readRegistrySync,
  type Registry,
} from "./registry.js";
import { resolveOwner } from "./ownership.js";

// Retroactive drift audit over COMMITTED history: the historical analog of the
// live gate. For each registered entry, did an owned source move between two
// refs while its owning doc got no attention in the same range? It drives the
// same two-ref primitives and the same pure analyzer (`computeChangeState`) the
// live gate uses, so drift is scored by the same rule rather than a second,
// disagreeing definition. Its INPUTS differ deliberately in two places: a
// rename's old path is treated as a deletion, so a renamed-away owned source
// still wakes its owner (the working-tree gate lists a rename only under its new
// path); and acknowledgments do not apply (below). Informational only — it
// scores history, it gates nothing.
//
// Acknowledgments deliberately do NOT apply here: an ack adjudicates the live
// working tree against its review base, and `.codument/` state is local and
// uncommitted — there is no recorded adjudication of an arbitrary historical
// range to honor. The audit reports raw co-movement drift.
//
// Determinism contract (same as review): the result is a pure function of
// (base, head, repo state, algoStamp) — no clock, no randomness, sorted
// throughout.

const GIT_MAX_BUFFER = 512 * 1024 * 1024;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

export interface AuditSymbolMove {
  file: string;
  /** The symbol's display name (the file basename for a whole-file anchor). */
  symbol: string;
  kind: AnchorChangeKind;
}

export interface AuditEntry {
  feature: string;
  doc: string;
  /** In-range changed or deleted sources that woke this entry (file-grain view). */
  changedSources: string[];
  /** Per-symbol moves attributed to this entry. Empty when the wake was
   *  file-grain: a coarse/non-TS file, a concept umbrella, or a deletion. */
  symbolMoves: AuditSymbolMove[];
  /** Full sha of the last commit at or before head that touched the owning doc;
   *  null when the doc was never committed (e.g. a scan-provisional scaffold). */
  docLastTouched: string | null;
}

export interface HistoryAudit {
  /** The refs as the caller gave them. */
  base: string;
  head: string;
  /** The resolved diff endpoints: the merge-base of (base, head) — or the empty
   *  tree when they share no ancestor — and the head commit. */
  baseSha: string;
  headSha: string;
  baseEmptyTree: boolean;
  /** True when a criss-cross merge left several merge-bases and the resolution
   *  tie-broke deterministically. */
  baseAmbiguous: boolean;
  /** Determinism identity: same refs + same repo state + same stamp → same audit. */
  algo: string;
  /** Registry entries the audit checked — the M in "N of M drifted". */
  documented: number;
  /** Entries whose owned source moved in-range with no doc attention in-range. */
  drifted: AuditEntry[];
  changedSources: number;
  changedDocs: number;
  deletedSources: string[];
  /** In-range changed sources no registry entry owns — uncheckable, not vouched for. */
  unmapped: string[];
  /** Changed TS files unparseable at head — audited file-grain and surfaced. */
  unevaluable: string[];
  ownershipLints: OwnershipLint[];
}

// The registry blob as of `ref`, for resolving a DELETED file's ownership as of
// when it still existed (same honest-absence contract as the live gate: absence
// is a clean "no base registry", any broken read is loud — a quiet fallback here
// is exactly what the delete-the-entry-too dodge needs).
function registryAtRef(root: string, ref: string): Registry | undefined {
  // No `refReachable` pre-check: on the audit path `ref` is always a base
  // resolveBase already proved reachable (or the empty tree, which blobExistsAtRef
  // handles honestly), so a swallowed `refReachable === false` here could only be
  // a broken git quietly becoming "no base registry" — re-opening the very
  // delete-the-entry dodge this lookup exists to close. blobExistsAtRef RAISES on
  // a broken git and returns a clean false for a genuinely-absent registry.
  if (!blobExistsAtRef(root, ref, "docs/.registry.json")) return undefined;
  const raw = readBlobAtRef(root, ref, "docs/.registry.json");
  if (raw === null) {
    throw new GateError(`could not read docs/.registry.json at ${ref}`, "git-failed");
  }
  return parseRegistryOrThrow(raw, `docs/.registry.json@${ref}`);
}

// Last commit at or before `head` that touched `path` — the "doc last touched at
// ref X" column. Empty history for the path (never committed) is an honest null.
// Uses `rev-list` (plumbing), NOT `git log` (porcelain): `git log` honors user
// config such as `log.showSignature`, which would prepend signature-verification
// text to the hash and make the result a function of the environment rather than
// pure repo state — breaking the determinism contract above.
function lastTouched(root: string, headSha: string, path: string): string | null {
  try {
    const out = git(root, ["rev-list", "-1", headSha, "--", path]).trim();
    return out === "" ? null : out;
  } catch (err) {
    throw new GateError(
      `git rev-list ${headSha} -- ${path} failed: ${(err as Error).message}`,
      "git-failed",
    );
  }
}

// Which entries a changed anchor is attributed to, mirroring the analyzer's wake
// semantics: a resolved owner gets it; an unassigned/ambiguous shared symbol is
// attributed to every candidate (never under-attributed — the same fail-loud
// stance, with the conflict surfaced via `ownershipLints`).
function attributedFeatures(registry: Registry, anchorId: string): string[] {
  const res = resolveOwner(registry, anchorId);
  if (res.kind === "owned") return [res.feature];
  if (res.kind === "unassigned") return res.candidates;
  if (res.kind === "ambiguous") return res.owners;
  return [];
}

/**
 * Audit doc drift across committed history: everything that changed between
 * `base` and `head`, joined against the registry AS-IS on disk (so a fresh
 * `codument scan` registry can audit a repo that never adopted anything).
 * Throws GateError on an unreachable ref or a broken git read — an audit that
 * could not look never reads as "no drift".
 */
export function auditRange(root: string, base: string, head: string): HistoryAudit {
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  const resolved = resolveBase(root, base, head);
  let headSha: string;
  try {
    headSha = git(root, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
  } catch (err) {
    throw new GateError(
      `head is not a commit: ${head} (${(err as Error).message})`,
      "bad-ref",
    );
  }

  // Split the range's changes the way the live gate splits the working tree:
  // extant paths drive the change set; deletions travel first-class. A rename is
  // both — its old path is gone at head (a deletion for ownership purposes, so a
  // renamed-away owned source still wakes its owner) and its new path is extant.
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  for (const change of changedPathsBetween(root, resolved.sha, headSha)) {
    if (change.status === "deleted") {
      deletedFiles.push(change.path);
      continue;
    }
    changedFiles.push(change.path);
    if (change.status === "renamed" && change.oldPath) {
      deletedFiles.push(change.oldPath);
    }
  }

  // Per-symbol anchor diffs between the two COMMITTED refs, with the same
  // classification discipline as the live gate (`gatherAnchorChanges`), reading
  // head content from the ref instead of the working tree: only files precise at
  // head get per-symbol entries; coarse files fall back to file-grain by omission;
  // parse-error files are omitted (file-grain, never fresh) AND surfaced.
  const anchorChanges: Record<string, AnchorChange[]> = {};
  const unevaluable: string[] = [];
  for (const path of changedFiles) {
    if (!isPreciseFile(path)) continue;
    const headContent = readBlobAtRef(root, headSha, path);
    if (headContent === null) {
      // `path` came from the range diff as a NON-deletion, so it provably exists
      // at head; a null read is therefore a BROKEN git read, never absence. Fail
      // loud rather than skip it into a silent file-grain (or, worse, empty-and-
      // fresh) verdict — an audit that could not look must never read as no-drift.
      throw new GateError(
        `could not read ${path} at ${headSha} (it is present in the range diff)`,
        "git-failed",
      );
    }
    const klass = classifyTsFile(path, headContent);
    if (klass.mode === "unevaluable") {
      unevaluable.push(path);
      continue;
    }
    if (klass.mode !== "precise") continue;
    // Head anchors from the content already read (never a second `git show` that
    // could transiently fail and diff to an empty, fresh-reading set); the base
    // read is fail-loud on a broken git via blobExistsAtRef.
    anchorChanges[path] = changedAnchorsFromHeadContent(
      root,
      resolved.sha,
      path,
      headContent,
    );
  }
  unevaluable.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const state = computeChangeState({
    registry,
    changedFiles,
    anchorChanges,
    // No acks are resolved for a historical range (see the module note), so the
    // pre-filter movement set the concept umbrellas wake off is just "every
    // precise file whose anchors moved".
    contentMovedFiles: Object.entries(anchorChanges)
      .filter(([, changes]) => changes.length > 0)
      .map(([path]) => path),
    unevaluable,
    deletedFiles,
    // Deleted files resolve ownership against the registry AT THE BASE, so an
    // entry removed in the same range still flags the doc it owned.
    baseRegistry: deletedFiles.length > 0 ? registryAtRef(root, resolved.sha) : undefined,
  });

  const drifted: AuditEntry[] = state.staleDocs.map((stale) => {
    const symbolMoves: AuditSymbolMove[] = [];
    for (const file of stale.changedSources) {
      for (const change of anchorChanges[file] ?? []) {
        if (attributedFeatures(registry, change.id).includes(stale.feature)) {
          symbolMoves.push({ file, symbol: change.name, kind: change.kind });
        }
      }
    }
    symbolMoves.sort((a, b) =>
      a.file !== b.file
        ? a.file < b.file
          ? -1
          : 1
        : a.symbol < b.symbol
          ? -1
          : a.symbol > b.symbol
            ? 1
            : 0,
    );
    return {
      feature: stale.feature,
      doc: stale.doc,
      changedSources: stale.changedSources,
      symbolMoves,
      docLastTouched: lastTouched(root, headSha, stale.doc),
    };
  });

  // The N-of-M denominator: every entry documented across the range, which is
  // the current registry UNION any base-only entry a deletion woke (an entry
  // removed in the range together with its source still drifted, and it was
  // documented at base). The union guarantees N ≤ M — without it, `drifted`
  // could exceed a current-registry-only count and render an incoherent
  // "6 of 5". Concept umbrellas are documented entries that can drift, so they
  // count too.
  const documented = new Set([
    ...Object.keys(registry.features),
    ...drifted.map((d) => d.feature),
  ]).size;

  return {
    base,
    head,
    baseSha: resolved.sha,
    headSha,
    baseEmptyTree: resolved.emptyTree,
    baseAmbiguous: resolved.ambiguous,
    algo: algoStamp(),
    documented,
    drifted,
    changedSources: state.changedSources.length,
    changedDocs: state.changedDocs.length,
    deletedSources: state.deletedSources,
    unmapped: state.unmapped,
    unevaluable: state.unevaluable,
    ownershipLints: state.ownershipLints,
  };
}
