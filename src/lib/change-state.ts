import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allSources,
  type Registry,
  type RegistryEntry,
  isSourcePattern,
  registeredPatterns,
  sourceMatcher,
} from "./registry.js";
import {
  DEFAULT_EXCLUSION_SPEC,
  isExcluded,
  isSourceFile,
  toPosix,
  type ExclusionSpec,
} from "./analyze.js";
import { resolveOwner, splitAnchorId } from "./ownership.js";
import { fileContentTransition, isPreciseFile, type AnchorChange } from "./fingerprint.js";
import {
  ackCovers,
  ackCoversTree,
  isFileGrainAck,
  isTreeGrainAck,
  type Acknowledgment,
  type CoveredFile,
} from "./acknowledgment.js";
import { movesOnly, type RenamePair } from "./git.js";
import { extractStatus, isApproved } from "./plan-steps.js";

// Deterministic diff snapshot over the v2 registry. Pure function of (registry,
// changed files, optional plan scope, optional per-file anchor changes): no git,
// no clock, no randomness — sorted throughout. Git extraction, plan detection,
// and anchor computation are separate (impure) helpers so this same analyzer
// backs both `review` (snapshot) and `watch` (live), which can never disagree.

export interface ChangeStateInput {
  registry: Registry;
  /** Changed paths (repo-relative, POSIX) from git or a watcher. */
  changedFiles: string[];
  /** Approved-plan scope (source paths) when detectable; enables out-of-plan. */
  planScope?: string[];
  exclusion?: ExclusionSpec;
  highFanoutThreshold?: number;
  /** Per-file anchor changes between base and the head being evaluated, keyed by
   *  repo-relative source path. Present ONLY for precise (per-symbol) files the
   *  caller computed: each changed anchor resolves PER-SYMBOL to its owning
   *  feature (via `resolveOwner`), dissolving the shared-file cascade — a one-
   *  symbol edit wakes only that symbol's owning doc. A file present with an empty
   *  array changed only cosmetically (no symbol moved) and wakes nothing. A changed
   *  source file ABSENT from this map (coarse/non-TS, or anchors uncomputable)
   *  falls back to file-grain ownership over `primary_sources`. Drives the stale-
   *  doc verdict only; `byFeature`/`riskTouches`/`dependents` stay the broad
   *  primary+related impact view. */
  anchorChanges?: Record<string, AnchorChange[]>;
  /** Changed precise-by-extension TS files that could not be parsed (caller-
   *  classified; see `gatherAnchorChanges`). Echoed into `ChangeState.unevaluable`
   *  so a parse error is surfaced (fail-loud) rather than silently coarse-gated;
   *  they are already gated file-grain by virtue of being absent from
   *  `anchorChanges`. */
  unevaluable?: string[];
  /** Files (repo-relative) whose CURRENT content is covered by a valid file-grain
   *  acknowledgment (`codument ack <path>`), resolved impurely by the caller (see
   *  `resolveFileGrainAcked`). Such a file's ADDITIVE (added/removed symbol),
   *  CONCEPT (file-grain umbrella), and COARSE/non-TS staleness contribution is
   *  cleared. A file-grain ack NEVER masks an unacknowledged moved (`changed`) owned
   *  symbol — that anchor still wakes its feature, so a real contract change is never
   *  laundered. Empty unless the caller resolved acks. */
  fileGrainAcked?: string[];
  /** Precise files whose ORIGINAL anchor diff — before acknowledgment filtering —
   *  was non-empty: the file's content genuinely moved. Concept umbrellas wake off
   *  THIS set, not the filtered `anchorChanges`, because a per-symbol ack
   *  adjudicates one feature contract and never the umbrella's file-grain
   *  narration — only a file-grain ack (or a doc update) clears the concept's
   *  flag. Absent → falls back to the filtered set (legacy callers). */
  contentMovedFiles?: string[];
  /** Paths deleted in this change (repo-relative, POSIX) — the complement the
   *  change listers drop from `changedFiles`. A deleted OWNED source is a
   *  first-class change: it wakes every primary owner (feature and concept) at
   *  file grain, and no acknowledgment clears it (per ADR-012's conservative
   *  stance a removal owes doc attention — a doc update or the doc's own
   *  removal). A deleted doc counts as doc attention for the staleness check. */
  deletedFiles?: string[];
  /** Renames in this change, as `{from, to}` pairs from git's own detection. The
   *  destination already arrives via `changedFiles`; the ORIGIN arrives only here,
   *  and it is the half that matters to the registry — a `git mv` used to present
   *  as a bare add, so an entry naming the old path was left pointing at nothing
   *  and the gate went green over it. */
  renames?: RenamePair[];
  /** Rename DESTINATIONS whose content is byte-identical to the origin at base: a
   *  pure move, which changes no contract and so owes no doc anything. Precise
   *  files need no such input (an empty anchor diff already says it), but a coarse
   *  or governed-registered file has no per-symbol view to say it with — its
   *  destination just looks like fresh content at a new path, so it woke every
   *  primary owner and the printed file-grain ack was refused, leaving a doc edit
   *  as the only exit. Absent → nothing is treated as a pure move. */
  unchangedMoves?: string[];
  /** Registry as of the base ref. Deleted files resolve ownership against this
   *  when provided (falling back to `registry`), so removing a file's registry
   *  entry in the same change cannot dodge the deletion wake — the entry that
   *  owned the file when it existed still flags its doc. */
  baseRegistry?: Registry;
  /** Docs still naming a path this change removed, resolved impurely by the caller
   *  (see `resolveDocPointers`) — the analyzer never reads a file. Absent → no doc
   *  pointer was looked for, which is byte-identical to a tree that removed nothing. */
  docPointers?: DocPointer[];
}

export interface FeatureGroup {
  feature: string;
  files: string[];
}

export interface StaleDoc {
  feature: string;
  doc: string;
  changedSources: string[];
  /**
   * The pattern entries among this feature's sources that woke it, each with how
   * many of `changedSources` it accounts for. `changedSources` stays complete —
   * a machine consumer wants every path — while a human surface prints the tree
   * and its count, because a locale drop lists 120 paths and a section that always
   * prints 120 paths is a section readers learn to skip. Empty when no pattern
   * was involved, so a registry of literal paths renders exactly as before.
   */
  viaPatterns: Array<{ pattern: string; count: number }>;
  /**
   * The changed sources here that no adapter can read — gated at file grain, with no
   * symbol view at all.
   *
   * The downgrade is correct and always was: registration widens the gate's scope,
   * never its judgment, so a `.rules` file or a registered `.js` is governed whole.
   * What was missing is that nothing said so. The reader was offered the blunt
   * file-grain route and left to infer from its absence that a per-symbol one was
   * never available — an inference from what is NOT printed, which is the same class
   * of silence as a condition reachable only above the verdict. Absent for a doc woken
   * only by files the gate can see inside.
   */
  coarseSources: string[];
}

export interface HighFanoutChange {
  file: string;
  features: string[];
}

export interface RiskTouch {
  feature: string;
  risk: string[];
  files: string[];
}

export interface DependentFeature {
  feature: string;
  dependsOn: string;
}

/** How many dependents any surface lists by name before collapsing to a count. Past
 *  this the list stops being read at all, and a section nobody reads is where a real
 *  warning goes to die. Shared so the CLI and the HTML report agree. */
export const DEPENDENT_CAP = 5;

/** One dependent feature with ALL its edges collapsed onto it — the rendered view of
 *  `dependents`, which is a pair per edge. A single `src/lib` edit on a repo with a
 *  couple of umbrella concepts produces dozens of pairs, unranked and reason-less, and
 *  a section that always prints dozens of lines is a section readers learn to skip.
 *  `dependents` stays the machine contract; this is what humans and the review bundle
 *  read. */
export interface DependentSummary {
  feature: string;
  /** Every changed feature this one declares a `depends_on` edge to, sorted. */
  dependsOn: string[];
  /** True when EVERY edge lands on a `type: "concept"` umbrella. Depending on a
   *  concept that narrates a whole directory is the weakest signal there is — the
   *  umbrella wakes on any file in it — so these rank last and are the first thing
   *  collapsed into the trailing count. */
  viaUmbrella: boolean;
}

/** A symbol on a file shared across multiple FEATURES that ownership could not
 *  resolve to a single owner: `unassigned` (no co-owner claims it in
 *  `owned_symbols`) or `ambiguous` (two+ claim it). The gate fails loud rather
 *  than silently waking all co-owners — it wakes every candidate AND surfaces this
 *  so the registry's `owned_symbols` map is corrected. */
export interface OwnershipLint {
  file: string;
  descriptor: string;
  kind: "unassigned" | "ambiguous";
  features: string[];
  /** How the anchor itself moved. Carried because it decides what can CLEAR the
   *  wake, which is the difference between guidance and a dead end: a file-grain
   *  ack skips an added/removed anchor but never a `changed` one, so a file ack
   *  cannot clear a wake driven by a changed unassigned symbol. A surface that
   *  offers one anyway sends the reader to a refusal at the moment of most
   *  pressure — and in the field, to two acks that recorded and cleared nothing. */
  changeKind: "added" | "removed" | "changed";
}

/** A registry entry still naming a path THIS CHANGE removed from the tree. The
 *  registry is the control plane every other answer is derived from — ownership,
 *  context packs, the adversary's grounding all read it as truth — so an entry
 *  pointing at a file that no longer exists quietly corrupts all three. A rename
 *  and a deletion both produce one; they are told apart because the fix differs
 *  (re-point vs remove), not because the gate treats them differently.
 *
 *  Scoped deliberately to paths this change removed. A path already missing at the
 *  base ref is PRE-EXISTING debt and stays `doctor`'s `missing-source` warn — review
 *  judges the change, doctor judges the repo, and blocking an unrelated edit on an
 *  adopting repo's old dangles would make the gate unsatisfiable. */
export interface RegistryPointer {
  /** The path that no longer exists. */
  file: string;
  /** Registry entries still naming it, sorted. */
  features: string[];
  kind: "renamed" | "deleted";
  /** Where it moved to, for a rename — the path the entry should now name. */
  renamedTo?: string;
}

export interface ChangeState {
  changedSources: string[];
  changedDocs: string[];
  /** Changed sources grouped by an owning feature (primary or related). */
  byFeature: FeatureGroup[];
  /** Changed sources with no registry owner. */
  unmapped: string[];
  /** Changed files that are neither source nor docs (config, assets, data):
   *  real working-tree changes outside codument's source↔doc governance. Kept so
   *  a clean verdict never claims "working tree clean" while they sit uncommitted. */
  otherChanged: string[];
  /** Changed files the exclusion spec drops — tests, build output, generated
   *  artifacts. They govern nothing and are judged by nothing, which is exactly
   *  why they need a name: every other bucket filters them out while the headline
   *  total counts them, so the most ordinary change a step makes (editing a test)
   *  printed a total that did not add up, with no bucket accounting for the
   *  remainder. Reported so the counts sum; never an input to any verdict. */
  excludedChanged: string[];
  /** Features whose source changed but whose mapped doc did not (drift). */
  staleDocs: StaleDoc[];
  /** Docs that changed while their feature's source did not. */
  docsChangedWithoutSource: string[];
  /** Changed files mapped across many features. */
  highFanout: HighFanoutChange[];
  /** Changed sources owned by a risk-tagged feature. */
  riskTouches: RiskTouch[];
  /** Features that depend on a changed feature and may need re-review. One entry per
   *  EDGE — the machine contract (`--json`, the review bundle). Render
   *  `dependentsSummary` instead. */
  dependents: DependentFeature[];
  /** `dependents` collapsed to one entry per feature and ranked: real feature edges
   *  before umbrella-only ones. The renderable view. */
  dependentsSummary: DependentSummary[];
  /** Changed sources outside the approved plan scope (only when planScope set). */
  outOfPlan: string[];
  /** True when a plan scope was provided (so outOfPlan is meaningful). */
  planScoped: boolean;
  /** Shared-file symbols ownership could not resolve (fail-loud; see OwnershipLint). */
  ownershipLints: OwnershipLint[];
  /** Changed TS files that could not be parsed — gated file-grain (never fresh) and
   *  surfaced so the parse error is fixed. Empty unless the caller classified. */
  unevaluable: string[];
  /** Deleted source files — surfaced so a deletion is visibly part of the change,
   *  not silently absent from it (owned ones also wake their owners' docs). */
  deletedSources: string[];
  /** Changed files the registry names as sources (primary or related) but that
   *  the gate does not judge AND does not govern — the residue left after
   *  `governedRegistered` takes the primary-owned, non-excluded ones. Two classes
   *  survive: registered-but-EXCLUDED (the spec overrides the registry, so the
   *  registration contradicts a declaration) and IMPACT-ONLY (named solely in
   *  `related_sources`, which claims impact and never ownership — ADR 004). Both
   *  stay info-only, never a strict verdict input; their docs are named so a
   *  human/agent can verify by hand. */
  ungatedRegistered: UngatedRegisteredChange[];
  /** Changed files no adapter judges that a feature/concept nonetheless OWNS
   *  (`primary_sources`) and the exclusion spec does not drop — locale packs,
   *  registered config, content files. A registration is an explicit claim that
   *  the file is load-bearing to a named doc, so these are GOVERNED at file grain
   *  exactly like an unparseable source: any content move wakes every primary
   *  owner, cleared by doc attention or a file-grain ack (ADR 017). Before that
   *  decision they were info-only, which meant rewriting a registered contract
   *  file passed `--strict` green. */
  /** Registry entries left pointing at a path this change removed (see
   *  `RegistryPointer`). A strict input: the gate stays red until the registry
   *  stops naming the vanished path. */
  registryPointers: RegistryPointer[];
  /** Registry-known docs whose prose still names a path this change removed. Held to
   *  the registry pointer's standard and for the same reason: both are the control
   *  plane pointing at nothing, and a reader sent to a path that is not there is
   *  worse served by the doc than by no doc. A strict input; no acknowledgment
   *  applies, because nothing here is a judgment call — the pointer is simply
   *  false. */
  docPointers: DocPointer[];
  governedRegistered: string[];
  /** Deleted counterparts of `governedRegistered` — an owned unjudgeable file
   *  removed. Wakes its owners with no ack fast-path, the same stance ADR 012
   *  takes for a deleted source: a removal owes doc attention. */
  governedDeleted: string[];
}

export interface UngatedRegisteredChange {
  file: string;
  owners: { feature: string; doc: string }[];
  /** WHY this registered file is not governed — three different situations that need
   *  three different words, because each has a different fix (or none).
   *  `excluded`: the exclusion spec drops it, so the registration contradicts a
   *  declaration and one of them should go.
   *  `impact-only`: it is named solely in `related_sources`, which claims impact and
   *  never ownership, so not waking is correct and there is nothing to fix.
   *  `unread`: owned as primary, but no adapter can read a line of it and no owner
   *  declares a risk — so the only artifact a block could demand is a signature over
   *  content nobody looked at (ADR 020). Reported with the one registry line that
   *  puts the block back, because a downgrade the user has to discover is worse than
   *  the gate it replaced. */
  kind: "excluded" | "impact-only" | "unread";
}

function sortStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isDoc(path: string): boolean {
  return path.startsWith("docs/") && path.endsWith(".md");
}

export function computeChangeState(input: ChangeStateInput): ChangeState {
  const {
    registry,
    exclusion = DEFAULT_EXCLUSION_SPEC,
    highFanoutThreshold = 3,
    planScope,
  } = input;
  const changed = new Set(input.changedFiles);

  const entries = Object.entries(registry.features).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  // A pattern entry names a set, so every index below wants the paths it resolves
  // to. Expanded ONCE, against the paths this change actually touches — those are
  // the only paths any index is ever asked about, and expanding against the whole
  // tree would walk the filesystem to answer a question nobody asked. The exclusion
  // spec still wins here, not only at authoring time: the authoring guard is
  // deliberately syntactic (it cannot see the file list), so this is the surface
  // where a pattern is stopped from re-admitting what the spec drops.
  const touched = sortStrings([...changed, ...(input.deletedFiles ?? [])]);
  const expandSources = (sources: string[]): string[] => {
    if (!sources.some(isSourcePattern)) return sources;
    const out: string[] = [];
    for (const src of sources) {
      if (!isSourcePattern(src)) {
        out.push(src);
        continue;
      }
      const re = sourceMatcher(src);
      for (const f of touched) {
        if (re.test(toPosix(f)) && !isExcluded(f, exclusion) && !out.includes(f)) out.push(f);
      }
    }
    return out;
  };

  // Index: source path -> owning features, and feature -> its doc paths.
  const fileToFeatures = new Map<string, string[]>();
  for (const [key, entry] of entries) {
    for (const source of expandSources(allSources(entry))) {
      const list = fileToFeatures.get(source) ?? [];
      if (!list.includes(key)) list.push(key);
      fileToFeatures.set(source, list);
    }
  }

  const changedSources = sortStrings(
    [...changed].filter((f) => !isDoc(f) && isSourceFile(f, exclusion)),
  );
  const changedDocs = sortStrings([...changed].filter(isDoc));
  // Deletions, first-class: sources wake owners below; a deleted doc counts as
  // doc ATTENTION (removing a feature wholesale — source + doc — is resolved,
  // not stale), so it joins the changed-doc set the staleness check reads while
  // staying out of `changedDocs` (those are extant paths).
  const deleted = sortStrings(input.deletedFiles ?? []);
  const deletedSources = deleted.filter((f) => !isDoc(f) && isSourceFile(f, exclusion));
  const docChangedSet = new Set([...changedDocs, ...deleted.filter(isDoc)]);
  // The third bucket beside sources and docs: real, non-excluded changes that are
  // neither a doc nor a recognized source — config like app.json, an image asset,
  // a data file. Excluded build/generated paths (dist/, node_modules/, *.seed.json,
  // …) are dropped here too, exactly as they are from changedSources and unmapped,
  // so the verdict counts only changes a human cares about — surfaced so a clean
  // verdict stays honest that the tree isn't empty.
  const otherChanged = sortStrings(
    [...changed].filter(
      (f) => !isDoc(f) && !isSourceFile(f, exclusion) && !isExcluded(f, exclusion),
    ),
  );
  // The remainder every other bucket drops. Scoped to EXTANT changes only: a
  // deletion is already counted whole in its own bucket, so folding excluded
  // deletions in here would trade a total that does not add up for one that adds
  // up twice — the same defect wearing the fix's clothes.
  const excludedChanged = sortStrings(
    [...changed].filter((f) => !isDoc(f) && isExcluded(f, exclusion)),
  );

  const entryByKey = new Map(entries);
  const changedSourceSet = new Set(changedSources);

  // group changed sources by owning feature
  const groups = new Map<string, string[]>();
  const unmapped: string[] = [];
  for (const file of changedSources) {
    const owners = fileToFeatures.get(file);
    if (!owners || owners.length === 0) {
      if (!isExcluded(file, exclusion)) unmapped.push(file);
      continue;
    }
    for (const owner of owners) {
      const list = groups.get(owner) ?? [];
      list.push(file);
      groups.set(owner, list);
    }
  }
  const byFeature: FeatureGroup[] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([feature, files]) => ({ feature, files: sortStrings(files) }));

  // which features had a source change (broad, primary+related, file grain) —
  // drives the IMPACT views (dependents below; riskTouches uses `groups`).
  const changedFeatures = new Set(groups.keys());

  // ── Symbol-grained doc-staleness ownership ──────────────────────────────
  // Doc-staleness is the precise DRIFT verdict, distinct from the broad impact
  // views above. Ownership is `primary_sources` only (related = impact, not
  // ownership), resolved PER-SYMBOL when the caller supplied anchor changes for a
  // file — so a one-symbol edit to a shared file wakes only that symbol's owning
  // doc, dissolving the cascade. Concept umbrellas (a `type:"concept"` entry that
  // narrates a directory file-by-file) are never per-symbol owners: they wake at
  // file grain whenever an owned file's content moves.
  const featurePrimary = new Map<string, string[]>();
  const conceptPrimary = new Map<string, string[]>();
  for (const [key, entry] of entries) {
    const idx = entry.type === "concept" ? conceptPrimary : featurePrimary;
    for (const src of expandSources(entry.primary_sources)) {
      const list = idx.get(src) ?? [];
      if (!list.includes(key)) list.push(key);
      idx.set(src, list);
    }
  }

  // ── Registered files no adapter judges ──────────────────────────────────
  // A file the registry explicitly claims (someone decided it matters to a doc)
  // that no adapter can judge — outside the source-extension spec (.json, .css)
  // or excluded by it (a declaration artifact, a generated file). Built from the
  // full changed set, not the other-changed bucket: exclusion silences the
  // DEFAULT scope, but a registration is an explicit human claim, so silence for
  // a registered file would be a false "fresh" whatever dropped it.
  //
  // Such a file splits by whether the registry OWNS it (ADR 017):
  //   - owned (`primary_sources`), not excluded, and RISK-DECLARED -> GOVERNED at
  //     file grain. Any content move wakes every primary owner, cleared by doc
  //     attention or a file-grain ack signed over the changed lines.
  //   - owned but with no risk tag on any owner -> reported, never gated (ADR 020).
  //     ADR 017 gated every owned blind file, and it was right that a claimed file
  //     going silently green is a false green — but the block it demanded is one the
  //     tool cannot check. Nothing here can be read, so the only artifact a gate can
  //     ask for is a signature over "this was fine", which is the theater ADR 020
  //     names. A risk tag is the project saying the opposite out loud: this file can
  //     do real damage unread, so make me look. One registry line, and the block is
  //     back — but it is the project's declaration, not the tool's guess.
  //   - anything else -> the info-only residue. EXCLUDED beats registration (the
  //     spec overrides the registry, so the two declarations contradict), and an
  //     IMPACT-ONLY registration (`related_sources`) never wakes by design.
  //
  // A DELETION is untouched by any of this and still gates without a risk tag: the
  // file is gone, which is structurally proven and needs no reading, and the fix
  // (update the doc, or drop the entry) is checkable. That was the worse half of
  // ADR 017's field case, and it stays closed.
  const governedRegistered: string[] = [];
  const ungatedRegistered: UngatedRegisteredChange[] = [];
  for (const file of sortStrings(changed)) {
    if (isDoc(file) || changedSourceSet.has(file)) continue;
    const owners = fileToFeatures.get(file);
    if (!owners || owners.length === 0) continue;
    const primaryOwners = [
      ...(featurePrimary.get(file) ?? []),
      ...(conceptPrimary.get(file) ?? []),
    ];
    const ownedPrimary = primaryOwners.length > 0;
    const excluded = isExcluded(file, exclusion);
    if (ownedPrimary && !excluded) {
      // ANY risk-declared owner gates the file: risk is a claim about consequence,
      // and one owner saying "this can hurt" is not overruled by another staying
      // quiet. Asked of the PRIMARY owners only, matching who the wake reaches.
      const risky = primaryOwners.some(
        (key) => (entryByKey.get(key)?.risk?.length ?? 0) > 0,
      );
      if (risky) {
        governedRegistered.push(file);
        continue;
      }
      ungatedRegistered.push({
        file,
        owners: primaryOwners
          .slice()
          .sort()
          .map((key) => ({ feature: key, doc: entryByKey.get(key)?.doc ?? "" })),
        kind: "unread",
      });
      continue;
    }
    ungatedRegistered.push({
      file,
      owners: owners
        .slice()
        .sort()
        .map((key) => ({ feature: key, doc: entryByKey.get(key)?.doc ?? "" })),
      // Exclusion first: a file that is BOTH excluded and impact-only is reported as
      // the contradiction, the stronger signal and the only one with something to fix.
      kind: excluded ? "excluded" : "impact-only",
    });
  }

  // feature/concept -> the changed files that woke it (for staleDoc.changedSources)
  const wokenFiles = new Map<string, Set<string>>();
  const wake = (key: string, file: string) => {
    const set = wokenFiles.get(key) ?? new Set<string>();
    set.add(file);
    wokenFiles.set(key, set);
  };
  const wakeConcepts = (file: string) => {
    for (const c of conceptPrimary.get(file) ?? []) wake(c, file);
  };

  const ownershipLints: OwnershipLint[] = [];
  // Files whose current content is covered by a file-grain ack (`codument ack
  // <path>`): their additive/concept/coarse staleness is cleared, but a `changed`
  // (moved) owned symbol still wakes — a file ack never masks a real contract move.
  const fileGrainAcked = new Set(input.fileGrainAcked ?? []);
  // Pre-ack-filter content movement, for the concept-umbrella wake (see the
  // input's contract). Undefined → legacy fallback to the filtered set.
  const contentMoved =
    input.contentMovedFiles !== undefined ? new Set(input.contentMovedFiles) : undefined;
  // A file that only MOVED carries no content change to wake anything with. The
  // precise branch says this for itself (an empty anchor diff), so this set exists
  // for the grains that cannot: coarse and governed-registered files, whose
  // destination is otherwise indistinguishable from new content at a new path.
  const unchangedMoves = new Set(input.unchangedMoves ?? []);

  for (const file of changedSources) {
    const acked = fileGrainAcked.has(file);
    const precise = input.anchorChanges?.[file];
    if (precise !== undefined) {
      // PER-SYMBOL: each changed anchor resolves to exactly its owning feature.
      for (const ch of precise) {
        // A file-grain ack clears added/removed residue but NEVER a moved symbol:
        // a `changed` anchor still wakes its owning feature.
        if (acked && ch.kind !== "changed") continue;
        const res = resolveOwner(registry, ch.id);
        if (res.kind === "owned") {
          wake(res.feature, file);
        } else if (res.kind === "unassigned") {
          // fail loud: a shared symbol no co-owner claims — wake every candidate
          // (never under-wake) AND surface so `owned_symbols` is corrected.
          for (const c of res.candidates) wake(c, file);
          ownershipLints.push({
            file,
            descriptor: splitAnchorId(ch.id).descriptor,
            kind: "unassigned",
            features: res.candidates,
            changeKind: ch.kind,
          });
        } else if (res.kind === "ambiguous") {
          for (const o of res.owners) wake(o, file);
          ownershipLints.push({
            file,
            descriptor: splitAnchorId(ch.id).descriptor,
            kind: "ambiguous",
            features: res.owners,
            changeKind: ch.kind,
          });
        }
        // "unowned": no feature owns it per-symbol; a concept umbrella (below) may.
      }
      // Concept umbrellas wake at file grain whenever the file's content moved —
      // judged on the ORIGINAL (pre-ack-filter) anchor set: a per-symbol ack
      // adjudicated ONE feature contract, never the umbrella's file-grain
      // narration, so it must not clear the concept (ADR-012). Only a file-grain
      // ack (the file-grain judgment) or a doc update clears that contribution.
      const moved = contentMoved !== undefined ? contentMoved.has(file) : precise.length > 0;
      if (moved && !acked) wakeConcepts(file);
    } else if (!acked && !unchangedMoves.has(file)) {
      // FILE-GRAIN FALLBACK (coarse/non-TS, or anchors uncomputable): every
      // PRIMARY owner — feature or concept — wakes; related_sources never does. A
      // covering file-grain ack clears the whole fallback wake (a coarse file has no
      // per-symbol move to protect — the ack is the file-grain judgment for it), and
      // a pure move never enters it at all — the same silence a precise pure rename
      // already gets from an empty anchor diff.
      for (const key of featurePrimary.get(file) ?? []) wake(key, file);
      wakeConcepts(file);
    }
  }

  // Governed registered files ride the SAME file-grain fallback: no adapter can
  // judge them, so there is no per-symbol move to protect and a file-grain ack is
  // the file-grain judgment for them. `related_sources` still never wakes, and a
  // pure move is silent here too — a registration widens what the gate governs, not
  // what counts as a change.
  for (const file of governedRegistered) {
    if (fileGrainAcked.has(file)) continue;
    if (unchangedMoves.has(file)) continue;
    for (const key of featurePrimary.get(file) ?? []) wake(key, file);
    wakeConcepts(file);
  }

  // ── Deletions wake owners file-grain, with no ack fast-path ─────────────
  // A removed owned file is a real contract change: its owners' docs owe
  // attention (an update, or their own removal). Ownership resolves against the
  // BASE registry when provided, so deleting the registry entry in the same
  // change cannot dodge the wake — and an entry that no longer exists in the
  // current registry still flags its (base) doc below.
  const deletionRegistry = input.baseRegistry ?? registry;
  const deletionEntries = Object.entries(deletionRegistry.features);
  // Deleted files no adapter judges and the spec does not drop. Whether one is
  // actually OWNED is decided by the loop below against the BASE registry — the
  // same authority the deleted-source path uses, so removing the entry in the same
  // change cannot dodge the wake. Deleting a registered locale pack used to exit
  // green with no line at all: `ungatedRegistered` is built from the CHANGED set,
  // which deletions never enter, so the blind spot had no advisory either.
  const deletedUnjudged = deleted.filter(
    (f) => !isDoc(f) && !isSourceFile(f, exclusion) && !isExcluded(f, exclusion),
  );
  const governedDeletedSet = new Set<string>();
  // base-only features woken by a deletion: key -> {docs, files} synthesized
  // into staleDocs after the main per-entry loop (which walks the CURRENT registry).
  const removedEntryWakes = new Map<string, { doc: string; docs: string[]; files: Set<string> }>();
  for (const file of [...deletedSources, ...deletedUnjudged]) {
    for (const [key, entry] of deletionEntries) {
      if (!entry.primary_sources.includes(file)) continue;
      if (!isSourceFile(file, exclusion)) governedDeletedSet.add(file);
      if (key in registry.features) {
        wake(key, file);
      } else {
        const w = removedEntryWakes.get(key) ?? {
          doc: entry.doc,
          docs: [entry.doc, ...entry.docs],
          files: new Set<string>(),
        };
        w.files.add(file);
        removedEntryWakes.set(key, w);
      }
    }
  }

  ownershipLints.sort((a, b) =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : a.descriptor < b.descriptor
        ? -1
        : a.descriptor > b.descriptor
          ? 1
          : 0,
  );

  // Which of an entry's pattern sources account for the files that woke it, and how
  // many each. A path can only be claimed once — by the first pattern that names it,
  // in the entry's own order — so the counts partition the woken set rather than
  // double-counting a file two overlapping trees both match.
  const patternsCovering = (
    entry: RegistryEntry,
    files: string[],
  ): Array<{ pattern: string; count: number }> => {
    const patterns = entry.primary_sources.filter(isSourcePattern);
    if (patterns.length === 0) return [];
    const claimed = new Set<string>();
    const out: Array<{ pattern: string; count: number }> = [];
    for (const pattern of patterns) {
      const re = sourceMatcher(pattern);
      let count = 0;
      for (const f of files) {
        if (claimed.has(f) || !re.test(toPosix(f))) continue;
        claimed.add(f);
        count++;
      }
      if (count > 0) out.push({ pattern, count });
    }
    return out;
  };

  // stale docs: a feature/concept whose OWNED source changed but whose docs did
  // not (symbol-grained for features, file-grain for concepts and the fallback).
  const staleDocs: StaleDoc[] = [];
  const docsChangedWithoutSource: string[] = [];
  for (const [key, entry] of entries) {
    const featureDocs = [entry.doc, ...entry.docs];
    // A deleted doc counts as attention too (docChangedSet includes deletions).
    const aDocChanged = featureDocs.some((d) => docChangedSet.has(d));
    const woken = wokenFiles.get(key);
    const sourceChanged = woken !== undefined && woken.size > 0;

    if (sourceChanged && !aDocChanged) {
      const files = sortStrings(woken);
      staleDocs.push({
        feature: key,
        doc: entry.doc,
        changedSources: files,
        viaPatterns: patternsCovering(entry, files),
        coarseSources: files.filter((f) => !isPreciseFile(f)),
      });
    }
    if (aDocChanged && !sourceChanged) {
      for (const d of featureDocs) {
        if (changed.has(d)) docsChangedWithoutSource.push(d);
      }
    }
  }
  // Features whose registry entry was removed in the same change that deleted
  // their source: the entry that owned the file at base still flags its doc,
  // unless that doc itself got attention (updated or removed with it).
  for (const [key, w] of removedEntryWakes) {
    if (w.docs.some((d) => docChangedSet.has(d))) continue;
    // A removed entry has no sources left to consult, so nothing here came via a
    // pattern by construction.
    staleDocs.push({
      feature: key,
      doc: w.doc,
      changedSources: sortStrings(w.files),
      viaPatterns: [],
      // A removed entry's files are gone; the grain question is about what the gate
      // can still read, and there is nothing left to read.
      coarseSources: [],
    });
  }
  staleDocs.sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));

  // ── Registry pointers left dangling BY THIS CHANGE ──────────────────────
  // Resolved against the CURRENT registry, because the finding is about the
  // registry being wrong right now: the moment an entry stops naming the vanished
  // path it clears itself, with no acknowledgment and nothing to remember. A
  // rename's origin is the case that was invisible before — it reached the gate as
  // a bare add, so the pointer rotted silently while the verdict went green.
  // A pointer is false only when the path is actually GONE. Git reports a rename
  // (and, with copy detection, a copy) from a similarity pass over one side of the
  // change, and `deletedFiles` reports the index side — so both can name a path
  // that is present at head: `git mv a b` plus a re-export shim at `a`, or a plain
  // copy. Demanding the registry stop naming a file you can see on disk is not a
  // fix anyone can apply — dropping the entry only makes the surviving file
  // unmapped — so the guard is the plan's own predicate, enforced rather than
  // assumed: named at base, absent at head. `changedFiles` is the head-side
  // evidence both modes already carry (it unions untracked paths), and it is
  // git's own byte-exact spelling, so a case-only rename on a case-insensitive
  // filesystem is still a move.
  const registryPointers: RegistryPointer[] = [];
  const namingEntries = (path: string): string[] =>
    entries.filter(([, e]) => allSources(e).includes(path)).map(([key]) => key);
  for (const { from, to } of movesOnly(input.renames ?? [], changed)) {
    const features = namingEntries(from);
    if (features.length > 0) {
      registryPointers.push({ file: from, features: sortStrings(features), kind: "renamed", renamedTo: to });
    }
  }
  for (const file of removedInChange(input.renames ?? [], input.changedFiles, deleted)) {
    if (input.renames?.some((r) => r.from === file)) continue; // already named as a rename
    const features = namingEntries(file);
    if (features.length > 0) {
      registryPointers.push({ file, features: sortStrings(features), kind: "deleted" });
    }
  }
  registryPointers.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // high-fanout among changed files
  const highFanout: HighFanoutChange[] = [];
  for (const file of changedSources) {
    const owners = fileToFeatures.get(file);
    if (owners && owners.length >= highFanoutThreshold) {
      highFanout.push({ file, features: sortStrings(owners) });
    }
  }

  // risk touches: a changed source owned by a risk-tagged feature
  const riskTouches: RiskTouch[] = [];
  for (const [key, entry] of entries) {
    if (entry.risk.length === 0) continue;
    const files = sortStrings(groups.get(key) ?? []);
    if (files.length > 0) {
      riskTouches.push({ feature: key, risk: sortStrings(entry.risk), files });
    }
  }

  // dependents: features that depend on a changed feature (the blast radius);
  // a feature that both changed and depends on another changed feature is still
  // surfaced, since its integration with that dependency may need re-review.
  const dependents: DependentFeature[] = [];
  for (const [key, entry] of entries) {
    for (const dep of entry.depends_on) {
      if (changedFeatures.has(dep) && dep !== key) {
        dependents.push({ feature: key, dependsOn: dep });
      }
    }
  }
  dependents.sort((a, b) =>
    a.feature !== b.feature
      ? a.feature < b.feature
        ? -1
        : 1
      : a.dependsOn < b.dependsOn
        ? -1
        : a.dependsOn > b.dependsOn
          ? 1
          : 0,
  );

  // The renderable view: one entry per dependent FEATURE, ranked so the weakest
  // signal sorts last. An edge onto a concept umbrella says "this feature declares a
  // dependency on a directory narrative", and that umbrella wakes whenever any file
  // in it moves — which is what turns a one-file edit into a wall of dependents.
  // `dependents` above stays one entry per edge: it is the machine contract.
  const summaryByFeature = new Map<string, string[]>();
  for (const d of dependents) {
    const list = summaryByFeature.get(d.feature) ?? [];
    list.push(d.dependsOn);
    summaryByFeature.set(d.feature, list);
  }
  const dependentsSummary: DependentSummary[] = [...summaryByFeature.entries()]
    .map(([feature, deps]) => ({
      feature,
      dependsOn: sortStrings(deps),
      viaUmbrella: deps.every((dep) => entryByKey.get(dep)?.type === "concept"),
    }))
    .sort((a, b) =>
      a.viaUmbrella !== b.viaUmbrella
        ? a.viaUmbrella
          ? 1
          : -1
        : a.feature < b.feature
          ? -1
          : a.feature > b.feature
            ? 1
            : 0,
    );

  // out-of-plan changed sources
  let outOfPlan: string[] = [];
  const planScoped = Array.isArray(planScope);
  if (planScoped) {
    const scope = new Set(planScope);
    outOfPlan = changedSources.filter((f) => !scope.has(f));
  }

  return {
    changedSources,
    changedDocs,
    byFeature,
    unmapped: sortStrings(unmapped),
    otherChanged,
    excludedChanged,
    staleDocs,
    docsChangedWithoutSource: sortStrings(docsChangedWithoutSource),
    highFanout,
    riskTouches,
    dependents,
    dependentsSummary,
    outOfPlan,
    planScoped,
    ownershipLints,
    unevaluable: sortStrings(input.unevaluable ?? []),
    deletedSources,
    ungatedRegistered,
    registryPointers,
    docPointers: input.docPointers ?? [],
    governedRegistered: sortStrings(governedRegistered),
    governedDeleted: sortStrings(governedDeletedSet),
  };
}

/**
 * Every path this change REMOVED: a rename's origin and a deletion, sorted.
 *
 * "Removed" is narrower than what git reports and narrower than what a deletion
 * listing says. Git pairs by similarity, so a copy and a file split both arrive
 * labelled as renames while the origin is still on disk; and a path dropped from the
 * index but present in the tree was not removed either. Both narrowings already
 * governed the registry-pointer finding, and they are lifted here rather than
 * re-derived, because two findings about "what is gone" deciding it separately is
 * exactly how they would come to disagree about the same file.
 */
export function removedInChange(
  renames: readonly RenamePair[],
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
): string[] {
  const changed = new Set(changedFiles);
  const gone = new Set<string>();
  for (const { from } of movesOnly(renames, changed)) gone.add(from);
  for (const file of deletedFiles) {
    if (!changed.has(file)) gone.add(file);
  }
  return sortStrings(gone);
}

/** One doc still naming a path this change took away. The registry's pointer to a
 *  vanished file is checked; the prose pointer beside it was not, so a rename that
 *  correctly re-pointed the entry went green with the owning doc's Key files layer
 *  still sending the next reader to a path that is not there. */
export interface DocPointer {
  doc: string;
  /** The removed paths this doc names, sorted. */
  paths: string[];
}

/**
 * Which registry-known docs still name a path this change removed.
 *
 * Impure (reads the docs), so it lives with the other resolvers rather than inside
 * the analyzer. Scoped to the docs the registry names — the knowledge base codument
 * governs — and deliberately not to every markdown file in the tree: a plan is
 * transient scaffolding and an ADR is an immutable record of a decision, and neither
 * should be rewritten because a file later moved. A doc that is absent contributes
 * nothing rather than raising, the same advisory stance every other walk here takes.
 */
export function resolveDocPointers(
  root: string,
  registry: Registry,
  removed: readonly string[],
): DocPointer[] {
  if (removed.length === 0) return [];
  const docs = sortStrings(
    new Set(Object.values(registry.features).flatMap((e) => [e.doc, ...e.docs])),
  );
  const out: DocPointer[] = [];
  for (const doc of docs) {
    let text: string;
    try {
      text = readFileSync(join(root, doc), "utf-8");
    } catch {
      continue; // absent or unreadable — nothing to read a pointer out of
    }
    const paths = removed.filter((p) => namesPath(text, p));
    if (paths.length > 0) out.push({ doc, paths });
  }
  return out;
}

/** Whether `text` names `path` as a path rather than as a fragment of a longer one.
 *  Bounded on both sides by the characters a path is made of, so a doc naming
 *  `src/a.ts.bak` or `vendor/src/a.ts` is not read as naming `src/a.ts`. */
function namesPath(text: string, path: string): boolean {
  const isPathChar = (c: string): boolean => /[A-Za-z0-9_./\\-]/.test(c);
  for (let i = text.indexOf(path); i !== -1; i = text.indexOf(path, i + 1)) {
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + path.length] ?? "";
    if (!isPathChar(before) && !isPathChar(after)) return true;
  }
  return false;
}

// ── File-grain acknowledgment resolution ────────────────────────────────
//
// Which of the changed files carry a valid, CURRENT-content file-grain ack — the
// `fileGrainAcked` set the pure analyzer consumes. Impure (reads git + disk to
// recompute each file's content transition), so it lives beside the analyzer, never
// inside it. Only files a file-grain ack actually names are transition-checked, so a
// clean tree pays nothing. A file that just became unevaluable (a fresh parse error)
// is excluded — the fail-loud stance holds: a broken file is never acked fresh. The
// ack's `to` must match the file's current content, so a later edit auto-invalidates
// it exactly like a symbol ack. `renamedFrom` (destination → origin) is what makes a
// MOVED file ackable at all: its base content lived at the origin, so without the map
// the transition reads as "added" and the ack the gate printed is refused.
export function resolveFileGrainAcked(
  root: string,
  base: string,
  changedFiles: string[],
  acks: Acknowledgment[],
  unevaluable: string[] = [],
  renamedFrom?: ReadonlyMap<string, string>,
): string[] {
  const fileAcks = acks.filter(isFileGrainAck);
  if (fileAcks.length === 0) return [];
  const ackedIds = new Set(fileAcks.map((a) => a.anchorId));
  const unevaluableSet = new Set(unevaluable);
  const covered: string[] = [];
  for (const file of changedFiles) {
    if (!ackedIds.has(file)) continue; // no file-grain ack names this path
    if (unevaluableSet.has(file)) continue; // parse-unevaluable is never acked fresh
    const { from, to } = fileContentTransition(root, base, file, renamedFrom?.get(file) ?? file);
    if (from === null || to === null) continue; // added/deleted — no content transition
    if (fileAcks.some((a) => ackCovers(a, file, from, to))) covered.push(file);
  }
  return covered.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── Tree-grain acknowledgment resolution ────────────────────────────────

/** What a pattern currently governs inside one change. */
export interface TreeCoverage {
  /** Every touched file the pattern matches, with the transition an ack would bind. */
  files: CoveredFile[];
  /** Matched paths with NO transition: added in this change, or gone from the tree.
   *  Either makes the tree unackable — a new governed unit and a removal both owe
   *  the doc a line (ADR 012), and adding a language is the change most worth
   *  seeing. Named rather than skipped, so the refusal can say which files. */
  unresolvable: string[];
}

// What a pattern governs in THIS change: the touched files it matches (the exclusion
// spec still winning, as it does everywhere), each with its content transition. The
// caller passes the touched set INCLUDING deletions, so a removal inside the tree
// surfaces as unresolvable instead of quietly sitting outside the vouch.
export function treeCoverage(
  root: string,
  base: string,
  pattern: string,
  touchedFiles: string[],
  exclusion: ExclusionSpec = DEFAULT_EXCLUSION_SPEC,
  renamedFrom?: ReadonlyMap<string, string>,
): TreeCoverage {
  const re = sourceMatcher(pattern);
  const files: CoveredFile[] = [];
  const unresolvable: string[] = [];
  for (const f of sortStrings(touchedFiles)) {
    const posix = toPosix(f);
    if (!re.test(posix) || isExcluded(f, exclusion)) continue;
    const { from, to } = fileContentTransition(root, base, f, renamedFrom?.get(f) ?? f);
    if (from === null || to === null) unresolvable.push(posix);
    else files.push({ path: posix, from, to });
  }
  return { files, unresolvable };
}

// The tree acknowledgments whose vouch stands against THIS change, each mapped to
// the files it covers — folded by the caller into the `fileGrainAcked` set the pure
// analyzer consumes, because "this file's current content owes no doc change" is the
// same judgment whether it was made one file or one tree at a time. Impure (git +
// disk) for the same reason its file-grain twin is, and it costs nothing until a tree
// ack exists. Resolved once per pattern and read by both the gate and the audit card,
// so the two can never disagree about what a tree ack covered.
//
// Only a pattern some entry DECLARES in `primary_sources` is honored. The width is
// the point of the grain and also its danger: an unregistered glob typed at the
// command line would vouch for whatever it happened to sweep, so the thing that
// earns a wide vouch is a committed declaration (ADR 017), not the argument.
export function standingTreeAcks(
  root: string,
  base: string,
  touchedFiles: string[],
  acks: Acknowledgment[],
  registry: Registry,
  exclusion: ExclusionSpec = DEFAULT_EXCLUSION_SPEC,
  renamedFrom?: ReadonlyMap<string, string>,
): Map<Acknowledgment, string[]> {
  const standing = new Map<Acknowledgment, string[]>();
  const treeAcks = acks.filter(isTreeGrainAck);
  if (treeAcks.length === 0) return standing;
  const governed = new Set(registeredPatterns(registry));
  const seen = new Map<string, TreeCoverage>();
  for (const ack of treeAcks) {
    if (!governed.has(ack.anchorId)) continue;
    let now = seen.get(ack.anchorId);
    if (now === undefined) {
      now = treeCoverage(root, base, ack.anchorId, touchedFiles, exclusion, renamedFrom);
      seen.set(ack.anchorId, now);
    }
    if (now.unresolvable.length > 0 || !ackCoversTree(ack, now.files)) continue;
    standing.set(
      ack,
      now.files.map((c) => c.path),
    );
  }
  return standing;
}

// ── Approved-plan detection ─────────────────────────────────────────────
//
// Reads docs/plans/*.md for an approved plan and parses its `## Scope` section
// (backtick-quoted source paths). Used by `review`/`watch` to flag out-of-plan
// changes. Kept here, beside computeChangeState, so both commands share it; the
// pure analyzer above never touches the filesystem.

export interface ApprovedPlan {
  plan: string;
  scope: string[];
  /** Every approved-with-scope plan found, winner first (sorted by filename).
   *  More than one element = ambiguity the surfaces must SAY (one line naming
   *  all and which won) rather than let the first-by-filename win silently. */
  contenders: string[];
}

export function detectApprovedPlanScope(root: string): ApprovedPlan | null {
  const plansDir = join(root, "docs", "plans");
  if (!existsSync(plansDir)) return null;

  let files: string[];
  try {
    files = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return null;
  }

  let winner: ApprovedPlan | null = null;
  const contenders: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(plansDir, file), "utf-8");
    } catch {
      continue;
    }
    if (!isApprovedPlan(content)) continue;
    const scope = parseScopeSection(content);
    if (scope.length === 0) continue;
    contenders.push(`docs/plans/${file}`);
    if (!winner) winner = { plan: `docs/plans/${file}`, scope, contenders };
  }
  return winner;
}

// One shared approval predicate with `codument steps` (plan-steps.ts): the
// markdown-stripped status must equal "approved" exactly. A local literal
// regex here once diverged from steps' word-boundary match, so the two
// surfaces could disagree about the same plan (`Status: **approved**` drove
// steps but never enabled out-of-plan detection) — sharing the predicate makes
// that disagreement impossible.
function isApprovedPlan(content: string): boolean {
  return isApproved(extractStatus(content));
}

function parseScopeSection(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const scope: string[] = [];
  let inScope = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inScope = /^##\s+scope\b/i.test(line);
      continue;
    }
    if (!inScope) continue;
    // Only list items declare scope. Explanatory prose in the Scope section
    // (e.g. "anything outside this — `db.ts`, `cache.ts` — is out of plan") must
    // NOT leak its example paths into the scope, or those changes look in-plan.
    if (!/^\s*[-*]\s/.test(line)) continue;
    for (const m of line.matchAll(/`([^`]+\.[a-z0-9]+)`/gi)) {
      // A path (has a slash), or a root-level FILENAME: a plan may legitimately
      // scope `cli.ts` or `package.json`. Root-level demands a real extension
      // (alphabetic-first), so a backticked version like `v0.7.0` stays prose.
      if (m[1].includes("/") || /^[\w.-]+\.[a-z][a-z0-9]*$/i.test(m[1])) {
        scope.push(m[1]);
      }
    }
  }
  return [...new Set(scope)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Re-export so callers can pass a typed entry list if needed.
export type { RegistryEntry };
