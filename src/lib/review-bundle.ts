import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry.js";
import type {
  ApprovedPlan,
  ChangeState,
  DependentFeature,
  RiskTouch,
  StaleDoc,
} from "./change-state.js";

// The contract an adversarial reviewer attacks against. The whole point of the
// bundle is to give the reviewer an ORACLE instead of an open-ended hunt: for
// every feature the diff touched we surface its documented invariants and the
// tests that pin them, plus the deterministic blast facts (stale docs, risk,
// dependents, out-of-plan). It adds NO new source of truth — every field is
// derived from committed docs and the change-state — so the bundle is a pure,
// reproducible projection, never a judgment.

/** One touched feature's contract, as the reviewer should check it. */
export interface ReviewBundleFeature {
  feature: string;
  doc: string;
  /** The feature's contract summary (`## In plain terms`), trimmed. */
  contract: string;
  /** The raw `## Invariants & boundaries` section — the must-not-break list. */
  invariants: string;
  /** Test files the invariants section cites: the oracle the reviewer can run. */
  testPointers: string[];
  /** True when an invariant is explicitly marked with a no-test idiom —
   *  `(untested`, `(planned`, `(honest ceiling`, `(honest boundary` — a soft spot
   *  the reviewer should weigh harder, since no test guards it. Matched on the
   *  exact idioms so ordinary prose ("(honestly, …)") is not misflagged. */
  hasUntestedInvariant: boolean;
  /** Risk tags from the registry entry. */
  risk: string[];
  /** The changed source files that put this feature in scope. */
  changedSources: string[];
}

export interface ReviewBundle {
  /** The ref the diff is computed against; the reviewer runs `git diff <base>`. */
  base: string;
  /** Repo-relative changed source files. */
  changedSources: string[];
  /** Per touched feature: its contract, invariants, and test oracle. */
  features: ReviewBundleFeature[];
  /** Docs whose owned source moved but whose prose did not — must be addressed. */
  staleDocs: StaleDoc[];
  /** Risk-tagged features the diff touched (review these harder). */
  riskTouches: RiskTouch[];
  /** Features downstream of a changed feature (integration may need re-checking). */
  dependents: DependentFeature[];
  /** Changed sources outside the approved plan scope (scope creep is a finding). */
  outOfPlan: string[];
  /** The approved plan in force, when detectable. */
  plan: { path: string; scope: string[] } | null;
}

function sortStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Pull a level-2 markdown section's body by heading text. A `## <heading>` line
// opens the section; the next `## ` (or `# `) heading closes it, while deeper
// `### ` subheadings stay inside. Mirrors change-state's `parseScopeSection`
// idiom but returns the raw body so callers can read or re-scan it.
export function extractDocSection(content: string, heading: string): string {
  const target = heading.trim().toLowerCase();
  const out: string[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of content.split("\n")) {
    // A fenced code block can hold lines that look like headings (shell prompts,
    // markdown examples). Track the fence so a `#`/`##` line inside one neither
    // opens nor closes a section — without this, a fenced `# foo` silently drops
    // the rest of the section body.
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (inSection) out.push(line);
      continue;
    }
    if (inFence) {
      if (inSection) out.push(line);
      continue;
    }
    const h2 = /^##\s+(.*?)\s*$/.exec(line);
    if (h2) {
      // strip an optional ATX closing run (`## Heading ##`) before comparing
      inSection = h2[1].replace(/\s+#+\s*$/, "").trim().toLowerCase() === target;
      continue;
    }
    if (/^#\s+/.test(line)) {
      inSection = false;
      continue;
    }
    if (inSection) out.push(line);
  }
  return out.join("\n");
}

// Extract the test files an invariants section cites — `foo.test.ts`,
// `path/to/bar.test.tsx` — deduped and sorted. These are the reviewer's
// runnable oracle: a finding that claims an invariant is broken should make one
// of these (or a new test) go red.
export function extractTestPointers(sectionText: string): string[] {
  const found: string[] = [];
  for (const m of sectionText.matchAll(/([\w./-]+\.test\.tsx?)\b/g)) {
    found.push(m[1]);
  }
  return sortStrings(found);
}

export interface ReviewBundleInput {
  base: string;
  changeState: ChangeState;
  registry: Registry;
  /** docPath -> file contents for every doc the builder may read. The impure
   *  reads happen in the caller (`gatherReviewBundle`), keeping this pure. A doc
   *  absent from the map yields an empty contract/invariants for that feature. */
  docContents: Map<string, string>;
  plan: { path: string; scope: string[] } | null;
}

// Pure, deterministic projection of a change-state into the reviewer's contract
// bundle. No I/O, no clock — same inputs, same bundle.
export function buildReviewBundle(input: ReviewBundleInput): ReviewBundle {
  const { base, changeState, registry, docContents, plan } = input;

  const features: ReviewBundleFeature[] = [];
  for (const group of changeState.byFeature) {
    const entry = registry.features[group.feature];
    if (!entry) continue; // a group with no registry entry contributes no contract
    const docText = docContents.get(entry.doc) ?? "";
    const invariants = extractDocSection(docText, "Invariants & boundaries").trim();
    features.push({
      feature: group.feature,
      doc: entry.doc,
      contract: extractDocSection(docText, "In plain terms").trim(),
      invariants,
      testPointers: extractTestPointers(invariants),
      hasUntestedInvariant: /\((?:untested|planned|honest[ -](?:ceiling|boundary))\b/i.test(invariants),
      risk: sortStrings(entry.risk),
      changedSources: sortStrings(group.files),
    });
  }

  return {
    base,
    // Re-sorted here so the projection's determinism is self-guaranteed, not
    // merely inherited from computeChangeState's output ordering. The structured
    // facts below are passed through as the analyzer already ordered them.
    changedSources: sortStrings(changeState.changedSources),
    features,
    staleDocs: changeState.staleDocs,
    riskTouches: changeState.riskTouches,
    dependents: changeState.dependents,
    outOfPlan: changeState.outOfPlan,
    plan,
  };
}

// Impure wrapper: read each touched feature's doc off disk, then build the pure
// bundle. Kept thin and beside the pure core, exactly like change-state pairs
// its analyzer with `detectApprovedPlanScope`.
export function gatherReviewBundle(
  root: string,
  base: string,
  changeState: ChangeState,
  registry: Registry,
  plan: ApprovedPlan | null,
): ReviewBundle {
  const docContents = new Map<string, string>();
  for (const group of changeState.byFeature) {
    const entry = registry.features[group.feature];
    if (!entry) continue;
    const docPath = join(root, entry.doc);
    if (!existsSync(docPath)) continue;
    try {
      docContents.set(entry.doc, readFileSync(docPath, "utf8"));
    } catch {
      // unreadable doc → empty contract for that feature, never a throw
    }
  }
  return buildReviewBundle({
    base,
    changeState,
    registry,
    docContents,
    plan: plan ? { path: plan.plan, scope: plan.scope } : null,
  });
}
