import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import pc from "picocolors";
import {
  type Acknowledgment,
  ackCovers,
  isFileGrainAck,
  normalizeIdentity,
  readAcks,
} from "../lib/acknowledgment.js";
import { type ExclusionSpec, isExcluded, resolveScopeSync } from "../lib/analyze.js";
import {
  type ApprovedPlan,
  type ChangeState,
  computeChangeState,
  DEPENDENT_CAP,
  type DependentSummary,
  detectApprovedPlanScope,
  type OwnershipLint,
  removedInChange,
  resolveDocPointers,
  resolveFileGrainAcked,
  standingTreeAcks,
  type UngatedRegisteredChange,
} from "../lib/change-state.js";
import { anchorGates, computeDrift, type DriftFinding } from "../lib/drift.js";
import {
  fileContentTransition,
  gatherAnchorChanges,
  warmAdaptersForRepo,
} from "../lib/fingerprint.js";
import {
  assertRootIsRepoToplevel,
  getChangeAuthors,
  getHeadSha,
  getWorkingTreeChanges,
  getWorkingTreeDeletions,
  getWorkingTreeRenames,
  isGateableRoot,
  isGitRepo,
  movesOnly,
  type RenamePair,
  renamedFromMap,
  resolveWorkspace,
  workspaceBases,
} from "../lib/git.js";
import {
  allSources,
  isSourcePattern,
  parseRegistryOrThrow,
  type Registry,
  readRegistrySync,
  sourceMatcher,
} from "../lib/registry.js";
import {
  findCoveringReview,
  findLatestReviewForBase,
  gatherReviewedFiles,
  gatherReviewFingerprint,
  parseReviewArtifact,
  reviewedDelta,
  writeReview,
} from "../lib/review-artifact.js";
import {
  renderRoute,
  routesFor,
  whyNoAck,
  type ConditionId,
  type Palette,
  type Route,
} from "../lib/remedies.js";
import { gatherReviewBundle, type ReviewBundleDelta } from "../lib/review-bundle.js";
import {
  confirmCondition,
  confirmFindings,
  DEFAULT_TEST_SEARCH_DIRS,
  defaultCommandAvailable,
  makeTestRunner,
  resolveTestCommand,
  resolveTestPath,
} from "../lib/review-confirm.js";
import { emitCaught } from "../lib/review-events.js";
import {
  countResolvedMovedSymbols,
  evaluateReviewGate,
  type ReviewGateResult,
} from "../lib/review-gate.js";
import { gateUnavailableSarif, reviewReportToSarif } from "../lib/sarif.js";
import { MODULE_ANCHOR_NAME } from "../lib/ts-adapter.js";
import {
  blobExistsAtRef,
  EMPTY_TREE_SHA,
  GateError,
  readBlobAtRef,
  refReachable,
  resolveBase,
  worktreeChangesSince,
  worktreeDeletionsSince,
  worktreeRenamesSince,
} from "../lib/two-ref.js";
import { versionSkewNotice } from "../lib/version.js";

interface ReviewOptions {
  root?: string;
  json?: boolean;
  log?: boolean;
  strict?: boolean;
  /** Opt-in adversarial-review gate: exit 1 if a non-trivial diff lacks a current,
   *  fingerprint-bound review artifact (or one with unresolved confirmed findings).
   *  Default-on flip is soak-deferred, like the change-control gate's blocking flip. */
  requireReview?: boolean;
  /** Diff against the merge-base with this ref (the branch's drift since it
   *  diverged), not just the uncommitted working tree. */
  base?: string;
  /** Override the argv used to run a finding's named test (the literal `{file}`
   *  token is the resolved path). Defaults to codument's own `npx tsx --test`; a
   *  consumer project whose tests run differently sets this so the gate's
   *  re-confirmation step is not hardcoded to one toolchain. Accepts either real
   *  argv or a single whitespace-joined string (see `normalizeTestCommand`). */
  testCommand?: string[];
  /** Emit the adversarial-review BUNDLE (the oracle: touched features' invariants +
   *  their test pointers, the diff, ownership/blast facts) as JSON and exit. This is
   *  what an adversarial reviewer attacks; it adds no new source of truth. */
  bundle?: boolean;
  /** With `--bundle`: force the WHOLE change set even when a prior review of this
   *  base narrows it to a delta. The escape hatch for a deliberate fresh attack —
   *  after a rebase, a long gap, or when the earlier review is not trusted. */
  full?: boolean;
  /** Record an adversarial review from a findings JSON file
   *  (`{invariantsChecked, findings, signer}`): the command computes the
   *  fingerprint over the current diff AND the findings' named tests and writes the
   *  artifact, so the writer and the `--require-review` gate share one fingerprint
   *  contract (an agent cannot hand-compute it). */
  record?: string;
  /** ADR 006 strict mode: only an ack whose signer is independent of the change
   *  author clears a finding — a self-signed ack leaves the finding open (and so
   *  `--strict` fails on it). Off by default; the verdict is unchanged without it. */
  requireIndependentAck?: boolean;
  /** Output format for the verdict. `"sarif"` emits SARIF 2.1.0 (for CI code-scanning
   *  upload / reviewdog) instead of the human table; mutually exclusive with `--json`.
   *  Only changes stdout — the exit code still comes from `--strict`. */
  format?: string;
}

// A test command can arrive as real argv (`["node","--test","{file}"]`) or, because
// commander's variadic `<argv...>` rejects a leading-dash value like `--test`, as a
// single quoted string the user passed to dodge that (`"node --test {file}"`). Split
// the single-string form on whitespace so `--test-command "npx tsx --test {file}"`
// works. Genuine multi-element argv (no leading-dash args) is passed through as-is.
// Re-exported so existing callers (doctor, tests) keep one import site while the
// single implementation lives beside the runner that consumes it.
export { normalizeTestCommand } from "../lib/review-confirm.js";

export interface ReviewReport {
  version: 2;
  /** Discriminant: `"ok"` means the gate ran and this report is its verdict.
   *  The non-git `--json` output instead emits `{ gate: "unavailable", reason }`,
   *  so a consumer never has to interpret a null/absent `state` as "passed". */
  gate: "ok";
  isGitRepo: boolean;
  changedFileCount: number;
  /** Pure deletions in the change (any path kind) — counted in changedFileCount
   *  and consumed by the review fingerprint's real-change set. */
  deletions: string[];
  plan: ApprovedPlan | null;
  state: ChangeState;
  /** Per-symbol drift detail behind the verdict: which owned symbols moved, their
   *  co-movement telemetry, and which were cleared by a recorded acknowledgment. */
  drift: DriftFinding[];
  /** Every symbol move this change made that ADR 020 reports instead of gating —
   *  counted over the WHOLE anchor diff, not just `drift`, which carries only the
   *  moves an owning feature claims. A file no feature claims is exactly where a
   *  count derived from ownership would read as "the tool saw nothing", and the
   *  report is the entire consideration for dropping the block. */
  reportedNotGated: number;
  /** Files whose current content is covered by a file-grain ack (`codument ack
   *  <path>`) — the additive/concept/coarse staleness cleared this run. Surfaced so
   *  the resolution summary shows a file-ack AS an ack, never laundered as a doc
   *  update (over-acking stays visible). */
  fileGrainAcked: string[];
  /** Registry entries naming a source path that does not exist — rot this change did
   *  NOT create (that case is `state.registryPointers`, which does gate). Reported so
   *  the surface the loop runs every step stops being silent about a corrupt control
   *  plane; never a strict input, because failing a gate over inherited state is how a
   *  gate gets bypassed. Empty when the registry is clean, so the common case is
   *  byte-identical. */
  registryRot: Array<{ file: string; features: string[] }>;
  /** Every acknowledgment covering this change set (per-symbol and file-grain), with
   *  its signer and whether that signer is independent of the change author. Rendered
   *  as the "Acknowledgments in this change" card wherever the human already looks, so
   *  self-review is distinguishable from independent review and over-acking is loud.
   *  Always the FULL set (self + independent), even under `--require-independent-ack`
   *  where the self ones do not clear — so an ignored self-ack stays visible. */
  coveringAcks: CoveringAck[];
  /** Whether `--require-independent-ack` was in force for this run: a self-signed ack
   *  (signer is a change author) did NOT clear its finding, so a self-adjudicated move
   *  stays flagged. Echoed so the renderers can mark such acks ignored. */
  requireIndependentAck: boolean;
  /** Under the flag, whether independence could NOT be verified at all — the change has
   *  uncommitted edits in scope, or there is no committed author to check a signer
   *  against. Then NO ack clears (fail closed): commit the change and review a committed
   *  range so an independent signer can be checked. Always false without the flag. */
  independenceUnverifiable: boolean;
  /** Present only in workspace mode (nested member repos / submodules): the member
   *  repositories and each one's base HEAD, so a workspace verdict is reproducible
   *  from the tuple of member heads the way a plain repo's is from one sha. Null in
   *  the ordinary single-repo case, which is byte-identical to before. */
  workspace: { members: string[]; bases: Array<{ prefix: string; sha: string }> } | null;
}

/** One acknowledgment adjudicating this change — the shape both the `review` card and
 *  the HTML report render from, so they can never disagree. `independent` is recomputed
 *  from the signer vs the current change author (never a stored flag). */
export interface CoveringAck {
  anchorId: string;
  grain: "symbol" | "file" | "tree";
  /** The symbol name for a per-symbol ack; null for a file- or tree-grain ack. */
  symbol: string | null;
  /** Tree grain only: how many files this one vouch covered. The widening is the
   *  trade a tree ack makes, so it is stated wherever the ack is shown rather than
   *  left to be discovered by opening the record. */
  covers?: number;
  signer: string;
  reason: string;
  /** The signer differs from the change author (a second-party sign-off). */
  independent: boolean;
}

/** How a moved-owned-symbol drift finding was resolved (or not) — kept in one place
 *  so the human resolution line and the `--log` soak tally can never diverge. A
 *  file-grain ack is an ACK (no doc change owed), NOT a doc update, so it sits with
 *  `acked` on the friction side; a `changed` (moved) symbol is never file-acked. */
export type DriftResolution = "acked" | "file-acked" | "doc-updated" | "flagged";

export function driftResolution(
  finding: DriftFinding,
  staleFeatures: Set<string>,
  fileGrainAcked: Set<string>,
): DriftResolution {
  if (finding.acknowledged) return "acked";
  if (staleFeatures.has(finding.feature)) return "flagged";
  // Feature not stale and not symbol-acked → resolved. A file-grain ack over the
  // file resolves an ADDITIVE (added/removed) finding; a moved symbol never is.
  const sep = finding.anchorId.indexOf("::");
  const file = sep === -1 ? finding.anchorId : finding.anchorId.slice(0, sep);
  if (finding.kind !== "changed" && fileGrainAcked.has(file)) return "file-acked";
  return "doc-updated";
}

// The registry blob as of `ref`, for resolving what a DELETED file's ownership
// was while it still existed. Honestly-absent (no commits yet, or no registry at
// the ref) → undefined, and the caller falls back to the current registry; any
// OTHER failure is loud — a broken git read here must never quietly fall back,
// because the fallback is exactly what the registry-entry-removal dodge needs.
// Present-but-unparseable stays a loud RegistryError, same rule as the worktree.
/**
 * `review`'s palette for a catalog route, and the one line that prints it.
 *
 * The catalog holds the words and this holds the colors, so a route reads the
 * same here as it does from `ack` or `doctor` while each keeps its own look.
 * The label column width stays with the caller: it depends on which labels share
 * a block, which is a layout fact about this screen, not about the condition.
 */
const ROUTE_PALETTE: Palette = { plain: (s) => s, cmd: pc.cyan, dim: pc.dim };

function routeLine(route: Route, width: number): string {
  return `${pc.dim(`${route.label.padEnd(width)} →`)} ${renderRoute(route, ROUTE_PALETTE)}`;
}

/** A catalog clause reads mid-sentence; these summary lines start one. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function readRegistryAtRef(root: string, ref: string): Registry | undefined {
  // A repo with no commits yet has no base to read — an honest "no base
  // registry" (a genuinely bad --base already failed loud in resolveBase).
  if (!refReachable(root, ref)) return undefined;
  if (!blobExistsAtRef(root, ref, "docs/.registry.json")) return undefined;
  const raw = readBlobAtRef(root, ref, "docs/.registry.json");
  if (raw === null) {
    // Exists per ls-tree but unreadable per show: a broken git, not absence.
    throw new GateError(`could not read docs/.registry.json at ${ref}`, "git-failed");
  }
  return parseRegistryOrThrow(raw, `docs/.registry.json@${ref}`);
}

/**
 * Deterministic review report for the uncommitted working-tree diff. Pure given
 * the repo state (git changes + registry + approved plan). The same diff always
 * produces the same report — no clock, no randomness, sorted throughout.
 */
// Registry sources that are not on disk, minus the ones THIS change removed (those
// gate, and reporting them twice under two headings reads as two problems). A pattern
// is skipped: a glob is not a path, and asking whether it exists is the wrong
// question — `doctor` answers the right one (does it match anything) because it is
// the surface that holds the file list.
/**
 * The files this change REMOVED, at either grain.
 *
 * A deletion owes its owning doc attention and nothing else: `ack` refuses one by
 * name ("no acknowledgment clears a deletion"), per the ack-scope decision's
 * conservative stance. So no surface may offer the ack route over one — and the
 * set is derived once, here, because the two places that decide the route are what
 * let `review` print a command `ack` was always going to refuse.
 */
function deletedInChange(state: {
  deletedSources: readonly string[];
  governedDeleted: readonly string[];
}): Set<string> {
  return new Set([...state.deletedSources, ...state.governedDeleted]);
}

/** A path's extension as the grain notice names it — `.rules`, `.json` — or the bare
 *  filename where there is none, since `Dockerfile` reads better than an empty string. */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : base;
}

function registryRot(
  root: string,
  registry: Registry,
  gated: readonly { file: string }[],
): Array<{ file: string; features: string[] }> {
  const gatedSet = new Set(gated.map((p) => p.file));
  const byFile = new Map<string, string[]>();
  for (const key of Object.keys(registry.features).sort()) {
    for (const source of allSources(registry.features[key])) {
      if (isSourcePattern(source) || gatedSet.has(source)) continue;
      if (existsSync(join(root, source))) continue;
      const list = byFile.get(source) ?? [];
      list.push(key);
      byFile.set(source, list);
    }
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, features]) => ({ file, features }));
}

export function buildReview(
  root: string,
  changedFiles?: string[],
  baseRef = "HEAD",
  deletedFiles?: string[],
  opts: {
    requireIndependentAck?: boolean;
    exclusion?: ExclusionSpec;
    /** Renames in this change. Defaults to the working-tree view; the `--base`
     *  caller passes its own ref-ranged list, exactly as it does for changes and
     *  deletions. */
    renames?: RenamePair[];
  } = {},
): ReviewReport {
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  const ws = resolveWorkspace(root);
  // The project's own exclusions. Resolved here by default rather than required
  // from every caller, because a caller who forgot to pass the spec would
  // silently fall back to the defaults — the exact divergence this config exists
  // to end. A caller that already resolved (the `review` command, `watch`'s
  // per-tick refresh) passes its result in so one run reads the file once.
  const exclusion = opts.exclusion ?? resolveScopeSync(root).spec;
  // Callers that already computed the working-tree changes (e.g. `watch`, which
  // also needs them for its activity tape) can pass them in to avoid a second
  // `git status` tree scan per refresh; default to computing them here.
  const changes = changedFiles ?? getWorkingTreeChanges(root);
  // Pure deletions are first-class: a deleted owned source must wake its doc
  // exactly like an edit would (the `--base` caller passes its own two-ref list).
  const deletions = deletedFiles ?? getWorkingTreeDeletions(root);
  // A rename's origin reaches the verdict ONLY here: the destination rides
  // `changes`, but the vanished path is what a registry entry may still name.
  // Filtered to genuine MOVES before anything reads it: git pairs by similarity,
  // so a copy or a file split (`git mv a b` plus a shim at `a`) arrives as a
  // rename whose origin is still present. Both consumers below would be wrong
  // about it — the anchor map would read the new file's base from the original
  // and launder its whole contract as unchanged, and the pointer finding would
  // demand the registry stop naming a file that exists.
  const renames = movesOnly(opts.renames ?? getWorkingTreeRenames(root), new Set(changes));
  const plan = detectApprovedPlanScope(root);
  // Per-symbol anchor diffs for the precise (TS) changed files, base ref vs the
  // working tree — this is what dissolves the shared-file cascade in the verdict.
  // Best-effort: coarse/non-TS files degrade to file-grain ownership; parse-error
  // files come back as `unevaluable` (gated file-grain AND surfaced).
  // Destination → origin, so a moved file's base content is read from where it
  // actually lived. Without it a pure rename reports every symbol as newly added
  // and wakes the owning doc for a change that moved no contract.
  const renamedFrom = renamedFromMap(renames, new Set(changes));
  const { anchorChanges, unevaluable } = gatherAnchorChanges(root, baseRef, changes, renamedFrom);
  const acks = readAcks(root);
  // Change authorship (pure repo state) — the source of "the change author" for the
  // self-vs-independent split, computed once and shared by the card and the strict
  // independence gate below.
  const changeAuthors = new Set(
    [...getChangeAuthors(root, baseRef)].map((a) => normalizeIdentity(a)),
  );
  // Independence is provable only against COMMITTED authorship (`base..HEAD`). If a
  // reviewed source file still carries an uncommitted edit, its author is not in
  // `changeAuthors` (an uncommitted edit is nobody's commit yet), so a "signer not among
  // the commit authors" test would falsely read independent — the laundering hole. Guard
  // it: authorship is verifiable only when there IS a commit author AND no reviewed source
  // file has an uncommitted edit. Scope the check to reviewed SOURCE — codument's own
  // `.codument/` metadata (the ack artifacts themselves) and excluded/generated paths are
  // never the reviewed change, and both leak untracked into the change set, so they must
  // not read as "dirty". Pure: `git status` and `git log` are repo state, no ambient identity.
  const inScopeSource = [...new Set([...changes, ...deletions])].filter(
    (f) => !f.startsWith(".codument/") && !isExcluded(f, exclusion),
  );
  const uncommitted = new Set([...getWorkingTreeChanges(root), ...getWorkingTreeDeletions(root)]);
  const uncommittedInScope = inScopeSource.some((f) => uncommitted.has(f));
  const authorshipVerifiable = changeAuthors.size > 0 && !uncommittedInScope;
  const independentOf = (signer: string): boolean =>
    authorshipVerifiable && !changeAuthors.has(normalizeIdentity(signer));
  // `--require-independent-ack` (ADR 006 strict mode): only an ack whose signer is
  // independent of the change author counts toward CLEARING a finding. A self-signed
  // ack (or ANY ack when authorship is not verifiable) is dropped from the honored set,
  // so its finding stays open exactly as if unacked — no new blocking semantics, just a
  // stricter definition of "cleared", and it fails CLOSED (never launders a self-ack on
  // an unverifiable change). Off by default, honoredAcks === acks, byte-identical.
  const requireIndependentAck = opts.requireIndependentAck === true;
  const honoredAcks = requireIndependentAck ? acks.filter((a) => independentOf(a.signer)) : acks;
  // Under the flag, whether independence simply could not be verified (no committed
  // author, or an uncommitted edit in scope) — distinct from "all covering acks were
  // self", so the renderer can say WHY nothing cleared (commit + review a range).
  const independenceUnverifiable = requireIndependentAck && !authorshipVerifiable;
  // Resolve per-symbol drift + acknowledgments: an acked move is adjudicated (a
  // recorded "refactor, no doc change owed" decision) and dropped from the set the
  // stale-doc verdict sees; co-movement is attached as info-only telemetry.
  const { findings: drift, filtered } = computeDrift(
    root,
    baseRef,
    registry,
    anchorChanges,
    honoredAcks,
  );
  // File-grain acks (`codument ack <path>`): a bare-path ack covering a file's
  // current content clears its additive/concept/coarse staleness (never a moved
  // symbol). Resolved here (git+disk) and passed to the pure analyzer.
  // A tree ack (`codument ack <registered pattern>`) folds into the same set: the
  // judgment is identical, made once for a tree that is governed as one thing. The
  // touched set carries deletions too, so a removal inside the tree refuses the vouch
  // instead of sitting outside it.
  const standingTrees = standingTreeAcks(
    root,
    baseRef,
    [...changes, ...deletions],
    acks,
    registry,
    exclusion,
    renamedFrom,
  );
  const resolveAcked = (set: Acknowledgment[]): string[] =>
    [
      ...new Set([
        ...resolveFileGrainAcked(root, baseRef, changes, set, unevaluable, renamedFrom),
        ...set.flatMap((a) => standingTrees.get(a) ?? []),
      ]),
    ].sort();
  const fileGrainAcked = resolveAcked(honoredAcks);
  // Rename destinations whose content did not actually move. The precise grain says
  // this for itself with an empty anchor diff; coarse and governed-registered files
  // have no per-symbol view to say it with, so it is computed once here — from the
  // same map the anchors use, so no two grains can disagree about what moved.
  const unchangedMoves = [...renamedFrom]
    .filter(([to, from]) => {
      const t = fileContentTransition(root, baseRef, to, from);
      return t.from !== null && t.from === t.to;
    })
    .map(([to]) => to);
  const state = computeChangeState({
    registry,
    changedFiles: changes,
    exclusion,
    planScope: plan?.scope,
    anchorChanges: filtered,
    // The ORIGINAL (pre-ack-filter) movement set: concept umbrellas wake off
    // this, so a per-symbol ack can never clear an umbrella's file-grain flag.
    // Filtered by the SAME predicate the per-symbol path uses, or a body-only
    // move would stop waking its own feature and go on waking the umbrella
    // narrating the directory above it — one question answered two ways, which
    // is the failure this codebase keeps paying for.
    contentMovedFiles: Object.entries(anchorChanges)
      .filter(([, v]) => v.some(anchorGates))
      .map(([k]) => k),
    unevaluable,
    fileGrainAcked,
    deletedFiles: deletions,
    renames,
    unchangedMoves,
    // Deleted files resolve ownership against the registry AT THE BASE — the
    // entry that owned the file while it existed — so removing the entry in the
    // same change cannot dodge the wake.
    baseRegistry: deletions.length > 0 ? readRegistryAtRef(root, baseRef) : undefined,
    // The prose pointer beside the registry pointer. Resolved here because reading a
    // doc is impure and the analyzer never touches the filesystem; both findings read
    // one removal set, so they cannot disagree about what is gone.
    docPointers: resolveDocPointers(root, registry, removedInChange(renames, changes, deletions)),
  });
  // The acks adjudicating this change — the audit card both the human review and the
  // HTML report read. Computed from the FULL ack set (not `honoredAcks`), so under
  // `--require-independent-ack` a self-ack that did NOT clear its finding is still
  // shown (badged self, ignored) rather than silently dropped: over-acking and
  // rejected self-review both stay visible. Off the flag this set equals the honored
  // resolution, so the verdict and the card are byte-identical to before.
  const coveringAcks: CoveringAck[] = [];
  for (const d of drift) {
    // Match computeDrift's ack eligibility exactly: only a body-only `changed` move
    // is ackable — an added/removed symbol has no transition, and a SIGNATURE move is
    // never honored (per-symbol or file-grain). Skipping sig moves keeps the card from
    // showing a hand-written/merged sig-move ack as "covering" a finding the gate still
    // fails, and keeps the off-flag card byte-identical to the drift-derived build.
    if (d.from === undefined || d.to === undefined || d.signatureChanged) continue;
    const ack = acks.find((a) => ackCovers(a, d.anchorId, d.from as string, d.to as string));
    if (ack) {
      coveringAcks.push({
        anchorId: d.anchorId,
        grain: "symbol",
        symbol: d.symbol,
        signer: ack.signer,
        reason: ack.reason,
        independent: independentOf(ack.signer),
      });
    }
  }
  // File-grain coverage for the card uses the FULL ack set too (a self file-ack stays
  // visible under the flag), so resolve it independently of the honored gate set.
  const cardFileGrainAcked = requireIndependentAck ? resolveAcked(acks) : fileGrainAcked;
  // A tree ack is ONE judgment over many files, so the card shows it once, named as
  // the tree with what it covered. Listing its members as 120 file acks would report
  // the opposite of what happened — a wide vouch is the thing an audit card exists to
  // make loud, and a hundred rows is how it would get skipped instead.
  for (const [ack, covered] of standingTrees) {
    coveringAcks.push({
      anchorId: ack.anchorId,
      grain: "tree",
      symbol: null,
      covers: covered.length,
      signer: ack.signer,
      reason: ack.reason,
      independent: independentOf(ack.signer),
    });
  }
  // A tree-covered file carries no file-grain ack of its own, so the loop below never
  // doubles it — the tree row above is the only thing that speaks for it.
  for (const file of cardFileGrainAcked) {
    const { from, to } = fileContentTransition(root, baseRef, file, renamedFrom.get(file) ?? file);
    if (from === null || to === null) continue;
    // A standing vouch (ADR 019) clears nothing since ADR 020 retired it, so it can
    // never be the ack shown here — the card names what actually adjudicated the
    // change, and a retired record adjudicated none of it.
    const ack = acks.find((a) => isFileGrainAck(a) && !a.standing && ackCovers(a, file, from, to));
    if (ack) {
      coveringAcks.push({
        anchorId: file,
        grain: "file",
        symbol: null,
        signer: ack.signer,
        reason: ack.reason,
        independent: independentOf(ack.signer),
      });
    }
  }
  coveringAcks.sort((a, b) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0));

  return {
    version: 2,
    gate: "ok",
    isGitRepo: isGitRepo(root),
    // Deletions are part of the change: a deletion-only tree is not "clean".
    changedFileCount: changes.length + deletions.length,
    deletions,
    plan,
    state,
    drift,
    // Counted over the whole anchor diff, so an unclaimed file's move is disclosed
    // too — but only within the gate's own scope. Two exclusions, for the same
    // reason: a number on the verdict line must be one the reader can account for.
    // A DECLARED-EXCLUDED file is already counted as excluded on the change line, so
    // reporting a move inside it announces the tool read a file it says it ignores.
    // The MODULE RESIDUAL holds what did not anchor as an export, so it is not a
    // symbol move and no symbol in the diff would account for it.
    reportedNotGated: Object.entries(anchorChanges)
      .filter(([file]) => !isExcluded(file, exclusion))
      .flatMap(([, v]) => v)
      .filter((ch) => !anchorGates(ch) && ch.name !== MODULE_ANCHOR_NAME).length,
    fileGrainAcked,
    registryRot: registryRot(root, registry, state.registryPointers),
    coveringAcks,
    requireIndependentAck,
    independenceUnverifiable,
    workspace: ws.isWorkspace
      ? { members: ws.members.map((m) => m.prefix || "<root>"), bases: workspaceBases(ws) }
      : null,
  };
}

export async function review(options: ReviewOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();
  // The same resolution buildReview performs, for the gate paths that scope a
  // real-change set outside the report itself.
  const { spec: exclusion } = resolveScopeSync(root);

  // Output-format guard: SARIF is the only non-default format, and it cannot combine
  // with --json (two machine shapes, one stdout). A usage error is human text + exit 1,
  // never a half-valid document a consumer might parse.
  const sarifMode = options.format === "sarif";
  if (options.format !== undefined && !sarifMode) {
    console.log(pc.red(`  ✗ unknown --format "${options.format}" (supported: sarif)`));
    process.exitCode = 1;
    return;
  }
  // SARIF is one machine shape on stdout; it cannot share the channel with another
  // output mode (--json) or a mode that emits its own document and returns early
  // (--bundle, --record). A silent override would hand CI a non-SARIF payload, so it
  // is a usage error, not a quiet win-for-the-other-flag.
  if (sarifMode && (options.json || options.bundle || options.record)) {
    console.log(
      pc.red(
        "  ✗ --format sarif cannot combine with --json, --bundle, or --record; pick one output.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (!isGateableRoot(root)) {
    // The gate could not run — no repo to diff. Under a gating flag this fails
    // closed (never a silent green), exactly like an unreachable base. Bare
    // `review` stays informational (exit 0). `--json` always emits a valid
    // discriminated shape, never a type-violating `state: null`.
    const failClosed = !!options.strict || !!options.requireReview;
    if (sarifMode) {
      // The SARIF's own discriminant says the gate could not run
      // (executionSuccessful:false), so the exit code must agree — always nonzero,
      // matching the wrong-root branch, so a CI gating on the exit code alone never
      // reads a gate-unavailable run as green.
      console.log(JSON.stringify(gateUnavailableSarif("not a git repository"), null, 2));
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      console.log(
        JSON.stringify(
          { version: 2, gate: "unavailable", reason: "not a git repository", isGitRepo: false },
          null,
          2,
        ),
      );
      if (failClosed) process.exitCode = 1;
      return;
    }
    console.log(pc.bold("codument review"));
    console.log();
    if (failClosed) {
      console.log(pc.red("  ✗ not a git repository (gate could not run)"));
      process.exitCode = 1;
      return;
    }
    console.log(pc.yellow("  Not a git repository — review inspects the working-tree diff."));
    return;
  }

  let report: ReviewReport;
  // The base the diff (and so the review fingerprint) is computed against. Captured
  // here so the --require-review gate fingerprints the same change set the report
  // describes; the artifact writer (the review skill) uses the same convention.
  let effectiveBase = "HEAD";
  try {
    // A subdirectory root produces WRONG answers (everything unmapped, every doc
    // fresh), not absent ones — assert loudly before any verdict is computed.
    assertRootIsRepoToplevel(root);
    // The gate path below is synchronous; adapters that parse through a WASM
    // grammar load it here or fail loud when reached cold.
    await warmAdaptersForRepo(root);
    const reviewOpts = {
      requireIndependentAck: options.requireIndependentAck === true,
      exclusion,
    };
    if (options.base) {
      // A single ref cannot name a state of several repositories, so ref-ranged
      // review is refused in a workspace rather than answered with a guess (a
      // per-member ref map, or diffing gitlink shas, would put a guess on the
      // verdict path — ADR-016). The worktree gate above still works across
      // members; CI enforcement for a nested-member monorepo is doctor plus the
      // worktree gate, not the two-ref PR gate. Fail closed, named.
      if (resolveWorkspace(root).isWorkspace) {
        throw new GateError(
          `--base cannot review a workspace of member repositories: a single ref names one repository, not the tuple of member heads a workspace state is. Run ref-ranged review inside the member repository whose history you mean.`,
          "wrong-topology",
        );
      }
      // Diff the working tree against the merge-base with `options.base` (the
      // branch's drift since it diverged). Resolve that base once so anchors and
      // the changed-file set answer the same question.
      const baseRef = resolveBase(root, options.base, "HEAD").sha;
      const changes = worktreeChangesSince(root, options.base);
      report = buildReview(root, changes, baseRef, worktreeDeletionsSince(root, options.base), {
        ...reviewOpts,
        renames: worktreeRenamesSince(root, options.base),
      });
      effectiveBase = baseRef;
    } else {
      // Default: working tree vs HEAD (what `git status` shows). Resolve HEAD to a
      // real object name (the empty tree before the first commit) so the fingerprint
      // base is a stable sha, never the literal "HEAD" — the step-5 writer records
      // exactly this value, and a fresh-repo/first-commit boundary cannot flip it.
      report = buildReview(root, undefined, "HEAD", undefined, reviewOpts);
      effectiveBase = getHeadSha(root) ?? EMPTY_TREE_SHA;
    }
  } catch (err) {
    // Fail closed: the gate could not run (e.g. an unreachable base on a shallow
    // clone, or a subdirectory root). Distinct from "ran and passed" so CI never
    // treats it as green. `--json` gets the same discriminated shape as the
    // non-git case, never broken output a consumer could misread.
    if (err instanceof GateError) {
      if (sarifMode) {
        console.log(JSON.stringify(gateUnavailableSarif(err.message), null, 2));
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              version: 2,
              gate: "unavailable",
              reason: err.message,
              kind: err.kind,
              isGitRepo: true,
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      console.log(pc.bold("codument review"));
      console.log();
      console.log(pc.red(`  ✗ ${err.message} (gate could not run)`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // --bundle: emit the oracle an adversarial reviewer attacks (the touched features'
  // documented invariants + their test pointers, the diff, ownership/blast facts),
  // then exit. Pure JSON, no new source of truth — the host pipes it to a fresh
  // reviewer subagent (Claude) or reads it for the same-agent pass (Codex).
  if (options.bundle) {
    const registry = readRegistrySync(join(root, "docs", ".registry.json"));
    const plan = detectApprovedPlanScope(root);
    // Delta scope: when a review of this same base was already recorded, the
    // reviewer attacks only what moved since — the fix, not the eleven files the
    // fix did not touch. That is where the re-review round's cost actually goes.
    // The gate is untouched by this: it still requires ONE artifact covering every
    // byte of the change set, so a narrow read can never buy a broad pass.
    let delta: ReviewBundleDelta | null = null;
    if (!options.full) {
      const prior = findLatestReviewForBase(root, effectiveBase);
      if (prior?.files) {
        const { set: realChangeSet } = computeRealChange(report, report.deletions, exclusion);
        const current = gatherReviewedFiles(root, realChangeSet);
        const moved = reviewedDelta(prior.files, current);
        // Only narrow when it genuinely narrows AND leaves something to attack.
        // Nothing moved → the prior review still covers; an empty delta bundle
        // would tell the adversary to attack nothing, so fall back to full.
        if (moved.length > 0 && moved.length < current.length) {
          const movedSet = new Set(moved);
          delta = {
            paths: moved,
            alreadyReviewed: current.filter((f) => !movedSet.has(f.path)).map((f) => f.path),
            priorFindings: prior.findings,
          };
        }
      }
    }
    const bundle = gatherReviewBundle(root, effectiveBase, report.state, registry, plan, delta);
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }

  // --record: write a fingerprint-bound review artifact from the reviewer's findings
  // JSON (`{invariantsChecked, findings, signer}`). The fingerprint is computed HERE
  // over the SAME real-change set + named tests the gate uses, so the writer can
  // never drift from the gate's contract (an agent cannot hand-compute a sha256).
  if (options.record) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolvePath(root, options.record), "utf8"));
    } catch (err) {
      console.log(pc.red(`  ✗ could not read findings file: ${(err as Error).message}`));
      process.exitCode = 1;
      return;
    }
    const r = (raw ?? {}) as { invariantsChecked?: unknown; findings?: unknown; signer?: unknown };
    // Validate the shape first (placeholder fingerprint), then compute the real
    // fingerprint from the VALIDATED findings, so a malformed review is rejected
    // before anything is written.
    const provisional = parseReviewArtifact({
      base: effectiveBase,
      diffFingerprint: "pending",
      invariantsChecked: r.invariantsChecked,
      findings: r.findings,
      signer: r.signer,
    });
    if (!provisional) {
      console.log(
        pc.red(
          "  ✗ invalid review: need a non-empty invariantsChecked, a signer, and well-formed findings (citation, detail, status).",
        ),
      );
      process.exitCode = 1;
      return;
    }
    const { set: realChangeSet } = computeRealChange(report, report.deletions, exclusion);
    const resolveTest = (ref: string) => resolveTestPath(root, ref, DEFAULT_TEST_SEARCH_DIRS);
    const fp = gatherReviewFingerprint(
      root,
      effectiveBase,
      realChangeSet,
      provisional.findings,
      resolveTest,
    );
    // `files` rides along as scoping information for the NEXT `--bundle` (what moved
    // since this recording), computed by the CLI like the fingerprint is — an agent
    // cannot hand-author it. The gate ignores it entirely; coverage stays the single
    // whole-set fingerprint equality, so this can never become a per-file pass.
    const path = writeReview(root, {
      ...provisional,
      diffFingerprint: fp,
      files: gatherReviewedFiles(root, realChangeSet),
    });
    console.log(`  ${pc.green("✓")} Recorded adversarial review → ${path}`);
    return;
  }

  // A symbol is resolved-by-doc-update iff its feature is NOT stale per the verdict
  // (ADR 010) — the same verdict-derived rule the human display uses, so the soak
  // tally and the display agree. Co-movement is never the resolution signal.
  const staleFeatures = new Set(report.state.staleDocs.map((s) => s.feature));

  // Opt-in: snapshot the deterministic catches (stale docs, risk touches,
  // off-plan files) as a `caught` event — the provable line of the impact ledger.
  // Identities, not counts, so the ledger can count distinct things caught. Off
  // by default to avoid a surprise file write; `commit-work` runs it at commit.
  if (options.log) {
    const d = report.drift;
    const fileGrainAcked = new Set(report.fileGrainAcked);
    // Partition resolutions with the shared classifier so the calibration data
    // matches the human summary exactly. A file-grain ack is counted AS an ack (no
    // doc change owed), never as a doc update, so the friction rate stays honest.
    let docUpdated = 0;
    let fileAcked = 0;
    for (const f of d) {
      const r = driftResolution(f, staleFeatures, fileGrainAcked);
      if (r === "doc-updated") docUpdated++;
      else if (r === "file-acked") fileAcked++;
    }
    emitCaught(root, {
      commit: getHeadSha(root),
      staleDocs: report.state.staleDocs.map((s) => s.doc),
      riskTouches: report.state.riskTouches.map((r) => r.feature),
      offPlan: report.state.outOfPlan,
      // Per-symbol drift soak tally. Resolution is verdict-derived: a doc update
      // (the owning doc changed), a symbol ack, or a file-grain ack (additive residue).
      // The co-movement fields are info-only telemetry for calibrating co-movement
      // itself, never a resolution signal.
      drift: {
        flagged: d.length,
        sigMoved: d.filter((f) => f.signatureChanged).length,
        bodyMoved: d.filter((f) => f.kind === "changed" && !f.signatureChanged).length,
        docUpdated,
        fileAcked,
        acknowledged: d.filter((f) => f.acknowledged).length,
        coMoved: d.filter((f) => f.comovement === "co-moved").length,
        proseUnchanged: d.filter((f) => f.comovement === "prose-unchanged").length,
        notReferenced: d.filter((f) => f.comovement === "not-referenced").length,
      },
      // The identity-bearing form: one record per transition (anchorId +
      // from→to), so the ledger counts each once across re-logged snapshots.
      driftTransitions: d.map((f) => ({
        anchorId: f.anchorId,
        from: f.from ?? null,
        to: f.to ?? null,
        resolution: driftResolution(f, staleFeatures, fileGrainAcked),
        comovement: f.comovement,
        signatureChanged: f.signatureChanged,
      })),
    });
  }

  // --strict gates the agent loop: a step is not done while it left a new source
  // unmapped or a mapped doc stale. Diff-scoped, so it never trips on pre-existing
  // gaps the step did not touch; it deliberately ignores dependents/risk
  // (informational) and depends_on (a separate concern), so the gate stays
  // satisfiable — a genuine leaf feature with no deps can still pass.
  const strictFail =
    !!options.strict &&
    (report.state.unmapped.length > 0 ||
      report.state.staleDocs.length > 0 ||
      // A registry entry naming a path this change removed. The registry is the
      // control plane every other answer derives from, so letting a step commit a
      // pointer to a file that no longer exists is a green verdict over a corrupted
      // ground truth — the one thing worse than a stale doc.
      report.state.registryPointers.length > 0 ||
      // The same corruption one layer out: a doc still sending its reader to a path
      // this change took away. The registry's pointer was checked and the prose
      // pointer beside it was not, so a rename that correctly re-pointed the entry
      // went green with the owning doc naming a file that is gone.
      report.state.docPointers.length > 0);

  // Adversarial-review gate (opt-in). For a NON-TRIVIAL diff it requires a current,
  // fingerprint-bound review artifact whose findings — RE-CONFIRMED here by running
  // each named test — carry no unresolved blocker. Proportionality covers the full
  // real-change set (sources + config/data + deletions) plus ownership ambiguities,
  // and excludes the `<module>` residual from the "one trivial symbol" fast-path, so
  // nothing real reads as trivial. The fingerprint binds both the reviewed sources
  // AND the tests the findings name, so any real edit — including tampering a test
  // to clear its finding — auto-invalidates the review. The gate RE-DERIVES finding
  // statuses (a toolchain failure is unrunnable, never a false block) rather than
  // trusting the artifact's claim; its honest limit is that an empty/omitted-findings
  // review still passes (soak/audit territory), so it does not certify thoroughness.
  let reviewGate: ReviewGateResult | null = null;
  // Files that moved since the last recorded review of this base, when that is a
  // strict subset of the change set — the size of the re-attack the reviewer owes.
  // Null means "no useful prior recording", i.e. the whole set.
  let unreviewedCount: number | null = null;
  // Named condition: the DEFAULT test command resolves local-only (no network on
  // the verdict path), so a project without local tsx cannot run the confirm
  // step. Still non-blocking (the documented fail-open stance for unverifiable
  // claims) but rendered where the human decides — never a silent advisory.
  let confirmUnavailable: string | null = null;
  if (options.requireReview) {
    // Flag > `testCommand` in .codument-meta.json > the built-in default. A project
    // declares its runner once instead of re-typing it on every gated run.
    const resolvedTest = resolveTestCommand(root, options.testCommand);
    const { set: realChangeSet, realDeletions } = computeRealChange(
      report,
      report.deletions,
      exclusion,
    );
    // A covering review binds both the reviewed sources AND the tests its findings
    // name; resolveTest locates a finding's test exactly as the runner does, so a
    // tampered or deleted test moves the fingerprint and reopens the gate.
    const resolveTest = (ref: string) => resolveTestPath(root, ref, DEFAULT_TEST_SEARCH_DIRS);
    const covering = findCoveringReview(root, effectiveBase, realChangeSet, resolveTest);
    // Re-derive each finding's status by RUNNING its named test — never trust a
    // status the artifact merely claims. A red test re-promotes to confirmed; a
    // toolchain failure (missing runner, resolution error) is unrunnable → advisory.
    const confirmedFindings = covering
      ? confirmFindings(covering.findings, makeTestRunner({ root, command: resolvedTest.command }))
          .findings
      : null;
    // The honesty condition is keyed on OUTCOMES, not on which flag was passed.
    // Keying it on flag-absence meant supplying any command silenced it, working or
    // not: a project pointing at a runner that emits no TAP got every finding
    // quietly downgraded to advisory with nothing on screen — the silent
    // always-green this gate exists to prevent. What the human needs to know is how
    // many claims went unjudged, whatever the reason.
    const unadjudicated = confirmedFindings?.filter((f) => f.testOutcome === "unrunnable") ?? [];
    confirmUnavailable = confirmCondition({
      problem: resolvedTest.problem,
      unadjudicated: unadjudicated.length,
      noun: "finding",
      consequence: "advisory rather than judged",
      defaultUnavailable: !resolvedTest.command && !defaultCommandAvailable(root),
    });
    reviewGate = evaluateReviewGate(
      {
        realChangeCount: realChangeSet.length,
        changedSourceCount: report.state.changedSources.length,
        otherChangedCount: report.state.otherChanged.length,
        deletionCount: realDeletions.length,
        riskTouchCount: report.state.riskTouches.length,
        ownershipLintCount: report.state.ownershipLints.length,
        moduleResidualMoved: report.drift.some((d) => d.symbol === MODULE_ANCHOR_NAME),
        movedSymbolCount: countResolvedMovedSymbols(report.drift.map((d) => d.symbol)),
      },
      confirmedFindings,
    );
    // How much of the change set is actually unreviewed. Purely for the message —
    // the verdict above is already decided. Without it the gate says "review this
    // diff" after every one-line fix, which is what made a three-finding step cost
    // three whole-diff attacks.
    if (!covering) {
      const prior = findLatestReviewForBase(root, effectiveBase);
      if (prior?.files) {
        const moved = reviewedDelta(prior.files, gatherReviewedFiles(root, realChangeSet));
        if (moved.length > 0 && moved.length < realChangeSet.length) unreviewedCount = moved.length;
      }
    }
  }
  const reviewGateFail = !!reviewGate && !reviewGate.passed;

  if (sarifMode) {
    // The gate verdict as SARIF for CI code-scanning upload. Stdout only: the exit
    // code still comes from --strict (and --require-review), so `review --strict
    // --format sarif` both prints the annotations and fails the check. The
    // adversarial-review gate has no result representation (its findings are not in
    // the change-state), so a block is carried as an unsuccessful-invocation
    // notification — otherwise an exit-1 --require-review run would upload a SARIF
    // that reads as a clean pass.
    const notifications: string[] = [];
    if (reviewGateFail) {
      notifications.push(
        "adversarial review gate blocked: no current adversarial review covers this change, or it carries unresolved confirmed findings" +
          (unreviewedCount !== null
            ? ` (${unreviewedCount} file${unreviewedCount === 1 ? "" : "s"} moved since the last recorded review)`
            : "") +
          " (run `codument review --require-review` for detail).",
      );
    }
    console.log(JSON.stringify(reviewReportToSarif(report, notifications), null, 2));
    if (strictFail || reviewGateFail) process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        reviewGate
          ? {
              ...report,
              reviewGate: confirmUnavailable ? { ...reviewGate, confirmUnavailable } : reviewGate,
            }
          : report,
        null,
        2,
      ),
    );
    if (strictFail || reviewGateFail) process.exitCode = 1;
    return;
  }

  printHuman(report);

  // Advisory skew nudge — human output only (the --json contract is untouched);
  // never a finding, never an exit-code input.
  {
    const skew = versionSkewNotice(root);
    if (skew) console.log(pc.dim(`  ${skew}`));
  }

  if (strictFail) {
    const reasons: string[] = [];
    if (report.state.unmapped.length > 0)
      reasons.push(`${report.state.unmapped.length} unmapped new source file(s)`);
    if (report.state.staleDocs.length > 0)
      reasons.push(`${report.state.staleDocs.length} stale doc(s)`);
    if (report.state.registryPointers.length > 0)
      reasons.push(
        `${report.state.registryPointers.length} registry entr(ies) naming a path this change removed`,
      );
    if (report.state.docPointers.length > 0)
      reasons.push(`${report.state.docPointers.length} doc(s) naming a path this change removed`);
    console.log(
      pc.red(
        `  ✗ --strict: ${reasons.join(" and ")} — the registry/docs are not in sync for this change.`,
      ),
    );
    // When the stale docs trace to an unclaimed shared symbol, say so ON the
    // blocking line. The same words used to print as a ⚠ advisory further down,
    // between high-fanout and dependents, and a field run read past them 25 times:
    // a reader triaging a red gate reads the red line, and anything beside it is
    // scenery. Both numbers are stated because the ratio IS the finding — N docs
    // woken by one file is the churn, and one registry edit ends all of it.
    // A doc is ownership-driven only where the unresolved symbol names ITS feature
    // as a candidate owner. A concept umbrella woken by the same file is not: its
    // wake is file-grain and a file ack clears it, so counting it here denied it
    // that ack twice over — the per-doc hint was withheld, and the generic route
    // below was suppressed as "nothing an ack can settle".
    const contestedFor = (file: string, feature: string): boolean =>
      report.state.ownershipLints.some(
        (l) => l.file === file && l.changeKind === "changed" && l.features.includes(feature),
      );
    const ownershipOnly = report.state.staleDocs.filter(
      (d) =>
        d.changedSources.length > 0 && d.changedSources.every((f) => contestedFor(f, d.feature)),
    );
    const contested = new Set(ownershipOnly.flatMap((d) => d.changedSources));
    if (ownershipOnly.length > 0) {
      console.log(
        pc.red(
          // Both shapes are named because they take OPPOSITE fixes — one adds a
          // claim to `owned_symbols`, the other removes one — and a summary that
          // asserts the unclaimed half sends every doubly-claimed reader the wrong
          // way. The line carries the ratio, which is the finding; the exact edit
          // is per-file and stays where it is correct, beside its stale doc.
          `    ${ownershipOnly.length} of those doc(s) ${ownershipOnly.length === 1 ? "was" : "were"} woken by ${contested.size === 1 ? "a shared file" : `${contested.size} shared files`} whose per-symbol ownership does not resolve — no feature claims it, or two do — and that wake repeats on every edit until the registry says who owns it, and no ack clears it (fix printed with the stale doc above).`,
        ),
      );
    }
    // Only the routes that can actually clear what fired. At the moment of most
    // pressure, a command that cannot resolve the finding it sits under is worse
    // than no guidance at all — it is a plausible thing to try that leaves the gate
    // exactly as red. A registry pointer is the sharp case: no acknowledgment
    // clears it, and offering one here sent the reader to a refusal.
    const routes: string[] = [];
    if (report.state.unmapped.length > 0)
      routes.push(
        `    Materialize unmapped sources: \`${renderRoute(routesFor("unmapped-source")[0])}\`.`,
      );
    if (report.state.registryPointers.length > 0)
      routes.push(
        `    Fix each registry pointer — re-point the entry to the new path, or drop it. ${capitalize(whyNoAck("registry-pointer") ?? "")}.`,
      );
    if (report.state.docPointers.length > 0)
      routes.push(
        `    Fix each doc pointer — name the new path, or drop the mention. ${capitalize(whyNoAck("doc-pointer") ?? "")}.`,
      );
    // Deliberately a pointer, not the command. The edit differs by shape — claim an
    // unclaimed symbol, drop a duplicate claim, or demote the file — and a summary
    // that restates one of them is a route that is wrong for the others. It is also
    // how this line came to print the exact opposite of the fix it sat above.
    if (ownershipOnly.length > 0)
      routes.push(
        "    Settle the shared file's per-symbol ownership in `docs/.registry.json` — a registry edit, not a doc edit; the exact one is printed with each stale doc above.",
      );
    // Offered only while some stale doc can actually be settled that way. There are
    // two ways a stale doc cannot be: every source that woke it is a shared file whose
    // ownership does not resolve (above), or this feature owns a signature move, which
    // ADR 006 gives no ack at any grain — one unresolved one keeps the doc stale
    // however many other moves are acked, so it is asked about the feature, not the
    // file. Naming the ack route over either is the dead end this line exists to stop
    // printing, and the signature half went on printing it after plan 36 fixed the
    // ownership half.
    // A deletion is the third way a stale doc cannot be settled by an ack, and it
    // reached this list last: `ack` has always refused one by name, so the route was
    // dead on arrival in the finding above AND in this epilogue. Asked of the doc,
    // like the signature case — one unackable source keeps the doc stale however many
    // others could be acked.
    const gone = deletedInChange(report.state);
    const movedContract = (d: { feature: string }): boolean =>
      report.drift.some((m) => m.feature === d.feature && !m.acknowledged && m.signatureChanged);
    // ANY removed source, not every: one waker no signature can reach keeps the doc
    // stale however many others could be acked — the same shape the signature case
    // already had, and the reason `every` was wrong is that it let a doc that had
    // merely LOST a file among others go on advertising the ack route.
    const anyRemoved = (d: { changedSources: string[] }): boolean =>
      d.changedSources.some((f) => gone.has(f));
    const unackable = report.state.staleDocs.filter(
      (d) =>
        movedContract(d) ||
        (d.changedSources.length > 0 &&
          d.changedSources.every((f) => contestedFor(f, d.feature))) ||
        anyRemoved(d),
    );
    // Withholding the dead route must not take the live one with it. These two share a
    // line, and a signature move keeps the doc-update half while losing the ack half —
    // dropping the whole sentence would leave the reader with no route at all, which is
    // the same failure this rule is about, arrived at from the other side. An
    // ownership-contested doc keeps neither (a doc edit there is the mirror prose), and
    // its registry route is already printed above.
    const ackable = report.state.staleDocs.length - unackable.length;
    // Withholding the ack route says nothing about WHY, and the reason is the part a
    // reader acts on — so the sentence that replaces it names the actual condition.
    // Inheriting the signature wording for a deletion would have swapped one false
    // statement for another: the reader is told a contract moved when a file was
    // removed. Both are named where both fired, rather than one standing in for the
    // other.
    const others = unackable.filter((d) => !ownershipOnly.includes(d));
    // Each clause is the catalog's own reason for its condition, so the summary
    // and the per-finding route beside it cannot come to say different things
    // about the same wake.
    const why = [
      others.some(anyRemoved) ? whyNoAck("owned-file-deleted") : null,
      others.some(movedContract) ? `a signature moved, and ${whyNoAck("signature-move")}` : null,
    ].filter((s): s is string => s !== null);
    if (ackable > 0)
      routes.push(
        "    Resolve each stale doc: update it at intent altitude, or acknowledge a change that owes no doc line (`codument ack <path>` / `codument ack <path>::<symbol>`).",
      );
    else if (why.length > 0)
      routes.push(
        `    Resolve each stale doc by updating it at intent altitude: ${why.join("; ")}.`,
      );
    for (const line of routes) console.log(pc.dim(line));
    console.log(pc.dim("    Then re-run."));
    process.exitCode = 1;
  }

  if (reviewGate) {
    printReviewGate(reviewGate, confirmUnavailable, unreviewedCount);
    if (reviewGateFail) process.exitCode = 1;
  }

  // The verdict is the LAST line of stdout, always. Readers grep piped output
  // instead of trusting the exit code — a habit the field report calls fragile and
  // is right about, since `$?` after a pipe is the last command's status, not the
  // gate's. The exit code stays the contract; this just makes `| tail -1` tell the
  // truth too, so the fragile habit stops producing false greens. It is terse on
  // purpose: everything it names has already been said above at length.
  const gateable: string[] = [];
  if (report.state.unmapped.length > 0) gateable.push(`${report.state.unmapped.length} unmapped`);
  if (report.state.staleDocs.length > 0)
    gateable.push(`${report.state.staleDocs.length} stale doc(s)`);
  if (report.state.registryPointers.length > 0)
    gateable.push(`${report.state.registryPointers.length} registry pointer(s)`);
  if (report.state.docPointers.length > 0)
    gateable.push(`${report.state.docPointers.length} doc pointer(s)`);
  // Everything else that changes what the reader does next. Plan 39 put the verdict
  // last because readers pipe; the field then showed the other half of that habit —
  // `| tail -1` delivers this line and destroys the rest, so anything reachable ONLY
  // above it is, in practice, unreachable. It cost two false entries in an
  // adversarial field report: the inherited registry rot `review` does name was
  // written up as missing across fourteen runs, and a scaffold two minor versions
  // behind printed on every invocation for five hours unseen. Neither gates — that
  // is settled and unchanged — but a fact worth printing at all is worth printing
  // where the reader is looking.
  const alsoTrue: string[] = [];
  if (report.registryRot.length > 0)
    alsoTrue.push(
      `${report.registryRot.length} registry path(s) missing (not this change; ungated)`,
    );
  if (versionSkewNotice(root)) alsoTrue.push("scaffold behind the installed version");
  // Body-only movement is reported and never gated (ADR 020). It rides the verdict
  // line because it changes what the reader does next — it is the one thing they
  // may still want to open a doc about — and because a demotion nobody can see is
  // indistinguishable from a gate that stopped noticing.
  const bodyOnly = report.reportedNotGated;
  if (bodyOnly > 0) {
    alsoTrue.push(`${bodyOnly} body-only move(s) reported, not gated`);
  }
  // The same rule one grain up: an owned file no adapter reads, changed, with no
  // owner declaring a risk. This is the sharper of the two demotions to disclose —
  // the tool read nothing at all here, so a reader who never sees the line has no
  // way to know a claimed file moved unexamined.
  const unreadOwned = report.state.ungatedRegistered.filter((u) => u.kind === "unread").length;
  if (unreadOwned > 0) {
    alsoTrue.push(`${unreadOwned} owned file(s) no adapter reads — reported, not gated`);
  }
  // A review that passed without reproducing anything is the sharpest case this line
  // exists for: the gate exits 0, so nothing else can carry it, and the honest
  // condition printed above the verdict is precisely what a `| tail -1` destroys.
  if (reviewGate?.passed && reviewGate.unjudged > 0) {
    alsoTrue.push(`${reviewGate.unjudged} review finding(s) unadjudicated`);
  }
  const also = alsoTrue.length > 0 ? pc.dim(` · ${alsoTrue.join(" · ")}`) : "";

  const blocking = strictFail ? [...gateable] : [];
  if (reviewGateFail) blocking.push("adversarial review not covering this diff");
  if (blocking.length > 0) {
    console.log(pc.red(`codument review: BLOCKED — ${blocking.join(", ")}`) + also);
  } else if (gateable.length > 0) {
    // Ungated, but NOT clean. Without `--strict` this run is a report and exits 0
    // by design, so the exit code cannot carry the difference — which is exactly why
    // the word had to. `clean` printed under a screen of stale docs is the false
    // green this line exists to kill, and the bare form is the one the review skill
    // tells an agent to run; a reader who trusts `| tail -1` there gets the same lie
    // by a shorter route. Name what was found, and say plainly that nothing gated it.
    console.log(
      pc.yellow(`codument review: ${gateable.join(", ")} — not gated (add \`--strict\` to gate)`) +
        also,
    );
  } else {
    // `clean` still names the GATE's result and nothing more, which is what it has
    // always meant; the advisories ride the same line rather than replacing the word,
    // so a reader who greps for it still finds it and a reader who reads the line
    // learns what else is true. A run with genuinely nothing to report prints the
    // bare word, exactly as before.
    console.log(pc.green("codument review: clean") + also);
  }
}

// The full real-change set the adversarial-review gate scopes to: changed sources +
// config/data + real deletions, with docs and excluded paths dropped. Shared by the
// `--require-review` gate and the `--record` writer so both fingerprint — and so
// reason about proportionality over — the identical set.
function computeRealChange(
  report: ReviewReport,
  deletions: string[],
  exclusion: ExclusionSpec,
): { set: string[]; realDeletions: string[] } {
  const isDocPath = (p: string) => p.startsWith("docs/") && p.endsWith(".md");
  const realDeletions = deletions.filter((d) => !isDocPath(d) && !isExcluded(d, exclusion));
  const set = [
    ...new Set([...report.state.changedSources, ...report.state.otherChanged, ...realDeletions]),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { set, realDeletions };
}

// Render the adversarial-review gate result. Advisory findings are surfaced even
// when the gate passes — a judgment-call finding must never be silently swallowed.
function printReviewGate(
  gate: ReviewGateResult,
  confirmUnavailable: string | null = null,
  unreviewedCount: number | null = null,
): void {
  console.log();
  if (!gate.required) {
    console.log(pc.dim("  Adversarial review: trivial diff — none required."));
    return;
  }
  if (confirmUnavailable) {
    // Impossible to miss, right where the gate verdict lands: findings with
    // named tests will read advisory not because they were adjudicated but
    // because nothing could run them.
    console.log(pc.yellow(`  ⚠ ${confirmUnavailable}`));
  }
  if (gate.passed) {
    const advisory =
      gate.advisoryFindings.length > 0 ? pc.dim(` (${gate.advisoryFindings.length} advisory)`) : "";
    if (gate.unjudged > 0) {
      // "Covers this diff" is a claim about ADJUDICATION, and the reader hears it as
      // one. Where nothing was reproduced it is a claim about a ritual instead — the
      // artifact exists, its fingerprint matches, and not one thing in it was checked.
      // In the field that read as a green gate over five delivery steps of unrun
      // findings, and the twelve real bugs fixed that session were fixed because the
      // author fixed them, not because anything held. The condition above says why;
      // this says what, in the words the reader was going to quote.
      const total = gate.unjudged + gate.adjudicated;
      console.log(
        `  ${pc.yellow("✓")} Adversarial review is on record for this diff — ` +
          pc.yellow(
            `${gate.unjudged} of ${total} reproducible finding(s) unadjudicated (their tests could not be run)`,
          ) +
          advisory,
      );
    } else {
      console.log(`  ${pc.green("✓")} Adversarial review covers this diff` + advisory);
    }
  } else {
    console.log(pc.red(`  ✗ --require-review: ${gate.reason}.`));
    if (!gate.covered) {
      // Name the size of the re-attack. After fixing one finding the honest ask is
      // "attack the file you just changed", not "attack the diff again" — and
      // `--bundle` now scopes itself to exactly that.
      console.log(
        pc.dim(
          unreviewedCount !== null
            ? `    ${unreviewedCount} file${unreviewedCount === 1 ? "" : "s"} moved since your last recorded review. \`codument review --bundle\` scopes the re-attack to just those (\`--full\` forces the whole diff); record it under .codument/reviews/, then re-run.`
            : "    Run a fresh adversarial review of this diff and record it under .codument/reviews/, then re-run.",
        ),
      );
    } else {
      for (const f of gate.blockingFindings) {
        console.log(
          `    ${pc.red("•")} ${f.citation} — ${f.detail}` +
            (f.failingTest ? pc.dim(` (test: ${f.failingTest})`) : ""),
        );
      }
    }
  }
  if (gate.advisoryFindings.length > 0) {
    console.log(pc.dim("    Advisory (judgment calls — your decision, non-blocking):"));
    for (const f of gate.advisoryFindings) {
      console.log(`      ${pc.dim("•")} ${f.citation} — ${f.detail}`);
    }
  }
}

function section(title: string, lines: string[]): void {
  if (lines.length === 0) return;
  console.log(`  ${pc.bold(title)}`);
  for (const line of lines) console.log(`    ${line}`);
  console.log();
}

// The dependents section, as a count plus a ranked, capped list. It used to print one
// line per declared EDGE: on a repo with a couple of concept umbrellas a single-file
// edit printed dozens of unranked lines, which trains the reader to skip the section
// — and this is a section a real warning can appear in. Features depending on a
// changed FEATURE come first; ones that only ride a concept umbrella (which wakes on
// any file in the directory it narrates) are the weakest signal and collapse first.
export function dependentLines(summary: DependentSummary[]): string[] {
  if (summary.length === 0) return [];
  const viaUmbrella = summary.filter((d) => d.viaUmbrella).length;
  const lines = [
    pc.dim(
      `${summary.length} dependent feature${summary.length === 1 ? "" : "s"}` +
        (viaUmbrella > 0 ? ` (${viaUmbrella} only via a concept umbrella)` : ""),
    ),
  ];
  for (const d of summary.slice(0, DEPENDENT_CAP)) {
    lines.push(`${pc.dim("•")} ${d.feature} (depends on ${d.dependsOn.join(", ")})`);
  }
  if (summary.length > DEPENDENT_CAP) {
    lines.push(pc.dim(`… and ${summary.length - DEPENDENT_CAP} more`));
  }
  return lines;
}

/** "a", "a and b", "a, b and c" — these lines are read under pressure, and a
 *  possessive plural spliced onto a comma list ("checkout, product' ...") reads as
 *  a typo, which is one more reason to skip the block. */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The resolution for a shared-file wake, rendered INSIDE the stale-doc entry the
 * wake produced rather than as an advisory section of its own.
 *
 * The wake itself is ADR 004 working: a symbol on a file several features claim,
 * that none of them claims per-symbol, wakes every candidate rather than guessing.
 * What was missing is that nothing said so where the reader was looking, and
 * nothing named the two edits that end it — so the field session met this 25 times,
 * read it as decoration, and paid instead with prose written into five docs, which
 * is the mirror-edit failure the whole ack protocol exists to prevent.
 *
 * Both fixes are registry edits, because who owns a symbol is a decision the
 * registry exists to record. The tool routes; it never picks.
 */
function ownershipResolution(
  file: string,
  lints: OwnershipLint[],
  feature: string,
  /** False for the second and later stale docs the same file woke: the fix is ONE
   *  registry edit, so repeating it per woken doc is the same volume that taught
   *  the field reader to skip the block in the first place. */
  full: boolean,
  /** True when every lint here is an added or removed anchor, which a file-grain
   *  ack DOES skip — so the ack clears this wake, and the block prints that very
   *  command three lines above. The denial below is true only of a `changed`
   *  anchor; stated unconditionally it pushed the reader off a working one-line
   *  ack and onto a registry edit that drops a co-owner's real ownership. */
  ackClears: boolean,
): string {
  const descriptors = [...new Set(lints.map((l) => l.descriptor))].sort();
  const candidates = [...new Set(lints.flatMap((l) => l.features))].sort();
  const others = candidates.filter((c) => c !== feature);
  const ambiguous = lints.some((l) => l.kind === "ambiguous");
  const list = descriptors.map((d) => JSON.stringify(d)).join(", ");
  const indent = "\n        ";
  if (!full) {
    return `${indent}${pc.dim(`↑ woken by the same unclaimed shared file (${file}) — one registry edit clears all of these`)}`;
  }

  const head =
    `${indent}${pc.yellow("⚠")} ${pc.bold(
      ambiguous
        ? "shared symbol claimed by more than one feature"
        : "shared symbol no feature claims",
    )} ${pc.dim(`— ${file} :: ${descriptors.join(", ")} · across ${candidates.join(", ")}`)}` +
    `${indent}  ${pc.dim("this recurs on EVERY edit to the file until the registry says who owns it")}`;

  // What an ack can and cannot do here, said once for both shapes. The recurrence
  // is the point either way: the ack settles THIS wake, the registry edit is what
  // stops the next edit re-firing it.
  const close = ackClears
    ? "the ack above clears this one; only the registry edit stops it returning on the next edit"
    : ambiguous
      ? "no ack clears this — an ack needs one resolved owner, and there are two"
      : "no ack — symbol or file — clears this; prose in the other candidates' docs buys green and spends the standard";

  if (ambiguous) {
    return (
      `${head}${indent}  ${pc.dim("fix →")} remove ${pc.cyan(list)} from ${pc.cyan(
        "owned_symbols",
      )} in all but one of ${andList(candidates)}` + `${indent}  ${pc.dim(close)}`
    );
  }

  const claim = `${indent}  ${pc.dim("claim it  →")} add under ONE of them in docs/.registry.json: ${pc.cyan(
    `"owned_symbols": { ${JSON.stringify(file)}: [${list}] }`,
  )}`;
  const demote = `${indent}  ${pc.dim("demote it →")} keep ${file} in one feature's ${pc.cyan(
    "primary_sources",
  )}, move it to the ${pc.cyan("related_sources")} of ${
    others.length > 0 ? andList(others) : "the other candidates"
  } ${pc.dim("— impact, never a wake")}`;
  // A file whose only moved anchors are the whole-module ones has nothing to split:
  // claiming that single anchor IS file ownership under another name, so the
  // demotion is the honest lead. This is the shape ADR 014 gives every modern
  // config and default-exported component — which is why the field run met it on
  // every contested file.
  const wholeFileOnly = descriptors.every(
    (d) => d === "default." || d === MODULE_ANCHOR_NAME || d === `${MODULE_ANCHOR_NAME}.`,
  );
  const fixes = wholeFileOnly ? demote + claim : claim + demote;
  return `${head}${fixes}${indent}  ${pc.dim(close)}`;
}

function printHuman(report: ReviewReport): void {
  const { state, plan } = report;

  console.log(pc.bold("codument review"));
  console.log();

  if (report.workspace) {
    // A workspace verdict is over several repositories; name them and their base
    // heads so the run is reproducible from the tuple, the way a plain repo's is
    // from one sha.
    console.log(
      pc.cyan(
        `  workspace: ${report.workspace.members.length} member repositories (${report.workspace.members.join(", ")}) — git scope aggregated`,
      ),
    );
    for (const { prefix, sha } of report.workspace.bases) {
      const short = sha.length >= 7 ? sha.slice(0, 12) : sha;
      console.log(pc.dim(`    base ${prefix || "<root>"}: ${short}`));
    }
    console.log();
  }

  if (report.changedFileCount === 0) {
    console.log(`  ${pc.green("✓")} Working tree clean — nothing to review.`);
    return;
  }

  // Governed registered files ride inside `otherChanged` (they are not a recognized
  // source), so counting them there too would double-count and — worse — leave the
  // headline saying "other" about files that now gate. Name them, and report the
  // remainder as other. The machine field is untouched.
  const governedCount = state.governedRegistered.length;
  const otherCount = state.otherChanged.length - governedCount;
  console.log(
    `  ${report.changedFileCount} changed file(s): ${state.changedSources.length} source, ${state.changedDocs.length} docs` +
      (governedCount > 0 ? `, ${governedCount} governed` : "") +
      (otherCount > 0 ? `, ${otherCount} other` : "") +
      // The remainder that used to be silent. Every other bucket filters the
      // exclusion spec out while the total counts it, so the most ordinary change a
      // step makes — editing a test — printed a line that did not add up, and a
      // count a reader cannot reconcile is a count they stop reading.
      (state.excludedChanged.length > 0 ? `, ${state.excludedChanged.length} excluded` : "") +
      (report.deletions.length > 0 ? `, ${report.deletions.length} deleted` : "") +
      (plan ? pc.dim(`  (plan: ${plan.plan})`) : ""),
  );
  if (plan && plan.contenders.length > 1) {
    // Multiple approved plans is a workflow smell (flip exactly one at a time);
    // never let first-by-filename win silently.
    console.log(
      pc.yellow(
        `  ⚠ ${plan.contenders.length} approved plans (${plan.contenders.join(", ")}) — scope taken from ${plan.plan}; keep exactly one approved`,
      ),
    );
  }
  console.log();

  section(
    "Changed by feature",
    state.byFeature.map((g) => `${pc.cyan(g.feature)} — ${g.files.join(", ")}`),
  );

  // The registry pointing at a file that no longer exists. Printed BEFORE the doc
  // sections because it is a fact about the control plane rather than about prose:
  // leave it and every later ownership answer is derived from a lie. A rename is
  // the case that used to be invisible, so it names the destination inline — the
  // fix is a replacement, not a deletion.
  section(
    pc.yellow("Registry names a path this change removed (re-point it, or drop it)"),
    state.registryPointers.map((p) => {
      const where = `${p.features.join(", ")}`;
      return p.kind === "renamed"
        ? `${pc.yellow("⚠")} ${p.file} ${pc.dim("→ renamed to")} ${p.renamedTo} ${pc.dim(`· still named by ${where}`)}\n        ${pc.dim("fix →")} replace it with ${pc.cyan(p.renamedTo ?? "")} in ${where}${pc.dim(", or `codument map materialize` the new path and drop the old")}`
        : `${pc.yellow("⚠")} ${p.file} ${pc.dim("→ deleted")} ${pc.dim(`· still named by ${where}`)}\n        ${pc.dim("fix →")} remove it from ${where}${pc.dim(" (a doc update for the removal is owed separately)")}`;
    }),
  );

  // The prose pointer beside the registry pointer, and printed with it for the same
  // reason: a doc naming a file that is gone sends its next reader nowhere, and the
  // registry's pointer was always checked while the sentence beside it never was. The
  // fix is the doc's own — name the new path or drop the mention — so the line points
  // at the doc rather than offering a command, and no acknowledgment is offered
  // because nothing here is a judgment call.
  section(
    pc.yellow("A doc names a path this change removed (re-point it, or drop the mention)"),
    state.docPointers.map(
      (p) =>
        `${pc.yellow("⚠")} ${p.doc} ${pc.dim(`· names ${p.paths.join(", ")}`)}\n        ${pc.dim("fix →")} name the path it moved to, or remove the mention${pc.dim(" — a doc that only records the removal still points nowhere")}`,
    ),
  );

  // Rot the change did not cause, said out loud by the surface that runs every step.
  // `doctor` has always known this; `review --strict` never mentioned it, so a
  // registry naming a file nobody has seen in months stayed invisible to the one
  // command the loop actually runs — and every ownership answer, context pack and
  // adversary grounding is derived from that registry. Advisory by design: failing a
  // gate over state this change did not create is how a gate gets bypassed.
  if (report.registryRot.length > 0) {
    const shown = report.registryRot.slice(0, DEPENDENT_CAP);
    console.log(
      pc.dim(
        `  Registry names ${report.registryRot.length} path(s) that do not exist (not this change; the gate does not fail on it)`,
      ),
    );
    for (const r of shown) {
      console.log(pc.dim(`    • ${r.file} — named by ${r.features.join(", ")}`));
    }
    if (report.registryRot.length > shown.length) {
      console.log(pc.dim(`    • +${report.registryRot.length - shown.length} more`));
    }
    console.log(
      pc.dim(
        "    fix → re-point or remove each in docs/.registry.json (`codument doctor` lists them all)",
      ),
    );
    console.log();
  }

  section(
    pc.yellow("Deleted sources (a removal owes its doc attention — update it or remove it too)"),
    [...state.deletedSources, ...state.governedDeleted]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((f) => `${pc.yellow("⚠")} ${f}`),
  );

  // A stale doc whose changed source was gated at FILE grain (a coarse file:
  // .js, generated, re-export-only) produces no Symbol-drift entry, so without
  // this signpost the only visible resolution is a doc edit — the exact pressure
  // that breeds token mirror edits. Print both honest routes here, symmetric
  // with the Symbol drift block. A precisely-evaluated file resolves per symbol
  // below and gets no line; an unevaluable file is excluded because `ack`
  // refuses it (fix the parse instead).
  // "Would a file-grain ack clear this?" is a question about the DOC, and it used to
  // be asked about the file: any file carrying resolved drift was excluded from the
  // route under every doc it woke. That is wrong in both directions, and the field hit
  // both. A concept umbrella is never a per-symbol owner, so a file ack does clear ITS
  // wake even while a sibling feature owns the symbols that moved — and the global test
  // left the umbrella's stale doc with no resolution at all. The other direction is the
  // reported one: the route printed under a doc whose own symbol had moved, and the ack
  // the reader pasted came back "NOT cleared by a file ack". An acknowledged move no
  // longer drives the wake, so it does not withhold the route either.
  const ownsUnresolvedMove = (f: string, feature: string): boolean =>
    report.drift.some(
      (d) => d.feature === feature && !d.acknowledged && d.anchorId.split("::")[0] === f,
    );
  const unevaluableFiles = new Set(state.unevaluable);
  // Ownership lints, indexed by the file that carries them. The resolution used to
  // print as its own ⚠ section BELOW the blocking line, among genuinely advisory
  // blocks — where it fired 25 times in one field run and was read as decoration
  // every time. Position was the whole defect, so the fix is structural: the
  // resolution belongs inside the finding it resolves.
  const lintsByFile = new Map<string, OwnershipLint[]>();
  for (const l of state.ownershipLints) {
    const list = lintsByFile.get(l.file) ?? [];
    list.push(l);
    lintsByFile.set(l.file, list);
  }
  // The lints that concern a GIVEN doc: the ones naming its feature as a candidate
  // owner. A contested file does not wake one kind of doc — a concept umbrella
  // wakes at file grain and never consults `owned_symbols` (per-symbol ownership is
  // a feature concept; `resolveOwner` skips concept entries entirely). So the
  // per-symbol resolution is not the umbrella's fix, and the file ack that DOES
  // clear it must not be withheld from it on another doc's account.
  const lintsFor = (f: string, feature: string): OwnershipLint[] =>
    (lintsByFile.get(f) ?? []).filter((l) => l.features.includes(feature));
  // A file-grain ack skips added/removed anchors but never a `changed` one, so it
  // cannot clear a wake an unassigned CHANGED symbol is driving. Such a file looks
  // coarse from here (no drift entry — drift only carries resolved owners), which
  // is how the generic hint came to recommend the one command guaranteed not to
  // work: in the field the agent followed it and banked two inert acks.
  const ackBlocked = (f: string, feature: string): boolean =>
    lintsFor(f, feature).some((l) => l.changeKind === "changed");
  const resolutionShown = new Set<string>();
  section(
    pc.yellow("Stale docs (source changed, mapped doc did not)"),
    state.staleDocs.map((d) => {
      // A governed tree is named as the tree, with what moved inside it as a count.
      // Listing 120 locale paths is the same failure as listing none: a section that
      // always prints 120 lines is one readers learn to skip, and the file names were
      // never the information — the tree is.
      const claimed = new Set(
        d.viaPatterns.flatMap((p) => {
          const re = sourceMatcher(p.pattern);
          return d.changedSources.filter((f) => re.test(f));
        }),
      );
      const named = [
        ...d.changedSources.filter((f) => !claimed.has(f)),
        ...d.viaPatterns.map((p) => `${p.pattern} (${p.count} file${p.count === 1 ? "" : "s"})`),
      ];
      let line = `${pc.yellow("⚠")} ${d.feature}: ${d.doc} (changed: ${named.join(", ")})`;
      // The grain, stated once, before the routes it explains. Registration widens the
      // gate's scope and never its judgment, so a file no adapter reads is governed
      // whole and correctly — but nothing said so, and the reader was left inferring
      // the downgrade from which route was missing. An inference from what is NOT
      // printed is the same silence as a fact reachable only above the verdict. Said
      // once per entry rather than per route: one file has one grain however many
      // commands it earns.
      if (d.coarseSources.length > 0) {
        const exts = [...new Set(d.coarseSources.map(extensionOf))].sort();
        const what =
          d.coarseSources.length === 1
            ? d.coarseSources[0]
            : `${d.coarseSources.length} of these files`;
        line += `\n        ${pc.dim(`gated at file grain — no adapter reads ${exts.join("/")}, so the gate sees ${what} change and never what changed inside`)}`;
      }
      // A deletion is judged of the DOC, not of the file. No ack clears a removal,
      // so once this change took a source away nothing the reader can sign settles
      // the doc it woke — and printing a working per-file ack beside it is still a
      // dead route, because clearing one waker leaves the finding standing. Asked
      // per file it offered exactly that: an ack that records truthfully, is
      // accepted, and leaves the gate red on the same line it sat under.
      const removed = deletedInChange(state);
      const lostASource = d.changedSources.some((f) => removed.has(f));
      const coarse = lostASource
        ? []
        : d.changedSources.filter(
            (f) =>
              !ownsUnresolvedMove(f, d.feature) &&
              !unevaluableFiles.has(f) &&
              !ackBlocked(f, d.feature),
          );
      // A tree answers in one line or the route is not worth printing. Where every
      // file a pattern woke is ackable, the pattern IS the command — 120 file routes
      // for one translation drop is the same unreadable surface as the 120 paths in
      // the change list, one line further down. A pattern with any member that a file
      // ack could not clear falls back to its files, so the collapse never hides a
      // symbol-drift or ownership resolution behind a tree. A tree whose files were
      // all ADDED still prints here and `ack` refuses it by name — the doc-update
      // route above it is the right one for a new language pack, and one refusal that
      // says so beats a hundred.
      const collapsed = new Map<string, string[]>();
      for (const p of d.viaPatterns) {
        const re = sourceMatcher(p.pattern);
        const matched = d.changedSources.filter((f) => re.test(f));
        const ackable = matched.filter((f) => coarse.includes(f));
        if (matched.length > 1 && ackable.length === matched.length) {
          collapsed.set(p.pattern, matched);
        }
      }
      const collapsedFiles = new Set([...collapsed.values()].flat());
      const perFile = coarse.filter((f) => !collapsedFiles.has(f));
      if (coarse.length > 0) {
        // One doc-update route heads the block, then one ack route per grain the
        // wake actually offers — the tree where a pattern answers for all its
        // files, the file otherwise. Both come from the catalog, so the command
        // printed here is the command `ack` will accept.
        const [docRoute] = routesFor("stale-doc-file", { doc: d.doc });
        line += `\n        ${routeLine(docRoute, 13)}`;
        for (const [pattern, matched] of collapsed) {
          const [, treeAck] = routesFor("stale-doc-tree", {
            doc: d.doc,
            pattern,
            matched: matched.length,
          });
          line += `\n        ${routeLine(treeAck, 13)}`;
        }
        for (const f of perFile) {
          const [, fileAckRoute] = routesFor("stale-doc-file", { doc: d.doc, file: f });
          line += `\n        ${routeLine(fileAckRoute, 13)}`;
        }
      }
      for (const f of d.changedSources) {
        const lints = lintsFor(f, d.feature);
        if (lints.length === 0) continue;
        line += ownershipResolution(
          f,
          lints,
          d.feature,
          !resolutionShown.has(f),
          !ackBlocked(f, d.feature),
        );
        resolutionShown.add(f);
      }
      return line;
    }),
  );

  section(
    pc.yellow("Could not evaluate (parse error — gated whole-file, fix to restore per-symbol)"),
    state.unevaluable.map((f) => `${pc.yellow("⚠")} ${f}`),
  );

  // The ungoverned residue, split because the two halves need different words. An
  // impact-only registration is working as designed — nothing to fix, just verify by
  // hand. An EXCLUDED one is two declarations contradicting each other, and printing
  // "verify by hand" there hides that one of them should go.
  const excludedRegistered = state.ungatedRegistered.filter((u) => u.kind === "excluded");
  const impactOnly = state.ungatedRegistered.filter((u) => u.kind === "impact-only");
  const unread = state.ungatedRegistered.filter((u) => u.kind === "unread");
  const ownersOf = (u: UngatedRegisteredChange) =>
    pc.dim(`→ ${u.owners.map((o) => o.doc).join(", ")}`);
  section(
    // Both remediations are named because either rule may have fired, and only one
    // of them is narrowable: a project's own `exclude` can be narrowed, a built-in
    // rule cannot — offering only the latter would be the dead end the excluded-source
    // refusal and the generated-leakage lint both split their wording to avoid.
    pc.yellow(
      "Registered but excluded (the spec drops it, so the registration governs nothing — un-map it, or narrow your own `exclude` if you declared it)",
    ),
    excludedRegistered.map((u) => `${pc.yellow("⚠")} ${u.file} ${ownersOf(u)}`),
  );
  section(
    pc.dim("Registered as impact only (no adapter judges these — verify their docs by hand)"),
    impactOnly.map((u) => `${pc.dim("•")} ${u.file} ${ownersOf(u)}`),
  );
  // Owned, changed, and unreadable: reported rather than gated, with the line that
  // reverses it printed per file. A downgrade nobody is told about is the quiet green
  // ADR 017 was written against — what changed is which artifact the block could
  // honestly demand, not whether the reader gets to know.
  section(
    pc.dim(
      "Owned but unread (no adapter reads these; reported, not gated — declare a risk on the owner to gate them)",
    ),
    unread.flatMap((u) => [
      `${pc.dim("•")} ${u.file} ${ownersOf(u)}`,
      // The same route `doctor` prints over the whole registry, from the same
      // record — these two were written by hand in two files on the same day,
      // which is how far apart a pair starts before it drifts.
      ...routesFor("blind-unread-file", {
        file: u.file,
        feature: u.owners.map((o) => o.feature).join(" or "),
      }).map((r) => `      ${routeLine(r, 7)}`),
    ]),
  );

  // Per-symbol drift: owned symbols that moved. The deterministic verdict above is
  // the gate; this names each still-flagged symbol and BOTH ways to resolve it
  // inline — update the doc when a contract changed, or `codument ack` when it did
  // not. The surface MIRRORS the verdict (ADR 010): a symbol is still flagged iff
  // its feature is actually stale (owned source moved, owning doc not edited, not
  // acked). Co-movement is info-only telemetry (the soak signal in `watch`), never
  // the resolved/flagged decision here — so a correct intent-altitude doc update
  // resolves a finding, and a symbol-mirror doc earns no credit.
  const staleFeatures = new Set(report.state.staleDocs.map((s) => s.feature));
  // `d.gates` is required, not implied by staleness: a feature stale for some
  // other reason would otherwise drag its body-only moves back into a block
  // headed "resolve each", asking for a resolution ADR 020 stopped requiring.
  const unresolved = report.drift.filter(
    (d) => d.gates && !d.acknowledged && staleFeatures.has(d.feature),
  );
  if (unresolved.length > 0) {
    console.log(
      `  ${pc.bold("Symbol drift")} ${pc.dim("— resolve each: update the doc, or ack a contract-neutral move")}`,
    );
    // A file whose ONLY moved anchor is the whole-module one — the shape ADR 014
    // gives every default-exported component and modern config file — was printing
    // its file path in the change list and then a `default (changed)` line that
    // added nothing: the symbol name IS the file. Name the file here instead, and
    // spend the line saying the thing that was never visible — whether the move was
    // body or contract. The anchor's precision is load-bearing (token invariance,
    // the signature split, the ack route); only the restatement goes.
    const perFile = new Map<string, number>();
    for (const d of report.drift) {
      const f = d.anchorId.split("::")[0];
      perFile.set(f, (perFile.get(f) ?? 0) + 1);
    }
    const isWholeModule = (d: DriftFinding): boolean =>
      (d.symbol === "default" || d.symbol === MODULE_ANCHOR_NAME) &&
      perFile.get(d.anchorId.split("::")[0]) === 1;
    for (const d of unresolved) {
      const sigTag = d.signatureChanged ? ` ${pc.yellow("[signature changed]")}` : "";
      const subject = isWholeModule(d) ? d.anchorId.split("::")[0] : d.symbol;
      // A moved whole-module anchor that reaches this block moved its CONTRACT, by
      // construction: the shape always carries a signature, and ADR 020 keeps a move
      // whose signature held out of the verdict entirely. The label used to fork on
      // body-vs-contract because both could land here; only one can now, and a "body"
      // arm nothing reaches would read as a state the tool can still put you in.
      const what = isWholeModule(d)
        ? `(${d.kind === "changed" ? "contract changed" : d.kind}) in ${d.feature}`
        : `(${d.kind}) in ${d.feature}`;
      console.log(`    ${pc.dim("•")} ${pc.bold(subject)} ${pc.dim(what)}${sigTag}`);
      // Which condition this move IS decides everything printed under it, and the
      // catalog decides what each condition offers. The three arms used to write
      // their own sentences here, which is how the signature arm went on
      // advertising an ack after the ownership arm beside it had learned better.
      const file = d.anchorId.split("::")[0];
      const condition: ConditionId = d.signatureChanged
        ? "signature-move"
        : d.kind === "changed"
          ? "symbol-internal-move"
          : "symbol-added-removed";
      for (const route of routesFor(condition, {
        file,
        doc: d.doc,
        feature: d.feature,
        anchorId: d.anchorId,
        // Only the signature arm reads this, and it is what withholds the
        // demotion route from a sole owner — demoting one would leave the file
        // unowned, trading a wake for a worse one.
        claimants: state.byFeature.filter((g) => g.files.includes(file)).length,
      })) {
        console.log(`        ${routeLine(route, 16)}`);
      }
    }
    console.log();
  }

  // First-class drift-resolution summary: an all-ack change is loud here, not a
  // quiet green — over-acking is visible at the moment of the change, not only in
  // the aggregate soak telemetry. A file-grain ack shows AS a (file) ack, never
  // laundered as a doc update. "resolved by doc update" is verdict-derived (the
  // owning doc was edited in this diff), not a co-movement guess.
  const moved = report.drift.length;
  if (moved > 0) {
    // One pass, shared classifier so the four buckets provably partition `moved` —
    // acked + fileAcked + docUpdated + unresolved cannot silently diverge.
    const fileGrainAcked = new Set(report.fileGrainAcked);
    let acked = 0;
    let fileAcked = 0;
    let docUpdated = 0;
    // A move that never gated owes no resolution, so it is its own bucket rather
    // than an unexplained remainder. Without it the buckets stop summing to
    // `moved` — a count a reader cannot reconcile is a count they stop reading.
    let reported = 0;
    for (const d of report.drift) {
      if (!d.gates) {
        reported++;
        continue;
      }
      switch (driftResolution(d, staleFeatures, fileGrainAcked)) {
        case "acked":
          acked++;
          break;
        case "file-acked":
          fileAcked++;
          break;
        case "doc-updated":
          docUpdated++;
          break;
      }
    }
    console.log(
      `  ${pc.bold("Drift resolution")}: ${moved} owned symbol(s) moved · ` +
        (reported > 0 ? `${reported} body-only (reported, not gated) · ` : "") +
        `${acked} acked (contract-neutral) · ` +
        (fileAcked > 0 ? `${fileAcked} file-acked (additive) · ` : "") +
        `${docUpdated} resolved by doc update · ${unresolved.length} still flagged`,
    );
    console.log();
  }

  // Acknowledgments in this change — the audit card, rendered wherever the human
  // already looks. Every covering ack (per-symbol and file-grain) is one line with
  // its signer badged self vs independent, so a self-adjudicated change is loud, not
  // a quiet green, and over-acking is visible at the moment of the change.
  if (report.coveringAcks.length > 0) {
    const selfCount = report.coveringAcks.filter((a) => !a.independent).length;
    // Under --require-independent-ack a self-ack does not clear its finding: mark it
    // ignored so the human sees WHY an acked move is still flagged.
    const strict = report.requireIndependentAck;
    const ignored = strict ? selfCount : 0;
    console.log(
      `  ${pc.bold("Acknowledgments in this change")} ${pc.dim(
        `— ${report.coveringAcks.length} covering (${selfCount} self${
          ignored > 0 ? `, ${ignored} not counted` : ""
        }); codument ack --list to manage`,
      )}`,
    );
    for (const a of report.coveringAcks) {
      const isIgnored = strict && !a.independent;
      const badge = a.independent
        ? pc.green("[independent]")
        : isIgnored
          ? pc.red("[self — not counted]")
          : pc.yellow("[self]");
      const target =
        a.grain === "file" ? pc.dim(`${a.anchorId} (file)`) : pc.bold(a.symbol ?? a.anchorId);
      const mark = isIgnored ? pc.red("✗") : pc.dim("✓");
      console.log(`    ${mark} ${target} ${badge} ${pc.dim(`${a.signer}:`)} ${a.reason}`);
    }
    if (ignored > 0) {
      console.log(
        pc.dim(
          report.independenceUnverifiable
            ? "    --require-independent-ack: independence could not be verified — the change has uncommitted edits (or no commit author). Commit it and review a committed range (--base) so an independent signer can be checked; no ack clears until then."
            : "    --require-independent-ack: a self-signed ack does not clear its finding — have an independent signer ack, or update the doc.",
        ),
      );
    }
    console.log();
  }

  section(
    pc.yellow("High-risk areas touched"),
    state.riskTouches.map(
      (r) => `${pc.yellow("⚠")} ${r.feature} [${r.risk.join(", ")}] — ${r.files.join(", ")}`,
    ),
  );

  if (plan) {
    section(
      "Out-of-plan changes",
      state.outOfPlan.map((f) => `${pc.yellow("⚠")} ${f}`),
    );
  }

  section(
    "Unmapped changes (no registry owner)",
    state.unmapped.map((f) => `${pc.yellow("⚠")} ${f}`),
  );

  section(
    "Docs changed without source",
    state.docsChangedWithoutSource.map((d) => `${pc.dim("•")} ${d}`),
  );

  section(
    "High-fanout changed files",
    state.highFanout.map((f) => `${pc.yellow("⚠")} ${f.file} → ${f.features.join(", ")}`),
  );

  section("Dependents that may need re-review", dependentLines(state.dependentsSummary));

  console.log(
    pc.dim(
      "  Review reports repo facts and suspicious gaps — it does not certify the change is safe.",
    ),
  );
}
