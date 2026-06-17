import { readFileSync, readdirSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { appendEvent, readRecentEvents } from "./events.js";

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
}

// ── Pure parsing ─────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;

/** Collect checkbox items under the first heading whose text matches `match`,
 *  stopping at the next heading. Returns [] when no such section exists. */
function sectionSteps(lines: string[], match: RegExp): PlanStep[] {
  let inSection = false;
  let n = 0;
  const steps: PlanStep[] = [];
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      if (inSection) break; // next heading ends our section
      if (match.test(h[2])) inSection = true;
      continue;
    }
    if (!inSection) continue;
    const c = CHECKBOX.exec(line);
    if (c) {
      n += 1;
      steps.push({ n, text: c[2], done: c[1].toLowerCase() === "x" });
    }
  }
  return steps;
}

/** The plan's checklist: the `Delivery Plan` section if present, else
 *  `Definition of Done`. Checkboxes outside the chosen section are ignored. */
export function parseDeliveryPlan(markdown: string): PlanStep[] {
  const lines = markdown.split(/\r?\n/);
  const delivery = sectionSteps(lines, /\bdelivery plan\b/i);
  if (delivery.length) return delivery;
  return sectionSteps(lines, /\bdefinition of done\b/i);
}

/** First unchecked step, or null when the plan is complete/empty. */
export function activeStep(steps: PlanStep[]): PlanStep | null {
  return steps.find((s) => !s.done) ?? null;
}

/** First `status:`/`Status:` value (frontmatter or body), markdown stripped and
 *  lowercased — e.g. `Status: **approved**` → "approved". */
export function extractStatus(markdown: string): string | null {
  const m = /^[\s>*_-]*status:\s*(.+?)\s*$/im.exec(markdown);
  if (!m) return null;
  const cleaned = m[1].replace(/[*_`]/g, "").trim().toLowerCase();
  return cleaned || null;
}

/** Approved means the word "approved" — "awaiting approval" is deliberately not
 *  approved (no `\bapproved\b`). */
export function isApproved(status: string | null): boolean {
  return !!status && /\bapproved\b/.test(status);
}

/** Native to-do status for a step within its plan: done→completed,
 *  the active step→in_progress, everything else→pending. */
export function todoStatus(plan: ActivePlan, step: PlanStep): TodoStatus {
  if (step.done) return "completed";
  return plan.active && step.n === plan.active.n ? "in_progress" : "pending";
}

// ── Discovery (fs) ───────────────────────────────────────────────────────

const PLAN_DIRS = ["docs/features", "docs/concepts"];

function toActivePlan(root: string, abs: string): ActivePlan | null {
  let md: string;
  try {
    md = readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
  const steps = parseDeliveryPlan(md);
  const status = extractStatus(md);
  const rel = relative(root, abs).split("\\").join("/");
  const base = rel.split("/").pop() ?? rel;
  return {
    path: rel,
    planName: base.replace(/\.md$/i, ""),
    status,
    approved: isApproved(status),
    steps,
    active: activeStep(steps),
  };
}

/** Read a specific plan doc (repo-relative or absolute). Null when unreadable. */
export function loadPlan(root: string, planPath: string): ActivePlan | null {
  return toActivePlan(root, isAbsolute(planPath) ? planPath : join(root, planPath));
}

/** Approved plans under docs/features|concepts that still have an unchecked
 *  step, sorted by path. The single-element common case is the active plan; an
 *  empty or multi-element result tells the caller to ask for an explicit plan. */
export function findActivePlans(root: string): ActivePlan[] {
  const out: ActivePlan[] = [];
  for (const d of PLAN_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(root, d));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".md")) continue;
      const plan = toActivePlan(root, join(root, d, name));
      if (plan && plan.approved && plan.active) out.push(plan);
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
