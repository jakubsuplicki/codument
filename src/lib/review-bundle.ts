import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChangeSet, type ChangeSetBinding, changeSetBinding } from "./change-set.js";
import {
  type ApprovedPlan,
  type ChangeState,
  computeDependentImpact,
  type DependentSummary,
  mergeDependentSummaries,
  type RiskTouch,
  type StaleDoc,
} from "./change-state.js";
import { parseRegistryOrThrow, type Registry } from "./registry.js";
import { ownersOfFile, selectPlanFeatures } from "./context-pack.js";
import {
  getWorkingTreeChanges,
  getWorkingTreeDeletions,
  getHeadSha,
  resolveWorkspace,
  repoFor,
} from "./git.js";
import { readBlobAtRef, EMPTY_TREE_SHA } from "./two-ref.js";
import { isSourceFile } from "./exclusion-spec.js";
import type { ReviewFinding } from "./review-artifact.js";
import type { TestImpact } from "./test-impact.js";

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
  before?: { doc: string; contract: string; invariants: string; testPointers: string[] };
}

export interface ContractChange {
  path: string;
  owners: string[];
  kind: "documentation" | "instruction";
  before: string | null;
  after: string | null;
  testPointers: string[];
  requiresReview: boolean;
}

export interface ReviewGrounding {
  changes: ContractChange[];
  selected: string[];
  unowned: string[];
  previousRegistry: Registry;
  previousDocs: Map<string, string>;
}

const CONTRACT_LAYERS = [
  "In plain terms",
  "Design approach",
  "Invariants & boundaries",
  "Decisions",
  "Context",
  "Decision",
  "Consequences",
];
const normalizedProse = (text: string): string =>
  text
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim();

/** Conservative textual comparison: housekeeping is known, semantic equivalence is not. */
export function protectedDocContract(text: string): string {
  const layers = CONTRACT_LAYERS.flatMap((heading) => {
    const body = extractDocSection(text, heading).trim();
    return body ? [`${heading}\n${body}`] : [];
  });
  const keyFiles = extractDocSection(text, "Key files").replace(
    /^(\s*[-*]\s+)(?:`[^`]+`|\[[^\]]+\]\([^)]*\)|[\w./-]+\.[a-z0-9]+)(?=\s|$)/gim,
    "$1<path>",
  );
  return [...layers, keyFiles].join("\n");
}

export function buildContractChanges(input: {
  paths: string[];
  registry: Registry;
  previousRegistry: Registry;
  before: Map<string, string>;
  after: Map<string, string>;
  ignoredPaths?: string[];
}): ContractChange[] {
  const docPaths = new Set(
    [
      ...Object.values(input.registry.features),
      ...Object.values(input.previousRegistry.features),
    ].map((entry) => entry.doc),
  );
  const isDoc = (path: string): boolean => docPaths.has(path) || /^docs\/.*\.md$/i.test(path);
  const isInstruction = (path: string): boolean =>
    !isDoc(path) &&
    (ownersOfFile(input.registry, path).length > 0 ||
      ownersOfFile(input.previousRegistry, path).length > 0) &&
    /(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$|(?:^|\/)(?:agents|rules|skills)\/.*\.md$/i.test(path);
  const unchangedInstruction = (path: string): boolean =>
    isInstruction(path) &&
    input.before.has(path) &&
    input.after.has(path) &&
    normalizedProse(input.before.get(path)!) === normalizedProse(input.after.get(path)!);
  const ignored = new Set(input.ignoredPaths ?? []);
  const docsOnly = input.paths.every(
    (path) => isDoc(path) || unchangedInstruction(path) || ignored.has(path),
  );
  const out: ContractChange[] = [];
  for (const path of sortStrings(input.paths)) {
    const owners = sortStrings([
      ...ownersOfFile(input.registry, path),
      ...ownersOfFile(input.previousRegistry, path),
    ]);
    const doc = isDoc(path);
    const instruction = isInstruction(path);
    if (!doc && !instruction) continue;
    const was = input.before.get(path) ?? null;
    const now = input.after.get(path) ?? null;
    const before = doc && was !== null ? protectedDocContract(was) : was;
    const after = doc && now !== null ? protectedDocContract(now) : now;
    const material = normalizedProse(before ?? "") !== normalizedProse(after ?? "");
    const invariantChanged =
      normalizedProse(extractDocSection(was ?? "", "Invariants & boundaries")) !==
      normalizedProse(extractDocSection(now ?? "", "Invariants & boundaries"));
    if (!material && !instruction) continue;
    out.push({
      path,
      owners,
      kind: doc ? "documentation" : "instruction",
      before,
      after,
      testPointers: extractTestPointers(`${before ?? ""}\n${after ?? ""}`),
      requiresReview: material && (instruction || invariantChanged || docsOnly),
    });
  }
  return out;
}

export function gatherReviewGrounding(
  root: string,
  base: string,
  registry: Registry,
  paths: string[],
  readText?: (path: string) => string | null,
  scope: string[] = [],
  ignoredPaths: string[] = [],
  boundary?: ChangeSet,
): ReviewGrounding {
  const workspace = resolveWorkspace(root);
  const readBefore = (path: string): string | null => {
    const owner = repoFor(workspace, path);
    if (!owner) return null;
    const selectedBase = boundary
      ? boundary.bases.find((entry) => entry.prefix === owner.member.prefix)?.sha
      : workspace.isWorkspace ? "HEAD" : base;
    if (
      !selectedBase ||
      selectedBase === EMPTY_TREE_SHA ||
      (selectedBase === "HEAD" && !getHeadSha(owner.member.root))
    )
      return null;
    return readBlobAtRef(root, selectedBase, path);
  };
  const previousRaw = readBefore("docs/.registry.json");
  const previousRegistry =
    previousRaw === null
      ? { features: {} }
      : parseRegistryOrThrow(previousRaw, `docs/.registry.json@${base}`);
  const previousDocs = new Map<string, string>();
  const after = new Map<string, string>();
  const selected = sortStrings([
    ...selectPlanFeatures(registry, [], [...paths, ...scope]).selected,
    ...selectPlanFeatures(previousRegistry, [], [...paths, ...scope]).selected,
  ]);
  const candidates = sortStrings([
    ...paths,
    ...selected.flatMap((slug) =>
      [registry.features[slug]?.doc, previousRegistry.features[slug]?.doc].filter(
        (path): path is string => Boolean(path),
      ),
    ),
  ]);
  for (const path of candidates) {
    if (!path.endsWith(".md")) continue;
    const was = readBefore(path);
    if (was !== null) previousDocs.set(path, was);
    let now: string | null;
    if (readText) now = readText(path);
    else {
      try {
        now = readFileSync(join(root, path), "utf8");
      } catch {
        now = null;
      }
    }
    if (now !== null) after.set(path, now);
  }
  const unowned = paths.filter(
    (path) =>
      !ignoredPaths.includes(path) &&
      isSourceFile(path) &&
      !ownersOfFile(registry, path).length &&
      !ownersOfFile(previousRegistry, path).length,
  );
  return {
    selected,
    unowned,
    previousRegistry,
    previousDocs,
    changes: buildContractChanges({
      paths,
      registry,
      previousRegistry,
      before: previousDocs,
      after,
      ignoredPaths,
    }),
  };
}

export interface ReviewBundle {
  /** The ref the diff is computed against; the reviewer runs `git diff <base>`. */
  base: string;
  /** `full` — attack the whole change set (no prior review to measure against, or
   *  `--full` was asked for). `delta` — a prior review of this same base exists and
   *  only `changedSources` has moved since; the rest is in `alreadyReviewed`. The
   *  gate is identical either way: it still demands one artifact covering every byte
   *  of the change set, so a delta narrows what is READ, never what is ACCEPTED. */
  scope: "full" | "delta";
  /** The paths this round must attack. Under `full` scope, the changed source files.
   *  Under `delta` scope, every path — source or not — that moved since the last
   *  recorded review. */
  changedSources: string[];
  /** Under `delta` scope: paths a prior review already attacked and that have not
   *  moved since. Context, not a pass — read them to judge whether the delta breaks
   *  something they rely on. Empty under `full` scope. */
  alreadyReviewed: string[];
  /** Under `delta` scope: the findings that prior review raised, so this round can
   *  check the fixes actually fixed them. Empty under `full` scope. */
  priorFindings: ReviewFinding[];
  /** Changed files no adapter can judge that a feature/concept nonetheless OWNS, so
   *  the gate governs them at file grain (ADR 017) — locale packs, registered config,
   *  content files. They are part of this round's attack surface and are named
   *  separately because the reviewer must read them differently: there is no symbol
   *  diff to reason about, so the question is whether the file's CONTENT still matches
   *  what its owning doc promises. Under `delta` scope they also appear in
   *  `changedSources` when they moved. */
  governedRegistered: string[];
  /** Per touched feature: its contract, invariants, and test oracle. */
  features: ReviewBundleFeature[];
  contractChanges?: ContractChange[];
  omissions?: Array<{ input: string; reason: "unowned" | "unreadable-doc" | "unknown-feature" }>;
  /** Docs whose owned source moved but whose prose did not — must be addressed. */
  staleDocs: StaleDoc[];
  /** Risk-tagged features the diff touched (review these harder). */
  riskTouches: RiskTouch[];
  /** Features downstream of a changed feature (integration may need re-checking),
   *  collapsed to one entry per feature and ranked — features depending on a changed
   *  FEATURE first, then ones riding only a concept umbrella. The bundle carries the
   *  summary rather than the raw edge pairs on purpose: the bundle exists to hand the
   *  adversary a bounded contract, and dozens of unranked reason-less pairs is the
   *  opposite of bounded. */
  dependents: DependentSummary[];
  /** Changed sources outside the approved plan scope (scope creep is a finding). */
  outOfPlan: string[];
  /** The approved plan in force, when detectable. */
  plan: { path: string; scope: string[]; planId?: string; approvalDigest?: string } | null;
  /** Exact focused projection handed to the reviewer. Omitted from legacy bundles. */
  boundary?: ChangeSetBinding;
  /** Changed tests as evidence, including their attribution or explicit lack of one. */
  testImpact?: TestImpact;
  /** A digest of everything above — what this bundle handed over, as one token a
   *  reviewer copies into its findings so the recorded attestation says what it was
   *  grounded in. Without it an artifact records only a verdict: which invariants
   *  the reviewer was shown, which tests it was pointed at, and which files it was
   *  told to attack all went unrecorded, so a review of a stale or empty oracle is
   *  indistinguishable from a thorough one. Derived from the bundle's own content,
   *  so it is reproducible and no reviewer can mint one. */
  stamp: string;
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
  for (const line of content.split(/\r?\n/)) {
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
      inSection =
        h2[1]
          .replace(/\s+#+\s*$/, "")
          .trim()
          .toLowerCase() === target;
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

// What a test file is called, in one place, so every reader of a doc agrees on the
// shape of the thing it is looking for and they differ only in WHERE they look.
const TEST_FILE_TOKEN = /([\w./-]+\.test\.tsx?)\b/g;

// Extract the test files an invariants section cites — `foo.test.ts`,
// `path/to/bar.test.tsx` — deduped and sorted. These are the reviewer's
// runnable oracle: a finding that claims an invariant is broken should make one
// of these (or a new test) go red.
export function extractTestPointers(sectionText: string): string[] {
  const found: string[] = [];
  for (const m of sectionText.matchAll(TEST_FILE_TOKEN)) {
    found.push(m[1]);
  }
  return sortStrings(found);
}

// A doc's structural test-pin marker: the `*(test: …)*` / `*(tests: …)*` span the
// documentation standard uses to attach an invariant to the test that enforces it.
const PIN_SPAN = /\*\(tests?:([\s\S]*?)\)\*/g;

/**
 * The test files an invariants section PINS — cited inside the standard's own
 * `*(test: …)*` marker, not merely named somewhere in the prose.
 *
 * Structural on purpose, and the difference from `extractTestPointers` is the whole
 * point. That one hands a reviewer everything the section mentions, which is right
 * for an oracle: a spare name costs a reader nothing. This one feeds a FINDING, and
 * a finding needs a claim the doc actually made. Loosening the grammar to any
 * sentence naming a test file turns a citation into a lexical guess — which means
 * the honest limit is stated rather than closed: a bare-prose claim like "both are
 * pinned by X.test.tsx" stays uncaught here, because the doc never marked it as a
 * pin and inferring one from prose is the kind of judgment this gate does not make.
 */
export function extractPinnedTests(sectionText: string): string[] {
  const found: string[] = [];
  for (const span of sectionText.matchAll(PIN_SPAN)) {
    for (const m of span[1].matchAll(TEST_FILE_TOKEN)) found.push(m[1]);
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
  plan: ReviewBundle["plan"];
  /** When present the bundle is delta-scoped (see `ReviewBundle.scope`). The caller
   *  computes it from the last recorded review's per-file hashes; absent or null
   *  means full scope and a byte-identical bundle to the pre-delta behavior. */
  delta?: ReviewBundleDelta | null;
  boundary?: ChangeSetBinding;
  testImpact?: TestImpact;
  grounding?: ReviewGrounding;
}

export interface ReviewBundleDelta {
  /** Paths that moved since the last recorded review — what to attack. */
  paths: string[];
  /** Paths that prior review saw and that have not moved. */
  alreadyReviewed: string[];
  /** That review's findings, so the fixes can be checked. */
  priorFindings: ReviewFinding[];
}

function scopeTestImpact(
  testImpact: TestImpact,
  registry: Registry,
  delta?: ReviewBundleDelta | null,
): TestImpact {
  if (!delta) return testImpact;
  const selected = new Set(delta.paths);
  const attributed = testImpact.attributed.filter((attribution) => selected.has(attribution.test));
  return {
    changedTests: testImpact.changedTests.filter((test) => selected.has(test)),
    attributed,
    unattributed: testImpact.unattributed.filter((test) => selected.has(test)),
    ...computeDependentImpact(
      registry,
      attributed.map((item) => item.feature),
    ),
  };
}

// Pure, deterministic projection of a change-state into the reviewer's contract
// bundle. No I/O, no clock — same inputs, same bundle.
export function buildReviewBundle(input: ReviewBundleInput): ReviewBundle {
  const { base, changeState, registry, docContents, plan, delta, boundary, testImpact } = input;

  const features: ReviewBundleFeature[] = [];
  const sourceGroups = new Map(changeState.byFeature.map((group) => [group.feature, group.files]));
  const featureNames = sortStrings([
    ...sourceGroups.keys(),
    ...(testImpact?.attributed.map((attribution) => attribution.feature) ?? []),
    ...(input.grounding?.changes.flatMap((change) => change.owners) ?? []),
    ...(input.grounding?.selected ?? []),
    ...selectPlanFeatures(registry, [], plan?.scope ?? []).selected,
  ]);
  const omissions: NonNullable<ReviewBundle["omissions"]> = [];
  for (const path of input.grounding?.unowned ?? [])
    omissions.push({ input: path, reason: "unowned" });
  for (const path of selectPlanFeatures(registry, [], plan?.scope ?? []).unowned)
    omissions.push({ input: path, reason: "unowned" });
  for (const change of input.grounding?.changes ?? [])
    if (!change.owners.length) omissions.push({ input: change.path, reason: "unowned" });
  for (const feature of featureNames) {
    const entry = registry.features[feature] ?? input.grounding?.previousRegistry.features[feature];
    if (!entry) continue; // a group with no registry entry contributes no contract
    const previousEntry = input.grounding?.previousRegistry.features[feature];
    const previousText = previousEntry
      ? input.grounding?.previousDocs.get(previousEntry.doc)
      : undefined;
    if (!docContents.has(entry.doc)) omissions.push({ input: entry.doc, reason: "unreadable-doc" });
    const docText = docContents.get(entry.doc) ?? "";
    const invariants = extractDocSection(docText, "Invariants & boundaries").trim();
    features.push({
      feature,
      doc: entry.doc,
      contract: extractDocSection(docText, "In plain terms").trim(),
      invariants,
      testPointers: extractTestPointers(invariants),
      hasUntestedInvariant: /\((?:untested|planned|honest[ -](?:ceiling|boundary))\b/i.test(
        invariants,
      ),
      risk: sortStrings(entry.risk),
      changedSources: sortStrings(sourceGroups.get(feature) ?? []),
      ...(previousText !== undefined && previousEntry
        ? {
            before: {
              doc: previousEntry.doc,
              contract: extractDocSection(previousText, "In plain terms").trim(),
              invariants: extractDocSection(previousText, "Invariants & boundaries").trim(),
              testPointers: extractTestPointers(
                extractDocSection(previousText, "Invariants & boundaries"),
              ),
            },
          }
        : {}),
    });
  }

  const body = {
    base,
    scope: (delta ? "delta" : "full") as "full" | "delta",
    // Re-sorted here so the projection's determinism is self-guaranteed, not
    // merely inherited from computeChangeState's output ordering. The structured
    // facts below are passed through as the analyzer already ordered them.
    // The per-feature contract blocks above are NEVER scoped by the delta: the
    // reviewer keeps every touched feature's invariants and test pointers, because
    // narrowing the oracle is how a scoped review turns into a shallow one.
    changedSources: sortStrings(delta ? delta.paths : changeState.changedSources),
    alreadyReviewed: delta ? sortStrings(delta.alreadyReviewed) : [],
    priorFindings: delta ? delta.priorFindings : [],
    governedRegistered: sortStrings(changeState.governedRegistered),
    features,
    ...(input.grounding?.changes.length ? { contractChanges: input.grounding.changes } : {}),
    ...(omissions.length ? { omissions } : {}),
    staleDocs: changeState.staleDocs,
    riskTouches: changeState.riskTouches,
    dependents: mergeDependentSummaries(
      changeState.dependentsSummary,
      testImpact?.dependentsSummary ?? [],
    ),
    outOfPlan: changeState.outOfPlan,
    plan,
    ...(boundary ? { boundary } : {}),
    ...(testImpact ? { testImpact: scopeTestImpact(testImpact, registry, delta) } : {}),
  };
  // Over the body, never over itself. JSON.stringify walks the literal above in
  // declaration order, which is fixed here rather than inherited from any caller —
  // so the same repo state stamps identically on every machine and every run, the
  // same determinism every other digest in this system is held to.
  return { ...body, stamp: bundleStamp(body) };
}

/** The digest of a bundle's content. Exported so the writer and any checker share
 *  one definition — a second implementation of "what this bundle was" is how the
 *  stamp would come to mean two things. */
export function bundleStamp(body: Omit<ReviewBundle, "stamp">): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex").slice(0, 32);
}

/**
 * A digest of the ORACLE alone: per touched feature, the contract and the
 * invariants the bundle handed the reviewer.
 *
 * The review fingerprint bound the reviewed sources and the tests the findings
 * named, and stopped there. So the one thing the adversary was actually told to
 * attack — the documented contract and the must-not-break list — could be rewritten
 * after the review was recorded and the artifact went on covering the diff. A
 * review of invariants that no longer exist is not a review of this change, and it
 * is the shape the loop produces routinely, since updating the owning doc in the
 * same step is exactly what the workflow asks for.
 *
 * Taken from the bundle's own projection rather than re-derived from the docs, so
 * "the oracle" has one definition and the thing bound is literally the thing handed
 * over. It is folded into the review fingerprint as a SEPARATE component and never
 * into the real-change set: that set also counts the change's size, and the loop
 * requires the owning doc to move in the same step, so folding docs in would make
 * every compliant edit two real changes and retire the trivial fast-path the
 * proportionality rule exists to keep.
 */
export function oracleFingerprint(
  features: readonly ReviewBundleFeature[],
  plan?: ReviewBundle["plan"],
  changes?: ContractChange[],
  omissions?: ReviewBundle["omissions"],
): string {
  const parts = [...features]
    .sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0))
    // NUL-separated for the same reason the diff fingerprint uses it: doc prose
    // contains every other separator a scheme might pick, and NUL is the one
    // character that cannot appear in the feature name or the path beside it.
    .map(
      (f) =>
        `${f.feature}\0${f.doc}\0${f.contract}\0${f.invariants}${f.before ? `\0${JSON.stringify(f.before)}` : ""}`,
    );
  if (changes?.length) parts.push(JSON.stringify(changes));
  if (omissions?.length) parts.push(JSON.stringify(omissions));
  if (plan)
    parts.push(
      JSON.stringify({
        path: plan.path,
        scope: plan.scope,
        planId: plan.planId ?? null,
        approvalDigest: plan.approvalDigest ?? null,
      }),
    );
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex").slice(0, 32);
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
  delta?: ReviewBundleDelta | null,
  boundary?: ChangeSet,
  readText?: (path: string) => string | null,
  testImpact?: TestImpact,
  paths?: string[],
  ignoredPaths?: string[],
): ReviewBundle {
  const grounding = gatherReviewGrounding(
    root,
    base,
    registry,
    paths ??
      (boundary
        ? boundary.changes.map((change) => change.path)
        : [...getWorkingTreeChanges(root), ...getWorkingTreeDeletions(root)]),
    readText,
    plan?.scope,
    ignoredPaths ?? changeState.excludedChanged,
    boundary,
  );
  const docContents = new Map<string, string>();
  const featureNames = sortStrings([
    ...changeState.byFeature.map((group) => group.feature),
    ...(testImpact?.attributed.map((attribution) => attribution.feature) ?? []),
    ...grounding.changes.flatMap((change) => change.owners),
    ...grounding.selected,
    ...selectPlanFeatures(registry, [], plan?.scope ?? []).selected,
  ]);
  for (const feature of featureNames) {
    const entry = registry.features[feature] ?? grounding.previousRegistry.features[feature];
    if (!entry) continue;
    if (readText) {
      const content = readText(entry.doc);
      if (content !== null) docContents.set(entry.doc, content);
    } else {
      const docPath = join(root, entry.doc);
      if (!existsSync(docPath)) continue;
      try {
        docContents.set(entry.doc, readFileSync(docPath, "utf8"));
      } catch {
        // unreadable doc → empty contract for that feature, never a throw
      }
    }
  }
  return buildReviewBundle({
    base,
    changeState,
    registry,
    docContents,
    grounding,
    plan: plan
      ? {
          path: plan.plan,
          scope: plan.scope,
          ...(plan.planId ? { planId: plan.planId, approvalDigest: plan.approvalDigest } : {}),
        }
      : null,
    delta,
    ...(boundary ? { boundary: changeSetBinding(boundary) } : {}),
    ...(testImpact ? { testImpact } : {}),
  });
}
