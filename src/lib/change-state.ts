import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allSources,
  type Registry,
  type RegistryEntry,
} from "./registry.js";
import {
  DEFAULT_EXCLUSION_SPEC,
  isExcluded,
  isSourceFile,
  type ExclusionSpec,
} from "./analyze.js";
import { resolveOwner, splitAnchorId } from "./ownership.js";
import { fileContentTransition, type AnchorChange } from "./fingerprint.js";
import { ackCovers, isFileGrainAck, type Acknowledgment } from "./acknowledgment.js";
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
  /** Registry as of the base ref. Deleted files resolve ownership against this
   *  when provided (falling back to `registry`), so removing a file's registry
   *  entry in the same change cannot dodge the deletion wake — the entry that
   *  owned the file when it existed still flags its doc. */
  baseRegistry?: Registry;
}

export interface FeatureGroup {
  feature: string;
  files: string[];
}

export interface StaleDoc {
  feature: string;
  doc: string;
  changedSources: string[];
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
   *  the gate does not judge — outside the source-extension spec (.vue, .css,
   *  .json, …) or excluded by it (declaration artifacts, generated files). The
   *  registry says "load-bearing", the gate cannot judge them — fail-loud about
   *  the blind spot (info-only; never a strict verdict input). Their docs are
   *  named so a human/agent can verify by hand. */
  ungatedRegistered: UngatedRegisteredChange[];
}

export interface UngatedRegisteredChange {
  file: string;
  owners: { feature: string; doc: string }[];
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

  // Index: source path -> owning features, and feature -> its doc paths.
  const fileToFeatures = new Map<string, string[]>();
  for (const [key, entry] of entries) {
    for (const source of allSources(entry)) {
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

  // Registered-but-ungated: a file the registry explicitly claims (so someone
  // decided it matters to a doc) that the gate does not judge — because no
  // adapter recognizes its extension (.vue, .css) OR because the default spec
  // excludes it outright (a declaration artifact, a generated file). Built from
  // the full changed set, not the other-changed bucket: exclusion silences the
  // DEFAULT scope, but a registration is an explicit human claim, so silence for
  // a registered file would be a false "fresh" whatever dropped it.
  const entryByKey = new Map(entries);
  const changedSourceSet = new Set(changedSources);
  const ungatedRegistered: UngatedRegisteredChange[] = [];
  for (const file of sortStrings(changed)) {
    if (isDoc(file) || changedSourceSet.has(file)) continue;
    const owners = fileToFeatures.get(file);
    if (!owners || owners.length === 0) continue;
    ungatedRegistered.push({
      file,
      owners: owners
        .slice()
        .sort()
        .map((key) => ({ feature: key, doc: entryByKey.get(key)?.doc ?? "" })),
    });
  }

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
    for (const src of entry.primary_sources) {
      const list = idx.get(src) ?? [];
      if (!list.includes(key)) list.push(key);
      idx.set(src, list);
    }
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
          });
        } else if (res.kind === "ambiguous") {
          for (const o of res.owners) wake(o, file);
          ownershipLints.push({
            file,
            descriptor: splitAnchorId(ch.id).descriptor,
            kind: "ambiguous",
            features: res.owners,
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
    } else if (!acked) {
      // FILE-GRAIN FALLBACK (coarse/non-TS, or anchors uncomputable): every
      // PRIMARY owner — feature or concept — wakes; related_sources never does. A
      // covering file-grain ack clears the whole fallback wake (a coarse file has no
      // per-symbol move to protect — the ack is the file-grain judgment for it).
      for (const key of featurePrimary.get(file) ?? []) wake(key, file);
      wakeConcepts(file);
    }
  }

  // ── Deletions wake owners file-grain, with no ack fast-path ─────────────
  // A removed owned file is a real contract change: its owners' docs owe
  // attention (an update, or their own removal). Ownership resolves against the
  // BASE registry when provided, so deleting the registry entry in the same
  // change cannot dodge the wake — and an entry that no longer exists in the
  // current registry still flags its (base) doc below.
  const deletionRegistry = input.baseRegistry ?? registry;
  const deletionEntries = Object.entries(deletionRegistry.features);
  // base-only features woken by a deletion: key -> {docs, files} synthesized
  // into staleDocs after the main per-entry loop (which walks the CURRENT registry).
  const removedEntryWakes = new Map<string, { doc: string; docs: string[]; files: Set<string> }>();
  for (const file of deletedSources) {
    for (const [key, entry] of deletionEntries) {
      if (!entry.primary_sources.includes(file)) continue;
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
      staleDocs.push({
        feature: key,
        doc: entry.doc,
        changedSources: sortStrings(woken),
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
    staleDocs.push({ feature: key, doc: w.doc, changedSources: sortStrings(w.files) });
  }
  staleDocs.sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));

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
  };
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
// it exactly like a symbol ack.
export function resolveFileGrainAcked(
  root: string,
  base: string,
  changedFiles: string[],
  acks: Acknowledgment[],
  unevaluable: string[] = [],
): string[] {
  const fileAcks = acks.filter(isFileGrainAck);
  if (fileAcks.length === 0) return [];
  const ackedIds = new Set(fileAcks.map((a) => a.anchorId));
  const unevaluableSet = new Set(unevaluable);
  const covered: string[] = [];
  for (const file of changedFiles) {
    if (!ackedIds.has(file)) continue; // no file-grain ack names this path
    if (unevaluableSet.has(file)) continue; // parse-unevaluable is never acked fresh
    const { from, to } = fileContentTransition(root, base, file);
    if (from === null || to === null) continue; // added/deleted — no content transition
    if (fileAcks.some((a) => ackCovers(a, file, from, to))) covered.push(file);
  }
  return covered.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  const lines = content.split("\n");
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
