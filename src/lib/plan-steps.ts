import { readFileSync, readdirSync } from "node:fs";
import { join, relative, isAbsolute, resolve, sep } from "node:path";
import { appendEvent, readRecentEvents } from "./events.js";
import { assessPlanApproval, readApprovalPolicy, readApprovalStore, type ApprovalAssessment } from "./plan-approval.js";
import { ConfigValueError } from "./state-io.js";

// Bridge between a Codument plan's durable checklist and the agent's live view.
// A plan doc owns the truth: the `## Delivery Plan` (or `Definition of Done`)
// section's `- [x]` / `- [ ]` items. This module parses that checklist so a
// `work-step` run can (1) mirror the steps into the host agent's native to-do
// panel (e.g. Claude Code's TodoWrite) and (2) log a `step` event that
// `codument watch` surfaces in its activity tape — without ever making the
// ephemeral to-do list the source of truth. The plan doc stays authoritative;
// the panel and the tape are one-way projections re-derived from it.
//
// Pure parsing is separated from the small fs/discovery and emit seams so the
// checkbox logic is exhaustively testable on plain strings.

export interface PlanStep {
  /** 1-based ordinal within the checklist (not parsed from "Step N" labels,
   *  which may be "Step 1a"). */
  n: number;
  /** Full label after the checkbox, e.g. "Step 3: Wire feed into watch". */
  text: string;
  done: boolean;
}

/** A native to-do status the JSON projection hands an agent so the mirror is a
 *  direct field copy rather than re-derived markdown. */
export type TodoStatus = "completed" | "in_progress" | "pending";

export interface ActivePlan {
  /** Repo-relative POSIX path to the plan doc. */
  path: string;
  /** Doc basename without extension — the label shown in `watch` (`plan:`). */
  planName: string;
  /** Cleaned, lowercased status string (frontmatter or a body `Status:` line). */
  status: string | null;
  approved: boolean;
  steps: PlanStep[];
  /** First unchecked step — the one a `work-step` run is implementing. */
  active: PlanStep | null;
  planId?: string | null;
  approval?: ApprovalAssessment;
}

// ── Pure parsing ─────────────────────────────────────────────────────────

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*\S)[ \t]*$/;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;

interface PlanSection {
  start: number;
  end: number;
  level: number;
  steps: PlanStep[];
}

/** Examples are not instructions. Keep line positions while excluding fenced
 *  and indented code, quotes, and comments from both status and checklist reads. */
function instructionLines(markdown: string): string[] {
  let fence: string | null = null;
  let quotedParagraph = false;
  return markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, " "))
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence !== null) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        ) {
          fence = null;
        }
        return "";
      }
      if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
        quotedParagraph = false;
        fence = marker[1];
        return "";
      }
      if (!line.trim() || HEADING.test(line) || /^ {0,3}(?:[-+*]|1[.)])[ \t]+\S/.test(line)) {
        quotedParagraph = false;
      }
      if (/^ {0,3}>/.test(line)) {
        quotedParagraph = true;
        return "";
      }
      return quotedParagraph || /^(?: {4}|\t)/.test(line) ? "" : line;
    });
}

/** Preserve section boundaries even for an empty plan: its status must never
 *  become another plan's fallback approval. Nested headings retain the checklist. */
function sectionSteps(lines: string[], match: RegExp): PlanSection[] {
  const sections: PlanSection[] = [];
  let current: PlanSection | null = null;
  for (const [index, line] of lines.entries()) {
    const h = HEADING.exec(line);
    if (h) {
      const depth = h[1].length;
      if (current && depth <= current.level) {
        current.end = index;
        current = null;
      }
      if (!current && match.test(h[2])) {
        current = { start: index, end: lines.length, level: depth, steps: [] };
        sections.push(current);
      }
      continue;
    }
    if (!current) continue;
    const c = CHECKBOX.exec(line);
    if (c) {
      current.steps.push({
        n: current.steps.length + 1,
        text: c[2],
        done: c[1].toLowerCase() === "x",
      });
    }
  }
  return sections;
}

function checkpointMask(lines: string[]): boolean[] {
  let depth: number | null = null;
  return lines.map((line) => {
    const heading = HEADING.exec(line);
    if (heading && depth !== null && heading[1].length <= depth) depth = null;
    if (heading && /^resume checkpoint\s*$/i.test(heading[2])) depth = heading[1].length;
    return depth !== null;
  });
}

/** One selection for approval and work. A standalone plan may use document
 *  metadata; an embedded plan's own declaration takes precedence. */
function planParts(markdown: string, planId?: string, allowMissing = false) {
  const raw = markdown.replace(/^\uFEFF/, "");
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(raw);
  const body = frontmatter
    ? raw.slice(frontmatter[0].length)
    : /^---[ \t]*\r?\n/.test(raw)
      ? ""
      : raw;
  const parsedLines = instructionLines(body);
  const checkpoints = checkpointMask(parsedLines);
  const lines = parsedLines.map((line, index) => checkpoints[index] ? "" : line);
  const delivery = sectionSteps(lines, /\bdelivery plan\b/i);
  const done = sectionSteps(lines, /\bdefinition of done\b/i);
  const candidates = delivery.some((section) => section.steps.length)
    ? delivery
    : done.length
      ? done
      : delivery;
  let selected =
    candidates.find((section) => section.steps.some((step) => !step.done)) ??
    [...candidates].reverse().find((section) => section.steps.length) ??
    candidates[candidates.length - 1];
  if (planId !== undefined) {
    const matches = candidates.filter((section) => sectionId(lines, section) === planId);
    if (matches.length !== 1 && !(allowMissing && matches.length === 0)) throw new ConfigValueError("plan", "plan-id", `expected one section named ${planId}, found ${matches.length}`);
    selected = matches[0];
  } else if (candidates.filter((section) => section.steps.some((step) => !step.done) && sectionId(lines, section)).length > 1) {
    throw new ConfigValueError("plan", "selection", "multiple identified plans have unfinished work; pass --plan-id <id>");
  }
  // Either supported heading kind can introduce separate work. Nested headings
  // stay inside their containing plan, while empty sibling plans still count.
  const sections = sectionSteps(lines, /\b(?:delivery plan|definition of done)\b/i);
  let titleSeen = false;
  const firstSection = lines.findIndex((line) => {
    const heading = HEADING.exec(line);
    if (!heading) return false;
    if (heading[1].length === 1 && !titleSeen) {
      titleSeen = true;
      return false;
    }
    return true;
  });
  const documentLines = [
    ...instructionLines(frontmatter?.[1] ?? "").filter((line) => !/^[ \t]/.test(line)),
    ...lines.slice(0, firstSection < 0 ? lines.length : firstSection),
  ];
  const bodyOffset = raw.slice(0, raw.length - body.length).split(/\r?\n/).length - 1;
  return { lines, sections, selected, documentLines, bodyOffset };
}

function sectionId(lines: string[], section: PlanSection): string | null {
  const declarations = lines.slice(section.start + 1, section.end).flatMap((line) => {
    const match = /^ {0,3}Plan-ID:[ \t]*(.*?)[ \t]*$/i.exec(line);
    return match ? [match[1]] : [];
  });
  if (declarations.length > 1 || declarations.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id))) {
    throw new ConfigValueError("plan", "Plan-ID", "use one identifier of letters, digits, underscores or hyphens");
  }
  return declarations[0] ?? null;
}

export function selectedPlanId(markdown: string, planId?: string): string | null {
  const { lines, selected } = planParts(markdown, planId);
  return selected ? sectionId(lines, selected) : null;
}

/** Detect removal of one identified plan while preserving sibling sections. */
export function hasPlanSection(markdown: string, planId: string): boolean {
  return planParts(markdown, planId, true).selected !== undefined;
}

/** Record identity only inside one unambiguous selected section. */
export function identifyPlan(markdown: string, id: string, planId?: string): string {
  const { lines, selected, sections, bodyOffset } = planParts(markdown, planId);
  if (!selected || (!planId && sections.filter((section) => section.steps.some((step) => !step.done)).length > 1)) {
    throw new ConfigValueError("plan", "selection", "name one section with Plan-ID and --plan-id before recording approval");
  }
  const existing = sectionId(lines, selected);
  if (existing) return markdown;
  const raw = markdown.replace(/\r\n/g, "\n").split("\n");
  raw.splice(selected.start + bodyOffset + 1, 0, `Plan-ID: ${id}`);
  return raw.join("\n");
}

/** Retain all selected intent, including examples, except explicit progress fields. */
export function planContractMarkdown(markdown: string, planId?: string): string {
  const { lines, selected, bodyOffset, sections } = planParts(markdown, planId);
  if (!selected) throw new ConfigValueError("plan", "contract", "no delivery plan section found");
  const localStatus = statusDeclarations(lines.slice(selected.start + 1, selected.end)).length > 0;
  const raw = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const start = localStatus || sections.length > 1 ? selected.start + bodyOffset : 0;
  const end = localStatus || sections.length > 1 ? selected.end + bodyOffset : raw.length;
  const instructions = instructionLines(raw.join("\n"));
  const result: string[] = [];
  let checkpointDepth: number | null = null;
  for (let i = start; i < end; i++) {
    const line = instructions[i];
    const heading = HEADING.exec(line);
    if (heading && checkpointDepth !== null && heading[1].length <= checkpointDepth) checkpointDepth = null;
    if (heading && /^resume checkpoint\s*$/i.test(heading[2])) checkpointDepth = heading[1].length;
    if (checkpointDepth !== null) continue;
    if (/^ {0,3}(?:[*_]*status|Plan-ID):/i.test(line)) continue;
    result.push(CHECKBOX.test(line) ? raw[i].replace(/\[[ xX]\]/, "[ ]") : raw[i]);
  }
  const map = selectedFeatureMapLines(markdown, planId);
  if (map.some((line, index) => line.length > 0 && (index < start || index >= end))) {
    result.push("", map.join("\n").replace(/^\n+|\n+$/g, ""));
  }
  return result.join("\n").replace(/^\n+|\n+$/g, "");
}

/** The exact consumed Map, keeping source positions for diagnostics and approval. */
export function selectedFeatureMapLines(markdown: string, planId?: string): string[] {
  const lines = selectedPlanMarkdown(markdown, planId).split(/\r?\n/);
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/^\s*```feature-map\s*$/.test(lines[index])) { start = index; break; }
  }
  if (start < 0) return lines.map(() => "");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*```\s*$/.test(lines[index])) { end = index + 1; break; }
  }
  return lines.map((line, index) => index >= start && index < end ? line : "");
}

function statusDeclarations(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const match = /^[ \t]{0,3}[*_]*status:\s*(.*?)\s*$/i.exec(line);
    return match ? [match[1].replace(/[*_`]/g, "").trim().toLowerCase()] : [];
  });
}

/** The plan's checklist: the active `Delivery Plan` section if present, else
 *  `Definition of Done`. Checkboxes outside the chosen section are ignored. */
export function parseDeliveryPlan(markdown: string, planId?: string): PlanStep[] {
  return planParts(markdown, planId).selected?.steps ?? [];
}

/** Bound plan-owned payloads to the selected section without changing source
 *  line numbers. A standalone document retains its sibling-section convention. */
export function selectedPlanMarkdown(markdown: string, planId?: string): string {
  const { selected, sections, bodyOffset } = planParts(markdown, planId);
  const checkpoints = checkpointMask(instructionLines(markdown));
  return markdown.split(/\r?\n/).map((line, index) =>
    !checkpoints[index] && (!selected || sections.length <= 1 || (index >= selected.start + bodyOffset && index < selected.end + bodyOffset)) ? line : "",
  ).join("\n");
}

/** First unchecked step, or null when the plan is complete/empty. */
export function activeStep(steps: PlanStep[]): PlanStep | null {
  return steps.find((s) => !s.done) ?? null;
}

/** Status belonging to the selected plan, never another section. A lone plan
 *  without local status retains the legacy document metadata convention.
 *  Repeated declarations are ambiguous even when their text agrees. */
export function extractStatus(markdown: string, planId?: string): string | null {
  const { lines, sections, selected, documentLines } = planParts(markdown, planId);
  let declarations: string[] = [];
  if (selected) {
    const local = lines.slice(selected.start + 1, selected.end);
    const subheading = local.findIndex((line) => HEADING.test(line));
    declarations = statusDeclarations(local.slice(0, subheading < 0 ? local.length : subheading));
    if (subheading >= 0 && statusDeclarations(local.slice(subheading)).length > 0) return null;
  }
  if (declarations.length === 0 && sections.length <= 1) {
    declarations = statusDeclarations(documentLines);
  }
  return declarations.length === 1 ? declarations[0] || null : null;
}

/** Scope follows the selected checklist. Only an unambiguous standalone plan
 *  may fall back to a sibling document-level Scope section. */
export function parsePlanScope(markdown: string, planId?: string): string[] {
  const { lines, sections, selected } = planParts(markdown, planId);
  const readScope = (source: string[], siblingOnly = false): string[] | null => {
    const paths = new Set<string>();
    let scopeDepth: number | null = null;
    let found = false;
    for (const line of source) {
      const heading = HEADING.exec(line);
      if (heading) {
        if (scopeDepth !== null && heading[1].length <= scopeDepth) scopeDepth = null;
        if (scopeDepth === null && (!siblingOnly || heading[1].length === 2) && /^scope\b/i.test(heading[2])) {
          scopeDepth = heading[1].length;
          found = true;
        }
        continue;
      }
      if (scopeDepth === null || !/^\s*[-*]\s/.test(line)) continue;
      for (const match of line.matchAll(/`([^`]+\.[a-z0-9]+)`/gi)) {
        if (match[1].includes("/") || /^[\w.-]+\.[a-z][a-z0-9]*$/i.test(match[1])) {
          paths.add(match[1]);
        }
      }
    }
    return found ? [...paths].sort() : null;
  };
  if (selected) {
    const selectedLines = lines.slice(selected.start + 1, selected.end);
    const local = readScope(selectedLines);
    if (local !== null) return local;
    if (statusDeclarations(selectedLines).length > 0) return [];
  }
  return sections.length <= 1 ? readScope(lines, true) ?? [] : [];
}

/** Approved means EXACTLY "approved" (after extractStatus's strip+lowercase).
 *  A word-boundary match here once made `Status: not approved` read as approved
 *  — the precise signal the workflow's approval gate and the autopilot
 *  precondition key off — so nothing looser than equality qualifies:
 *  "awaiting approval", "not approved", "never approved" are all not approved.
 *  This is the shared status predicate; recorded approvals additionally require
 *  a matching contract revision on every execution and scope surface. */
export function isApproved(status: string | null): boolean {
  return status === "approved";
}

/** Native to-do status for a step within its plan: done→completed,
 *  the active step→in_progress, everything else→pending. */
export function todoStatus(plan: ActivePlan, step: PlanStep): TodoStatus {
  if (step.done) return "completed";
  return plan.active && step.n === plan.active.n ? "in_progress" : "pending";
}

// ── Discovery (fs) ───────────────────────────────────────────────────────

// Where a plan may live. `docs/plans` is here because the gate already reads it:
// approved-plan SCOPE detection resolves over that directory, so a repository that
// keeps its plans there had `review` reporting the plan's scope in its headline while
// `steps` and `map materialize` refused with "no approved plan" on the line before —
// two halves of one loop disagreeing about where plans live, with both refusals
// reachable straight from the documented workflow. No directory is blessed; all three
// are read, and an approved plan in any of them is the same plan.
const PLAN_DIRS = ["docs/features", "docs/concepts", "docs/plans"];

/** Same supported locations for live discovery and Git snapshot readers. */
export function isPlanPath(path: string): boolean {
  return PLAN_DIRS.some((dir) => path.startsWith(`${dir}/`) && /^[^/]+\.md$/.test(path.slice(dir.length + 1)));
}

export function normalizePlanPath(root: string, path: string): string {
  const rel = relative(resolve(root), resolve(root, path)).split(sep).join("/");
  if (!isPlanPath(rel)) throw new ConfigValueError(path, "plan path", "choose a supported plan inside this repository");
  return rel;
}

export function readPlanDocuments(root: string): Array<{ path: string; content: string }> {
  const documents: Array<{ path: string; content: string }> = [];
  for (const dir of PLAN_DIRS) {
    let names: string[];
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    for (const name of names.sort()) {
      const path = `${dir}/${name}`;
      if (!isPlanPath(path)) continue;
      try { documents.push({ path, content: readFileSync(join(root, path), "utf8") }); } catch { /* unreadable */ }
    }
  }
  return documents.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function toActivePlan(root: string, abs: string, markdown?: string, planId?: string): ActivePlan | null {
  let md: string;
  try {
    md = markdown ?? readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
  const steps = parseDeliveryPlan(md, planId);
  const status = extractStatus(md, planId);
  const rel = relative(root, abs).split(sep).join("/");
  const base = rel.split("/").pop() ?? rel;
  const approval = assessPlanApproval(rel, md, readApprovalStore(root), readApprovalPolicy(root), planId);
  return {
    path: rel,
    planName: base.replace(/\.md$/i, ""),
    status,
    approved: isApproved(status) && approval.allowed,
    approval,
    planId: selectedPlanId(md, planId),
    steps,
    active: activeStep(steps),
  };
}

/** Read a specific plan doc (repo-relative or absolute). Null when unreadable. */
export function loadPlan(root: string, planPath: string, planId?: string): ActivePlan | null {
  return toActivePlan(root, isAbsolute(planPath) ? planPath : join(root, planPath), undefined, planId);
}

/** Approved plans under docs/features|concepts that still have an unchecked
 *  step, sorted by path. The single-element common case is the active plan; an
 *  empty or multi-element result tells the caller to ask for an explicit plan. */
export function findActivePlans(root: string): ActivePlan[] {
  return planCandidates(root).filter((plan) => plan.approved);
}

function planCandidates(root: string): ActivePlan[] {
  return readPlanDocuments(root).flatMap(({ path, content }) => {
    const plan = toActivePlan(root, join(root, path), content);
    return plan?.active ? [plan] : [];
  });
}

/** Discovery never grants approval or rewrites a declaration to make it fit. */
export function resolveActivePlan(root: string): { plan: ActivePlan } | { error: string } {
  const candidates = planCandidates(root);
  const approved = candidates.filter((plan) => plan.approved);
  if (approved.length === 1) return { plan: approved[0] };
  if (approved.length > 1) {
    return { error: `multiple approved plans with unchecked steps (${approved.map((plan) => plan.path).join(", ")}) — pass --plan <path>` };
  }
  const diagnostics = candidates.map((plan) =>
    `${plan.path}: ${plan.approval && !plan.approval.allowed ? plan.approval.reason : `${plan.status === null ? "missing or conflicting approval" : `status is ${JSON.stringify(plan.status)}`}; only after human approval, use Status: approved in the selected Delivery Plan`}`,
  );
  return { error: "no approved plan with an unchecked step under docs/features, docs/concepts or docs/plans — pass --plan <path>" + (diagnostics.length ? `\n${diagnostics.join("\n")}` : "") };
}

// ── Emit (events) ────────────────────────────────────────────────────────

export interface StepEmitResult {
  emitted: boolean;
  step: PlanStep | null;
}

/**
 * Append a `step` event for the plan's active step to .codument/events.jsonl so
 * `codument watch` shows the transition in its tape. Idempotent: if the most
 * recent `step` event for this plan already names the same step, nothing is
 * appended (so re-running `work-step`, or a watch loop, never spams the tape).
 */
export function emitActiveStep(root: string, plan: ActivePlan): StepEmitResult {
  const step = plan.active;
  if (!step) return { emitted: false, step: null };

  const recent = readRecentEvents(root, 50);
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.type !== "step") continue;
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (data.plan !== plan.path) continue;
    if (data.n === step.n) return { emitted: false, step }; // already the latest
    break; // a different step is latest → this is a real transition
  }

  appendEvent(root, {
    type: "step",
    message: `▶ ${step.text}`,
    data: { plan: plan.path, n: step.n, total: plan.steps.length },
  });
  return { emitted: true, step };
}
