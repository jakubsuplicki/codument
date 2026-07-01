import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDocSection, extractTestPointers } from "./review-bundle.js";
import type { Registry } from "./registry.js";
import type { FeatureMapRow } from "./feature-map.js";

// The oracle the PLAN adversary attacks against — the plan-time twin of the
// review bundle. Where the review bundle projects a *diff's* change-state into a
// contract, this projects a *plan's* Feature Map into the committed constraints
// the plan must honor: for every feature the Map routes to (and its declared
// dependencies) it surfaces that feature's documented invariants, the tests that
// pin them, its dependency edges, and its risk tags. It adds NO new source of
// truth — every field is read from docs/.registry.json and the committed feature
// docs — so an objection the adversary raises can cite a real, written fact
// instead of hallucinating one. Pure/impure split mirrors review-bundle.ts.

/** One in-scope feature's committed constraints, as the adversary should check them. */
export interface FeatureGrounding {
  feature: string;
  doc: string;
  /** How this feature entered scope: named by a Map row, or pulled in as a dependency. */
  relation: "routed" | "dependency";
  /** The raw `## Invariants & boundaries` section, trimmed; empty when the doc has none. */
  invariants: string;
  /** Test files the invariants cite — the constraints an objection can point at. */
  testPointers: string[];
  /** The feature's declared dependency edges (registry `depends_on`). */
  dependsOn: string[];
  /** Risk tags from the registry entry (handle-with-care features). */
  risk: string[];
}

export interface PlanGrounding {
  /** The constraints the plan must honor, one entry per in-scope feature. */
  features: FeatureGrounding[];
  /** Feature slugs a Map row named but the registry does not know — a flag, not a fact. */
  unknownFeatures: string[];
}

export interface PlanGroundingInput {
  /** The plan's parsed Feature Map rows (the routing table). */
  rows: FeatureMapRow[];
  registry: Registry;
  /** doc path -> contents for every in-scope feature's doc. The impure reads live
   *  in `gatherPlanGrounding`, keeping this a pure, reproducible projection. A doc
   *  absent from the map yields empty invariants for that feature, never a throw. */
  docContents: Map<string, string>;
}

/** The feature slugs a Feature Map names: every row's primary owner plus its
 *  secondaries. This is the plan's routing surface — the features it touches. */
function routedFeatures(rows: FeatureMapRow[]): Set<string> {
  const routed = new Set<string>();
  for (const row of rows) {
    routed.add(row.feature);
    for (const sec of row.secondary) routed.add(sec);
  }
  return routed;
}

// Pure, deterministic projection of a plan's Feature Map into the adversary's
// grounding. No I/O, no clock — same inputs, same grounding.
export function buildPlanGrounding(input: PlanGroundingInput): PlanGrounding {
  const { rows, registry, docContents } = input;

  const routed = routedFeatures(rows);

  // Dependency features: the depends_on edges of routed features that are not
  // themselves routed. A plan can contradict a constraint of a feature it depends
  // on without naming it, so these are grounded too — one hop, no transitive walk
  // (deeper edges are not constraints the plan directly touches).
  const dependency = new Set<string>();
  for (const slug of routed) {
    const entry = registry.features[slug];
    if (!entry) continue;
    for (const dep of entry.depends_on) {
      if (!routed.has(dep)) dependency.add(dep);
    }
  }

  const unknownFeatures = [...routed].filter((slug) => !registry.features[slug]).sort();

  const features: FeatureGrounding[] = [];
  const project = (slug: string, relation: FeatureGrounding["relation"]): void => {
    const entry = registry.features[slug];
    if (!entry) return; // unknown routed slugs are reported separately; unknown deps are dropped
    const docText = docContents.get(entry.doc) ?? "";
    const invariants = extractDocSection(docText, "Invariants & boundaries").trim();
    features.push({
      feature: slug,
      doc: entry.doc,
      relation,
      invariants,
      testPointers: extractTestPointers(invariants),
      // Re-sorted here so the projection's determinism is self-guaranteed, not
      // merely inherited from the registry normalizer's ordering.
      dependsOn: [...entry.depends_on].sort(),
      risk: [...entry.risk].sort(),
    });
  };

  for (const slug of [...routed].sort()) project(slug, "routed");
  for (const slug of [...dependency].sort()) project(slug, "dependency");

  return { features, unknownFeatures };
}

// Impure wrapper: read each in-scope feature's doc off disk, then build the pure
// grounding. Kept thin and beside the pure core, exactly like `gatherReviewBundle`.
export function gatherPlanGrounding(
  root: string,
  rows: FeatureMapRow[],
  registry: Registry,
): PlanGrounding {
  // Every slug whose doc we may need: routed features plus their one-hop deps.
  const slugs = routedFeatures(rows);
  for (const slug of [...slugs]) {
    const entry = registry.features[slug];
    if (entry) for (const dep of entry.depends_on) slugs.add(dep);
  }

  const docContents = new Map<string, string>();
  for (const slug of slugs) {
    const entry = registry.features[slug];
    if (!entry) continue;
    const docPath = join(root, entry.doc);
    if (!existsSync(docPath)) continue;
    try {
      docContents.set(entry.doc, readFileSync(docPath, "utf8"));
    } catch {
      // unreadable doc → empty invariants for that feature, never a throw
    }
  }

  return buildPlanGrounding({ rows, registry, docContents });
}
