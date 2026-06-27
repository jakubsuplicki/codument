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
import type { AnchorChange } from "./fingerprint.js";

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
  /** Features that depend on a changed feature and may need re-review. */
  dependents: DependentFeature[];
  /** Changed sources outside the approved plan scope (only when planScope set). */
  outOfPlan: string[];
  /** True when a plan scope was provided (so outOfPlan is meaningful). */
  planScoped: boolean;
  /** Shared-file symbols ownership could not resolve (fail-loud; see OwnershipLint). */
  ownershipLints: OwnershipLint[];
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

  for (const file of changedSources) {
    const precise = input.anchorChanges?.[file];
    if (precise !== undefined) {
      // PER-SYMBOL: each changed anchor resolves to exactly its owning feature.
      for (const ch of precise) {
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
      // Concept umbrellas wake at file grain whenever the file's content moved.
      if (precise.length > 0) wakeConcepts(file);
    } else {
      // FILE-GRAIN FALLBACK (coarse/non-TS, or anchors uncomputable): every
      // PRIMARY owner — feature or concept — wakes; related_sources never does.
      for (const key of featurePrimary.get(file) ?? []) wake(key, file);
      wakeConcepts(file);
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
    const aDocChanged = featureDocs.some((d) => changed.has(d));
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
    outOfPlan,
    planScoped,
    ownershipLints,
  };
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

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(plansDir, file), "utf-8");
    } catch {
      continue;
    }
    if (!isApprovedPlan(content)) continue;
    const scope = parseScopeSection(content);
    if (scope.length > 0) {
      return { plan: `docs/plans/${file}`, scope };
    }
  }
  return null;
}

function isApprovedPlan(content: string): boolean {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content);
  const frontmatter = fm ? fm[1] : content;
  return /^status:\s*approved\s*$/m.test(frontmatter);
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
      if (m[1].includes("/")) scope.push(m[1]);
    }
  }
  return [...new Set(scope)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Re-export so callers can pass a typed entry list if needed.
export type { RegistryEntry };
