import type { ChangeState } from "./change-state.js";

// The verdict model: a pure classification of a ChangeState into the plain-words
// verdict the `watch` view leads with — `clean` / `drifting` / `at-risk` /
// `off-plan` — plus the named findings behind it. No I/O, no clock, no
// randomness: the same ChangeState always yields the same verdict, so the live
// view and a snapshot can never disagree. Cost is presented alongside the
// verdict (see CostModel) but never drives its severity — severity is about the
// safety of the change, not its price.

export type Severity = "clean" | "drifting" | "off-plan" | "at-risk";

/** Ascending order; the headline is the highest-severity status present.
 *  off-plan outranks drifting: a change outside the approved plan is a louder
 *  "look now" than docs lagging their code (and a hard pause in autopilot). */
export const SEVERITY_RANK: Record<Severity, number> = {
  clean: 0,
  drifting: 1,
  "off-plan": 2,
  "at-risk": 3,
};

export interface RiskFinding {
  /** The risk-tagged feature, or the shared file (for shared-infra). */
  subject: string;
  kind: "risk-tag" | "shared-infra";
  /** Registry risk tags (risk-tag kind), e.g. ["payments"]. */
  tags: string[];
  /** Fanout count (shared-infra kind). */
  features: number;
  /** Changed files behind this finding. */
  files: number;
  /** Aggravator note: the change shipped without touching any test. */
  noTest: boolean;
}

export interface DriftFinding {
  feature: string;
  doc: string;
}

export interface OffPlanFinding {
  /** Changed sources outside the approved plan scope. */
  files: string[];
}

export interface BlastRadius {
  /** Features this change touches. */
  touched: number;
  /** Total registry features (the denominator) — distinct from coverage. */
  total: number;
  /** Changed in-scope source files (file-grain numerator). Gives real
   *  resolution at low feature counts, where the feature ratio is a single bit. */
  touchedFiles: number;
  /** In-scope source files on disk (file-grain denominator). 0 when unknown. */
  totalFiles: number;
}

export interface Verdict {
  status: Severity;
  /** Plain-English enumeration of the active findings, severity-ordered. */
  gloss: string;
  risk: RiskFinding[];
  drift: DriftFinding[];
  offPlan: OffPlanFinding | null;
  blast: BlastRadius;
  /** New changed sources with no registry owner — surfaced as context, not a
   *  severity driver (a missing mapping isn't the same as a doc behind code). */
  unmapped: number;
  /** Registry entries left naming a path this change removed. Carried for the same
   *  reason `unmapped` is, and on the same terms: it blocks `--strict` but does not
   *  move the severity ladder, which grades whether the DOCS are behind the code.
   *  What it must never do is go unmentioned — a verdict that reads clean over a
   *  tree the gate refuses is the one way the live view and a snapshot can
   *  contradict each other. */
  registryPointers: number;
}

export interface VerdictOptions {
  /** Registry feature count — the blast-radius denominator. */
  totalFeatures: number;
  /** In-scope source-file count — the file-grain blast denominator. */
  inScopeSourceCount?: number;
  /** Any test/spec file among the changed sources (aggravator for risk). */
  testsTouched?: boolean;
  /** Fanout strictly above this escalates a shared file to a risk finding
   *  (default 5). Must be >= the `highFanoutThreshold` used to build the
   *  ChangeState (default 3): the verdict can only escalate files the state
   *  already flagged as high-fanout, so a lower value here silently misses some. */
  sharedInfraThreshold?: number;
}

export interface CostByFeature {
  feature: string;
  cost: number;
}

export interface CostModel {
  /** All-sessions total. */
  total: number;
  /** Sessions behind the total (provenance / proof of completeness). */
  sessions: number;
  /** Calendar span (first→last event) across those sessions, in hours, when
   *  known — wall-clock elapsed, not summed session time. */
  hours: number | null;
  /** Cost accrued since `watch` started (the live delta). */
  thisSession: number;
  /** Per-feature spend, caller-sorted (descending). */
  byFeature: CostByFeature[];
  /** False degrades the headline label to "captured · N of M". */
  complete: boolean;
  /** Sessions actually in the log (for the degraded label). */
  capturedSessions: number;
  /** Sessions on disk for the repo (for the degraded label). */
  knownSessions: number;
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A test/spec file by conventional path or filename. */
export function isTestFile(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec)\//i.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
    /_test\.[a-z0-9]+$/i.test(path)
  );
}

/** Dollars with thousands separators and cents, locale-free (no Intl). */
export function formatCost(n: number): string {
  const fixed = Math.abs(n).toFixed(2);
  const [intPart, frac] = fixed.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // Show a minus only once the magnitude actually rounds to a non-zero amount,
  // so a tiny negative delta never renders as "-$0.00".
  const sign = n < 0 && fixed !== "0.00" ? "-" : "";
  return `${sign}$${withCommas}.${frac}`;
}

function formatHours(h: number): string {
  // Scale the unit to the magnitude: minutes for a short span, hours up to a
  // couple of days, then days — a summed multi-week span reads far better as
  // "20d" than "487h".
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The cost headline's provenance line. When capture is complete the session
 * count is the proof ("4 sessions · 164h"); when it isn't, the label degrades to
 * an explicit "captured · N of M sessions" rather than a silently-wrong total.
 */
export function costProvenance(c: CostModel): string {
  if (!c.complete) {
    return `captured · ${c.capturedSessions} of ${c.knownSessions} sessions`;
  }
  const parts = [plural(c.sessions, "session")];
  if (c.hours != null && c.hours > 0) parts.push(formatHours(c.hours));
  return parts.join("  ·  ");
}

function riskGloss(risk: RiskFinding[]): string | null {
  if (risk.length === 0) return null;
  const tagged = risk.filter((r) => r.kind === "risk-tag");
  const shared = risk.filter((r) => r.kind === "shared-infra");
  const pieces: string[] = [];
  if (tagged.length > 0) {
    const tags = [...new Set(tagged.flatMap((r) => r.tags))].sort();
    const subject = tags.length > 0 ? tags.join(", ") : "risk code";
    const noTest = tagged.some((r) => r.noTest);
    pieces.push(`${subject} touched${noTest ? " with no test" : ""}`);
  }
  if (shared.length > 0) {
    // Summarize by the worst fanout; the findings list shows each shared file.
    const maxF = Math.max(...shared.map((r) => r.features));
    pieces.push(`shared code touched (${plural(maxF, "feature")})`);
  }
  return pieces.join(" · ");
}

function buildGloss(v: Verdict, state: ChangeState): string {
  // A registry entry naming a path this change removed blocks `--strict` without
  // moving the severity ladder, so it has to ride EVERY gloss rather than one
  // branch of it. The state it turns up in most often — a deletion whose owning doc
  // WAS updated — has nothing else left to report, so the view announced a tidy
  // little change over a tree the gate refuses. `review` and `watch` deriving from
  // one analyzer is worth nothing if the projection drops a blocking finding.
  const pointers =
    v.registryPointers > 0 ? plural(v.registryPointers, "stale registry pointer") : "";
  const withPointers = (s: string): string => (pointers ? `${s} · ${pointers}` : s);
  if (v.status === "clean") {
    const parts: string[] = [];
    if (v.blast.touched > 0) {
      parts.push(`${plural(v.blast.touched, "feature")} touched`, "docs current");
      if (state.planScoped) parts.push("in plan");
    }
    // Unmapped changes don't escalate severity, but a clean verdict must not
    // claim "clean" while undocumented new files are sitting there.
    if (v.unmapped > 0) parts.push(plural(v.unmapped, "unmapped file"));
    const other = state.otherChanged.length;
    if (parts.length > 0) {
      // Source was touched cleanly, but config/asset files also changed — note
      // them so the gloss accounts for the whole tree, not just governed files.
      if (other > 0) parts.push(`+${plural(other, "other file")}`);
      return withPointers(parts.join(" · "));
    }
    // Nothing codument governs was touched — but a doc-only or config/asset change
    // still isn't an empty tree; never claim "working tree clean" while real files
    // sit uncommitted (the false-clean a stranger would catch on a screenshot).
    if (state.changedDocs.length > 0) {
      const docs = `${plural(state.changedDocs.length, "doc")} updated · no source changes`;
      return withPointers(other > 0 ? `${docs} · +${plural(other, "other file")}` : docs);
    }
    if (other > 0) {
      return withPointers(`${plural(other, "file")} changed · not source or docs`);
    }
    // The same false-clean this branch already guards against, one bucket further
    // out: a step that edited only its tests has a working tree that is not clean,
    // and saying so is the whole job of a live verdict line.
    if (state.excludedChanged.length > 0) {
      return withPointers(
        `${plural(state.excludedChanged.length, "excluded file")} changed · nothing codument governs`,
      );
    }
    return pointers || "working tree clean";
  }
  // Non-clean: enumerate active findings in descending severity.
  const pieces: string[] = [];
  const r = riskGloss(v.risk);
  if (r) pieces.push(r);
  if (v.offPlan) pieces.push(`${plural(v.offPlan.files.length, "file")} off-plan`);
  if (v.drift.length > 0) pieces.push(`${plural(v.drift.length, "doc")} now behind code`);
  if (pointers) pieces.push(pointers);
  return pieces.join(" · ");
}

/**
 * Classify a ChangeState into a verdict + named findings per the locked grammar:
 *  - at-risk (■): a risk-tagged feature was touched, or a shared file fans out
 *    past the threshold. Always escalates — a *tested* risk touch still earns a
 *    look; "no test" is only an aggravator note.
 *  - off-plan (⊘): changed sources outside the approved plan (plan-scoped only).
 *  - drifting (▲): a feature's source changed but its mapped doc did not.
 *  - clean (✓): none of the above.
 * The headline status is the single highest severity present.
 */
export function classifyVerdict(state: ChangeState, opts: VerdictOptions): Verdict {
  const sharedThreshold = opts.sharedInfraThreshold ?? 5;
  const testsTouched = opts.testsTouched ?? false;

  const risk: RiskFinding[] = [];
  for (const rt of state.riskTouches) {
    risk.push({
      subject: rt.feature,
      kind: "risk-tag",
      tags: rt.risk,
      features: 0,
      files: rt.files.length,
      noTest: !testsTouched,
    });
  }
  for (const hf of state.highFanout) {
    if (hf.features.length > sharedThreshold) {
      risk.push({
        subject: hf.file,
        kind: "shared-infra",
        tags: [],
        features: hf.features.length,
        files: 1,
        noTest: !testsTouched,
      });
    }
  }

  const drift: DriftFinding[] = state.staleDocs.map((s) => ({
    feature: s.feature,
    doc: s.doc,
  }));

  const offPlan: OffPlanFinding | null =
    state.planScoped && state.outOfPlan.length > 0 ? { files: state.outOfPlan } : null;

  const status: Severity =
    risk.length > 0
      ? "at-risk"
      : offPlan
        ? "off-plan"
        : drift.length > 0
          ? "drifting"
          : "clean";

  const verdict: Verdict = {
    status,
    gloss: "",
    risk,
    drift,
    offPlan,
    blast: {
      touched: state.byFeature.length,
      total: opts.totalFeatures,
      touchedFiles: state.changedSources.length,
      totalFiles: opts.inScopeSourceCount ?? 0,
    },
    unmapped: state.unmapped.length,
    registryPointers: state.registryPointers.length,
  };
  verdict.gloss = buildGloss(verdict, state);
  return verdict;
}
