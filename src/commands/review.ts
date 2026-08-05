import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import pc from "picocolors";
import { ackCovers, isFileGrainAck, normalizeIdentity, readAcks } from "../lib/acknowledgment.js";
import { isExcluded, resolveScopeSync, type ExclusionSpec } from "../lib/analyze.js";
import {
  type ApprovedPlan,
  type ChangeState,
  computeChangeState,
  DEPENDENT_CAP,
  type DependentSummary,
  detectApprovedPlanScope,
  resolveFileGrainAcked,
} from "../lib/change-state.js";
import { computeDrift, type DriftFinding } from "../lib/drift.js";
import {
  fileContentTransition,
  gatherAnchorChanges,
  warmAdaptersForRepo,
} from "../lib/fingerprint.js";
import {
  assertRootIsRepoToplevel,
  isGateableRoot,
  resolveWorkspace,
  workspaceBases,
  getChangeAuthors,
  getHeadSha,
  getWorkingTreeChanges,
  getWorkingTreeDeletions,
  isGitRepo,
} from "../lib/git.js";
import { parseRegistryOrThrow, type Registry, readRegistrySync } from "../lib/registry.js";
import {
  findCoveringReview,
  findLatestReviewForBase,
  gatherReviewedFiles,
  gatherReviewFingerprint,
  parseReviewArtifact,
  reviewedDelta,
  writeReview,
} from "../lib/review-artifact.js";
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
  /** Files whose current content is covered by a file-grain ack (`codument ack
   *  <path>`) — the additive/concept/coarse staleness cleared this run. Surfaced so
   *  the resolution summary shows a file-ack AS an ack, never laundered as a doc
   *  update (over-acking stays visible). */
  fileGrainAcked: string[];
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
  grain: "symbol" | "file";
  /** The symbol name for a per-symbol ack; null for a file-grain ack. */
  symbol: string | null;
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
export function buildReview(
  root: string,
  changedFiles?: string[],
  baseRef = "HEAD",
  deletedFiles?: string[],
  opts: { requireIndependentAck?: boolean; exclusion?: ExclusionSpec } = {},
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
  const plan = detectApprovedPlanScope(root);
  // Per-symbol anchor diffs for the precise (TS) changed files, base ref vs the
  // working tree — this is what dissolves the shared-file cascade in the verdict.
  // Best-effort: coarse/non-TS files degrade to file-grain ownership; parse-error
  // files come back as `unevaluable` (gated file-grain AND surfaced).
  const { anchorChanges, unevaluable } = gatherAnchorChanges(root, baseRef, changes);
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
  const fileGrainAcked = resolveFileGrainAcked(root, baseRef, changes, honoredAcks, unevaluable);
  const state = computeChangeState({
    registry,
    changedFiles: changes,
    exclusion,
    planScope: plan?.scope,
    anchorChanges: filtered,
    // The ORIGINAL (pre-ack-filter) movement set: concept umbrellas wake off
    // this, so a per-symbol ack can never clear an umbrella's file-grain flag.
    contentMovedFiles: Object.entries(anchorChanges)
      .filter(([, v]) => v.length > 0)
      .map(([k]) => k),
    unevaluable,
    fileGrainAcked,
    deletedFiles: deletions,
    // Deleted files resolve ownership against the registry AT THE BASE — the
    // entry that owned the file while it existed — so removing the entry in the
    // same change cannot dodge the wake.
    baseRegistry: deletions.length > 0 ? readRegistryAtRef(root, baseRef) : undefined,
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
  const cardFileGrainAcked = requireIndependentAck
    ? resolveFileGrainAcked(root, baseRef, changes, acks, unevaluable)
    : fileGrainAcked;
  for (const file of cardFileGrainAcked) {
    const { from, to } = fileContentTransition(root, baseRef, file);
    if (from === null || to === null) continue;
    const ack = acks.find((a) => isFileGrainAck(a) && ackCovers(a, file, from, to));
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
    fileGrainAcked,
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
      pc.red("  ✗ --format sarif cannot combine with --json, --bundle, or --record; pick one output."),
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
      report = buildReview(
        root,
        changes,
        baseRef,
        worktreeDeletionsSince(root, options.base),
        reviewOpts,
      );
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
            { version: 2, gate: "unavailable", reason: err.message, kind: err.kind, isGitRepo: true },
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
    !!options.strict && (report.state.unmapped.length > 0 || report.state.staleDocs.length > 0);

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
      ? confirmFindings(
          covering.findings,
          makeTestRunner({ root, command: resolvedTest.command }),
        ).findings
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
    console.log(
      pc.red(
        `  ✗ --strict: ${reasons.join(" and ")} — the registry/docs are not in sync for this change.`,
      ),
    );
    console.log(
      pc.dim(
        "    Materialize unmapped sources (`codument map materialize <file>`), then resolve each stale doc:",
      ),
    );
    console.log(
      pc.dim(
        "    update it at intent altitude, or acknowledge a change that owes no doc line (`codument ack <path>` / `codument ack <path>::<symbol>`), then re-run.",
      ),
    );
    process.exitCode = 1;
  }

  if (reviewGate) {
    printReviewGate(reviewGate, confirmUnavailable, unreviewedCount);
    if (reviewGateFail) process.exitCode = 1;
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
  const realDeletions = deletions.filter(
    (d) => !isDocPath(d) && !isExcluded(d, exclusion),
  );
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
    console.log(
      `  ${pc.green("✓")} Adversarial review covers this diff` +
        (gate.advisoryFindings.length > 0
          ? pc.dim(` (${gate.advisoryFindings.length} advisory)`)
          : ""),
    );
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

  console.log(
    `  ${report.changedFileCount} changed file(s): ${state.changedSources.length} source, ${state.changedDocs.length} docs` +
      (state.otherChanged.length > 0 ? `, ${state.otherChanged.length} other` : "") +
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

  section(
    pc.yellow("Deleted sources (a removal owes its doc attention — update it or remove it too)"),
    state.deletedSources.map((f) => `${pc.yellow("⚠")} ${f}`),
  );

  // A stale doc whose changed source was gated at FILE grain (a coarse file:
  // .js, generated, re-export-only) produces no Symbol-drift entry, so without
  // this signpost the only visible resolution is a doc edit — the exact pressure
  // that breeds token mirror edits. Print both honest routes here, symmetric
  // with the Symbol drift block. A precisely-evaluated file resolves per symbol
  // below and gets no line; an unevaluable file is excluded because `ack`
  // refuses it (fix the parse instead).
  const driftFiles = new Set(report.drift.map((d) => d.anchorId.split("::")[0]));
  const unevaluableFiles = new Set(state.unevaluable);
  section(
    pc.yellow("Stale docs (source changed, mapped doc did not)"),
    state.staleDocs.map((d) => {
      let line = `${pc.yellow("⚠")} ${d.feature}: ${d.doc} (changed: ${d.changedSources.join(", ")})`;
      const coarse = d.changedSources.filter((f) => !driftFiles.has(f) && !unevaluableFiles.has(f));
      if (coarse.length > 0) {
        line += `\n        ${pc.dim("doc impact    →")} update ${d.doc} ${pc.dim("at intent altitude")}`;
        for (const f of coarse) {
          line += `\n        ${pc.dim("no doc impact →")} ${pc.cyan(`codument ack ${f} --reason "..."`)} ${pc.dim("(file-grain; expires when the file changes again)")}`;
        }
      }
      return line;
    }),
  );

  section(
    pc.yellow("Unassigned shared symbols (set owned_symbols in the registry)"),
    state.ownershipLints.map(
      (l) =>
        `${pc.yellow("⚠")} ${l.file} :: ${l.descriptor} — ${l.kind} across ${l.features.join(", ")}`,
    ),
  );

  section(
    pc.yellow("Could not evaluate (parse error — gated whole-file, fix to restore per-symbol)"),
    state.unevaluable.map((f) => `${pc.yellow("⚠")} ${f}`),
  );

  // Info-only, never a strict input: the registry claims these files matter to a
  // doc, but no adapter gates their staleness — say so instead of staying silent
  // (the .vue blind spot found in the website dogfood).
  section(
    pc.dim("Registered but ungated (no adapter judges these — verify their docs by hand)"),
    state.ungatedRegistered.map(
      (u) => `${pc.dim("•")} ${u.file} ${pc.dim(`→ ${u.owners.map((o) => o.doc).join(", ")}`)}`,
    ),
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
  const unresolved = report.drift.filter((d) => !d.acknowledged && staleFeatures.has(d.feature));
  if (unresolved.length > 0) {
    console.log(
      `  ${pc.bold("Symbol drift")} ${pc.dim("— resolve each: update the doc, or ack a contract-neutral move")}`,
    );
    for (const d of unresolved) {
      const sigTag = d.signatureChanged ? ` ${pc.yellow("[signature changed]")}` : "";
      console.log(
        `    ${pc.dim("•")} ${pc.bold(d.symbol)} ${pc.dim(`(${d.kind}) in ${d.feature}`)}${sigTag}`,
      );
      console.log(
        `        ${pc.dim("contract changed →")} update ${d.doc} ${pc.dim("at intent altitude")}`,
      );
      if (d.signatureChanged) {
        // A public signature moved: the contract changed, so NO ack applies (per
        // ADR 006). The only resolution is a doc update — name it, and do not
        // print an ack command that the gate would refuse.
        console.log(
          `        ${pc.dim("signature move  →")} ${pc.dim("the symbol's signature changed — the doc's contract needs an update, not an ack")}`,
        );
      } else if (d.kind === "changed") {
        console.log(
          `        ${pc.dim("internal only   →")} ${pc.cyan(`codument ack ${d.anchorId} --reason "..."`)}`,
        );
      } else {
        // An added/removed symbol has no per-symbol ack (ack rejects it: new or
        // removed content needs doc attention). The honest alternative is the
        // FILE-grain form — suggest the command that actually works when pasted.
        const file = d.anchorId.split("::")[0];
        console.log(
          `        ${pc.dim("additive only   →")} ${pc.cyan(`codument ack ${file} --reason "..."`)} ${pc.dim("(file-grain; a per-symbol ack does not apply to added/removed)")}`,
        );
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
    for (const d of report.drift) {
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
