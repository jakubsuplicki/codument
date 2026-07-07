import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDocSection, extractTestPointers } from "./review-bundle.js";
import type { FeatureMapRow } from "./feature-map.js";
import type { Registry } from "./registry.js";

// The third projection over the registry, after the plan grounding (for the plan
// adversary) and the review bundle (for the review adversary). Where those serve
// a GATE, this serves the agent on any turn: given a feature, a file, or a plan,
// project the minimal grounded working set — the owning doc's orientation and
// invariant lines with their test pointers, the primary sources to read, and the
// one-hop dependencies — so an agent can PULL its relevant slice instead of
// being handed the whole tree. It adds NO source of truth: every field is read
// from docs/.registry.json and the committed feature docs. Same purity contract
// as the other two projections — a pure core over a passed-in doc map, an impure
// gather wrapper that does the reads.

/** How a selected working set was addressed. `value` echoes the selector input. */
export interface ContextSelector {
  kind: "feature" | "file" | "plan";
  value: string;
}

/** One feature in the pack. A `selected` entry carries its full orientation +
 *  invariants + sources; a `dependency` entry is a lightweight pointer (doc +
 *  the first sentence of its orientation), because a one-hop dependency is a
 *  "you may also need to read" signpost, not a payload to inline. */
export interface ContextEntry {
  feature: string;
  doc: string;
  relation: "selected" | "dependency";
  /** `## In plain terms`, verbatim for a selected entry; its first sentence for a
   *  dependency. Empty when the doc has no such section. */
  summary: string;
  /** `## Invariants & boundaries`, verbatim — selected entries only ("" for a
   *  dependency, which is a pointer, not an inlined contract). */
  invariants: string;
  /** Test files the invariants cite — the runnable oracle for this feature. */
  testPointers: string[];
  /** Sources this feature owns (what to read). Selected entries only. */
  primarySources: string[];
  /** Sources it touches but does not own (impact). Selected entries only. */
  relatedSources: string[];
  /** Its declared one-hop dependency edges. */
  dependsOn: string[];
  /** Risk tags (handle-with-care). Selected entries only. */
  risk: string[];
  /** ceil(chars/4) over this entry's rendered text — an estimate, never a meter. */
  estimatedTokens: number;
}

export interface ContextPack {
  selector: ContextSelector;
  /** Selected features first (sorted), then their one-hop dependencies (sorted).
   *  Head-first by priority so a budget can trim from the tail without dropping
   *  the thing the agent actually asked for. */
  entries: ContextEntry[];
  /** Selected slugs the registry does not know (feature/plan selectors) — a flag,
   *  not a fact, exactly like the plan grounding's `unknownFeatures`. */
  unknownFeatures: string[];
  /** A `--file` path no feature's `primary_sources` owns — surfaced, never guessed. */
  unmappedFile: string | null;
  /** For a `--plan` selector, malformed Feature-Map rows the parser rejected —
   *  surfaced (not silently dropped) so a typo'd row that routes nothing is a
   *  visible flag, exactly as an unknown slug is. Empty for other selectors. */
  planErrors: string[];
  /** Sum of every entry's estimate — the whole pack's rough size. */
  estimatedTokens: number;
}

// ceil(chars / 4): the same dependency-free estimate the token benchmark and the
// cost ledger use, so "estimated tokens" means one thing across the tool. Always
// an estimate — labeled as such at every render site.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// The first sentence of an orientation blurb — a dependency's one-line signpost.
// Stops at the first sentence terminator followed by whitespace; falls back to
// the first non-empty line, then the whole trimmed text, so it never returns
// empty when there is content.
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const collapsed = trimmed.replace(/\s+/g, " ");
  const m = /^(.*?[.!?])(\s|$)/.exec(collapsed);
  return (m ? m[1] : collapsed).trim();
}

// Estimate an entry's size from the text an agent would actually read: its
// orientation, its invariants, and the path/tag lists. Deterministic given the
// entry's content.
function entryTokens(e: Omit<ContextEntry, "estimatedTokens">): number {
  const parts = [
    e.doc,
    e.summary,
    e.invariants,
    ...e.primarySources,
    ...e.relatedSources,
    ...e.dependsOn,
    ...e.risk,
  ];
  return estimateTokens(parts.join("\n"));
}

function sortStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface ContextPackInput {
  selector: ContextSelector;
  /** The features the caller resolved the selector to (feature slugs). Their
   *  one-hop deps are derived here. */
  selected: string[];
  registry: Registry;
  /** Slugs the selector named that the registry does not know. */
  unknownFeatures: string[];
  /** A `--file` path that resolved to no owner, else null. */
  unmappedFile: string | null;
  /** Malformed Feature-Map rows for a `--plan` selector, pre-formatted. */
  planErrors: string[];
  /** doc path -> contents for every selected feature AND its one-hop deps. The
   *  impure reads live in `gatherContextPack`, keeping this pure. A doc absent
   *  from the map yields empty orientation/invariants for that feature. */
  docContents: Map<string, string>;
}

// Pure, deterministic projection. No I/O, no clock — same inputs, same pack.
export function buildContextPack(input: ContextPackInput): ContextPack {
  const { selector, registry, docContents } = input;
  const selected = sortStrings(input.selected.filter((s) => registry.features[s]));
  const selectedSet = new Set(selected);

  // One-hop dependency features: the depends_on edges of selected features that
  // are not themselves selected. One hop only — a dependency is a signpost, and
  // a transitive walk would inflate the pack past "minimal working set."
  const dependency = new Set<string>();
  for (const slug of selected) {
    for (const dep of registry.features[slug].depends_on) {
      if (!selectedSet.has(dep) && registry.features[dep]) dependency.add(dep);
    }
  }

  const entries: ContextEntry[] = [];

  const makeSelected = (slug: string): void => {
    const entry = registry.features[slug];
    const docText = docContents.get(entry.doc) ?? "";
    const invariants = extractDocSection(docText, "Invariants & boundaries").trim();
    const base = {
      feature: slug,
      doc: entry.doc,
      relation: "selected" as const,
      summary: extractDocSection(docText, "In plain terms").trim(),
      invariants,
      testPointers: extractTestPointers(invariants),
      // Re-sorted here so determinism is self-guaranteed, not merely inherited.
      primarySources: [...entry.primary_sources].sort(),
      relatedSources: [...entry.related_sources].sort(),
      dependsOn: [...entry.depends_on].sort(),
      risk: [...entry.risk].sort(),
    };
    entries.push({ ...base, estimatedTokens: entryTokens(base) });
  };

  const makeDependency = (slug: string): void => {
    const entry = registry.features[slug];
    const docText = docContents.get(entry.doc) ?? "";
    const base = {
      feature: slug,
      doc: entry.doc,
      relation: "dependency" as const,
      summary: firstSentence(extractDocSection(docText, "In plain terms")),
      invariants: "",
      testPointers: [],
      primarySources: [],
      relatedSources: [],
      dependsOn: [...entry.depends_on].sort(),
      risk: [],
    };
    entries.push({ ...base, estimatedTokens: entryTokens(base) });
  };

  for (const slug of selected) makeSelected(slug);
  for (const slug of [...dependency].sort()) makeDependency(slug);

  return {
    selector,
    entries,
    unknownFeatures: [...input.unknownFeatures].sort(),
    unmappedFile: input.unmappedFile,
    // Preserved in parse order (line-ascending, already deterministic) — not
    // sorted, so the line numbers still read top-to-bottom.
    planErrors: [...input.planErrors],
    estimatedTokens: entries.reduce((sum, e) => sum + e.estimatedTokens, 0),
  };
}

export interface BudgetResult {
  /** The pack after trimming, with `estimatedTokens` recomputed to match. */
  pack: ContextPack;
  /** Human labels of the tiers dropped, in drop order — surfaced so a budget
   *  never trims silently. Empty when the pack already fit. */
  trimmed: string[];
  /** True when even the un-trimmable head (the selected features' orientation +
   *  invariants) exceeds the budget — reported, never dropped: the head is the
   *  thing the caller asked for. */
  overBudget: boolean;
}

function trimField(
  entries: ContextEntry[],
  field: "risk" | "relatedSources" | "primarySources",
): boolean {
  let changed = false;
  for (const e of entries) {
    if (e.relation === "selected" && e[field].length > 0) {
      e[field] = [];
      changed = true;
    }
  }
  return changed;
}

// Trim a pack down toward a token budget, tail-first by the settled priority
// order (risk → related sources → dependency pointers → primary source lists),
// NEVER touching a selected feature's doc/orientation/invariants — the head is
// what the caller asked for and is reported even if it alone exceeds the budget.
// Pure: same pack + budget → same result. Coarse by tier (not partial-list) so
// the trim is legible in one "trimmed:" line rather than a silent truncation.
export function applyBudget(pack: ContextPack, budget: number): BudgetResult {
  let entries = pack.entries.map((e) => ({ ...e }));
  const total = () => entries.reduce((s, e) => s + e.estimatedTokens, 0);
  const recompute = () => {
    for (const e of entries) e.estimatedTokens = entryTokens(e);
  };
  const trimmed: string[] = [];

  const tiers: Array<{ label: string; apply: () => boolean }> = [
    { label: "risk tags", apply: () => trimField(entries, "risk") },
    { label: "related sources", apply: () => trimField(entries, "relatedSources") },
    {
      label: "dependency pointers",
      apply: () => {
        const had = entries.some((e) => e.relation === "dependency");
        entries = entries.filter((e) => e.relation !== "dependency");
        return had;
      },
    },
    { label: "primary source lists", apply: () => trimField(entries, "primarySources") },
  ];

  for (const tier of tiers) {
    if (total() <= budget) break;
    if (tier.apply()) {
      recompute();
      trimmed.push(tier.label);
    }
  }

  const estimatedTokens = total();
  return {
    pack: { ...pack, entries, estimatedTokens },
    trimmed,
    overBudget: estimatedTokens > budget,
  };
}

// Resolve a `--file` path to the features that OWN it: every entry (feature or
// concept umbrella) carrying the path in `primary_sources`. Related-source
// membership is impact, not ownership, so it never selects — the same
// primary-only rule the staleness gate uses.
export function ownersOfFile(registry: Registry, file: string): string[] {
  const owners: string[] = [];
  for (const [slug, entry] of Object.entries(registry.features)) {
    if (entry.primary_sources.includes(file)) owners.push(slug);
  }
  return owners.sort();
}

// The feature slugs a plan's Feature Map routes to: every row's primary owner
// plus its secondaries. Rows the registry does not know are still selected here
// and surface as `unknownFeatures` downstream (a flag, not silently dropped).
export function selectedFromPlanRows(rows: FeatureMapRow[]): string[] {
  const slugs = new Set<string>();
  for (const row of rows) {
    slugs.add(row.feature);
    for (const sec of row.secondary) slugs.add(sec);
  }
  return [...slugs].sort();
}

export type ContextResolution =
  | { kind: "feature"; input: string; selected: string[]; unknownFeatures: string[]; unmappedFile: null; planErrors: string[] }
  | { kind: "file"; input: string; selected: string[]; unknownFeatures: string[]; unmappedFile: string | null; planErrors: string[] }
  | { kind: "plan"; input: string; selected: string[]; unknownFeatures: string[]; unmappedFile: null; planErrors: string[] };

// Impure wrapper: resolve the selector against the registry, read each in-scope
// doc (selected features + their one-hop deps) off disk, then build the pure
// pack. Kept thin and beside the pure core, exactly like `gatherPlanGrounding`.
export function gatherContextPack(
  root: string,
  registry: Registry,
  resolution: ContextResolution,
): ContextPack {
  // The selector echoes the caller's INPUT (the feature slug, file path, or plan
  // path they typed), not what it resolved to — so `context --file src/x.ts`
  // reports the file it was asked about, not the feature that owns it.
  const selector: ContextSelector = { kind: resolution.kind, value: resolution.input };

  // Every doc we may read: selected features plus their one-hop deps.
  const slugs = new Set(resolution.selected.filter((s) => registry.features[s]));
  for (const slug of [...slugs]) {
    for (const dep of registry.features[slug].depends_on) {
      if (registry.features[dep]) slugs.add(dep);
    }
  }

  const docContents = new Map<string, string>();
  for (const slug of slugs) {
    const entry = registry.features[slug];
    const docPath = join(root, entry.doc);
    if (!existsSync(docPath)) continue;
    try {
      docContents.set(entry.doc, readFileSync(docPath, "utf8"));
    } catch {
      // unreadable doc → empty orientation/invariants for that feature, never a throw
    }
  }

  return buildContextPack({
    selector,
    selected: resolution.selected,
    registry,
    unknownFeatures: resolution.unknownFeatures,
    unmappedFile: resolution.kind === "file" ? resolution.unmappedFile : null,
    planErrors: resolution.planErrors,
    docContents,
  });
}
