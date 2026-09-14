import {
  computeDependentImpact,
  type DependentFeature,
  type DependentSummary,
} from "./change-state.js";
import { isTestPath } from "./exclusion-spec.js";
import { importedFiles } from "./import-graph.js";
import { parseInvariants } from "./invariant-check.js";
import { normalizeInputPath, type Registry, sourceNames } from "./registry.js";
import { DEFAULT_TEST_SEARCH_DIRS } from "./review-confirm.js";

export type TestAttributionKind = "invariant-pin" | "direct-import";

export interface TestAttribution {
  test: string;
  feature: string;
  via: TestAttributionKind;
}

export interface TestImpact {
  /** Every test path in the selected change, including deletions. */
  changedTests: string[];
  /** One row per feature the changed test supplies evidence for. */
  attributed: TestAttribution[];
  /** Tests for which neither authoritative signal produced a feature. */
  unattributed: string[];
  /** Downstream contracts reached from the attributed features. */
  dependents: DependentFeature[];
  /** Ranked, human-facing form of `dependents`. */
  dependentsSummary: DependentSummary[];
}

export interface TestImpactInput {
  changedPaths: readonly string[];
  registry: Registry;
  /** Reads from the same snapshot as `changedPaths`; null also represents deletion. */
  readText: (path: string) => string | null;
}

const sortStrings = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// Keep this aligned with the existing TypeScript import graph. Other test languages
// remain visible but unattributed until their import resolver exists; guessing from a
// filename would turn a weak convention into an ownership claim.
const supportsDirectImports = (path: string): boolean =>
  /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(path);

function resolveChangedPin(reference: string, changedTests: Set<string>, readText: TestImpactInput["readText"]): string | null {
  const normalized = normalizeInputPath(reference);
  // The same two locations the invariant runner resolves: an explicit repo path,
  // then the conventional tests/ root. First match wins, so duplicate basenames do
  // not fan one pin out into several invented claims.
  const candidates = DEFAULT_TEST_SEARCH_DIRS.map(dir => dir ? `${dir}/${normalized}` : normalized);
  if (!candidates.some(candidate => changedTests.has(candidate))) return null;
  for (const candidate of candidates) {
    if (readText(candidate) !== null) return changedTests.has(candidate) ? candidate : null;
  }
  // A surviving pin still identifies deleted evidence when no live candidate resolves.
  return candidates.find(candidate => changedTests.has(candidate)) ?? null;
}

function primaryFeaturesForSource(registry: Registry, source: string): string[] {
  const features: string[] = [];
  for (const [feature, entry] of Object.entries(registry.features)) {
    if (entry.primary_sources.some((registered) => sourceNames(registered, source))) {
      features.push(feature);
    }
  }
  return sortStrings(features);
}

/**
 * Attribute changed tests as evidence without feeding them into documentation
 * ownership. Explicit invariant pins are authoritative; supported direct imports
 * are consulted only when no pin names that test. Every unsupported or unresolved
 * test remains visible in `unattributed`.
 */
export function computeTestImpact(input: TestImpactInput): TestImpact {
  const changedTests = sortStrings(input.changedPaths.filter(isTestPath));
  if (changedTests.length === 0) {
    return {
      changedTests: [],
      attributed: [],
      unattributed: [],
      dependents: [],
      dependentsSummary: [],
    };
  }
  const changedSet = new Set(changedTests);
  const pinned = new Map<string, Set<string>>();

  for (const [feature, entry] of Object.entries(input.registry.features).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const doc = input.readText(entry.doc);
    if (doc === null) continue;
    for (const invariant of parseInvariants(doc)) {
      if (invariant.annotation.kind !== "pinned") continue;
      for (const pointer of invariant.annotation.pointers) {
        const test = resolveChangedPin(pointer.file, changedSet, input.readText);
        if (!test) continue;
        const features = pinned.get(test) ?? new Set<string>();
        features.add(feature);
        pinned.set(test, features);
      }
    }
  }

  const attributed: TestAttribution[] = [];
  const unattributed: string[] = [];
  for (const test of changedTests) {
    const pinnedFeatures = sortStrings(pinned.get(test) ?? []);
    if (pinnedFeatures.length > 0) {
      for (const feature of pinnedFeatures) {
        attributed.push({ test, feature, via: "invariant-pin" });
      }
      continue;
    }

    const content = input.readText(test);
    const importedFeatures = new Set<string>();
    if (content !== null && supportsDirectImports(test)) {
      for (const source of importedFiles(test, content)) {
        for (const feature of primaryFeaturesForSource(input.registry, source)) {
          importedFeatures.add(feature);
        }
      }
    }
    if (importedFeatures.size === 0) {
      unattributed.push(test);
      continue;
    }
    for (const feature of sortStrings(importedFeatures)) {
      attributed.push({ test, feature, via: "direct-import" });
    }
  }

  const dependencyImpact = computeDependentImpact(
    input.registry,
    attributed.map((item) => item.feature),
  );
  return { changedTests, attributed, unattributed, ...dependencyImpact };
}
