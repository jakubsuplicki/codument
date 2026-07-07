import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry.js";
import {
  DEFAULT_TEST_SEARCH_DIRS,
  makeTestRunner,
  resolveTestPath,
  type TestRunner,
  type TestRunResult,
} from "./review-confirm.js";

// ── Invariant pointer parsing ────────────────────────────────────────────────
//
// The documentation standard requires every entry in a doc's `## Invariants &
// boundaries` section to bind its claim to the test that enforces it — a
// `*(test: <file>)*` / `*(tests: …)*` marker — or to admit it is not enforced
// (`*(untested)*`) or is a deliberate non-testable boundary (`*(honest …)*`). The
// 0.7.0 link-rot lint only checks that a cited path EXISTS; nothing runs the test,
// so a doc can cite a skipped, rotted, or permanently-red test and still read
// clean. This module is the first half of closing that gap: it parses the markers
// into machine-checkable pointers. The second half (Plan 12 Step 2) runs each
// pointer through the project's hardened test runner and classifies the outcome.
//
// The parse is deterministic and I/O-free — a pure function of the doc text — so it
// stays on the same no-model, reproducible footing as the rest of doctor. It reads
// the markers as the docs ACTUALLY write them (free prose after the file name,
// multiple files per marker, back-ticked or bare paths), not an idealized grammar,
// so a real invariant is never silently skipped.

/** One test the invariant claims to be enforced by. `name` is the optional
 *  `#<test-name>` suffix from the standard's grammar (rare in practice — the docs
 *  usually name the test in prose); the runner executes the whole file regardless. */
export interface InvariantPointer {
  file: string;
  name?: string;
}

export type InvariantAnnotation =
  /** `*(test: …)* / *(tests: …)*` with at least one resolvable `.test.ts` file. */
  | { kind: "pinned"; pointers: InvariantPointer[] }
  /** `*(untested)*` — honestly declared unenforced. */
  | { kind: "untested" }
  /** `*(honest …)*` — a deliberate non-testable boundary/ceiling, note carried. */
  | { kind: "honest"; note: string }
  /** A `test:`/`tests:` marker that names no parseable test file — surfaced, not skipped. */
  | { kind: "malformed"; raw: string }
  /** No recognized annotation on the invariant bullet at all. */
  | { kind: "none" };

export interface ParsedInvariant {
  /** The invariant's lead claim (the bolded phrase, or the opening prose), for display. */
  summary: string;
  annotation: InvariantAnnotation;
  /** 1-based line in the doc where the invariant bullet begins. */
  line: number;
}

// Matches a test-file token, back-ticked or bare, with an optional `#name` suffix.
// Accepts the common test extensions — `.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` —
// since a consumer project's suite may be JS. Back-ticks sit outside the capture,
// so the returned file is clean.
const TEST_FILE_RE = /`?([A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?)`?(?:#([A-Za-z0-9_-]+))?/g;

// The trailing italic-paren annotation on a bullet: the LAST `*( … )*` span. Real
// annotations sit at the end of the invariant; an earlier `*( … )*` aside is not it.
const ANNOTATION_RE = /\*\(([\s\S]*?)\)\*/g;

// Extract the `## Invariants & boundaries` section body (up to the next level-2
// heading or EOF). Returns null when the doc has no such section.
function invariantsSection(docText: string): { body: string; startLine: number } | null {
  const lines = docText.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Invariants\b/i.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { body: lines.slice(start + 1, end).join("\n"), startLine: start + 1 };
}

// The lead claim of a bullet: the first `**bold**` span, else the opening text up
// to the first sentence break, trimmed to a display length.
function summarize(bulletText: string): string {
  const stripped = bulletText.replace(/^-\s+/, "").trim();
  const bold = stripped.match(/^\*\*([^*]+)\*\*/);
  if (bold) return bold[1].trim();
  const firstLine = stripped.split("\n")[0];
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

// Classify a bullet's trailing annotation span content.
function classify(rawAnnotation: string): InvariantAnnotation {
  const content = rawAnnotation.trim();
  const lower = content.toLowerCase();
  if (lower.startsWith("test:") || lower.startsWith("tests:")) {
    const pointers: InvariantPointer[] = [];
    for (const m of content.matchAll(TEST_FILE_RE)) {
      pointers.push(m[2] ? { file: m[1], name: m[2] } : { file: m[1] });
    }
    return pointers.length > 0 ? { kind: "pinned", pointers } : { kind: "malformed", raw: content };
  }
  if (lower === "untested") return { kind: "untested" };
  if (lower.startsWith("honest")) return { kind: "honest", note: content };
  return { kind: "none" };
}

// Parse every invariant bullet in a doc's `## Invariants & boundaries` section.
// A bullet is a top-level `- ` list item; its trailing prose (test descriptions,
// spanning several lines) belongs to it until the next top-level bullet. Returns
// [] when the doc has no invariants section. Deterministic, no I/O.
export function parseInvariants(docText: string): ParsedInvariant[] {
  const section = invariantsSection(docText);
  if (!section) return [];
  const lines = section.body.split("\n");
  const invariants: ParsedInvariant[] = [];
  let current: { text: string[]; line: number } | null = null;
  const flush = () => {
    if (!current) return;
    const bulletText = current.text.join("\n");
    const matches = [...bulletText.matchAll(ANNOTATION_RE)];
    const raw = matches.length > 0 ? matches[matches.length - 1][1] : null;
    invariants.push({
      summary: summarize(bulletText),
      annotation: raw === null ? { kind: "none" } : classify(raw),
      line: current.line,
    });
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s+/.test(line)) {
      flush();
      current = { text: [line], line: section.startLine + i + 1 };
    } else if (current) {
      current.text.push(line);
    }
  }
  flush();
  return invariants;
}

// ── Running the pointers: verify, don't trust ────────────────────────────────
//
// Second half of `doctor --verify-invariants`: run each pinned pointer through the
// project's hardened runner and classify the outcome. This extends verify-don't-
// trust from diffs (the review gate) to the docs themselves — a cited test that is
// missing, red, or unrunnable is a named result instead of silent decoration.

export type InvariantVerdict =
  /** Every cited test resolved and passed — the invariant is enforced. */
  | "green"
  /** A cited test resolved and ran RED — a warn finding. */
  | "invariant-broken"
  /** A cited test file does not resolve, or the marker was unparseable — a warn
   *  finding (subsumes the existence-only link-rot check when this mode runs). */
  | "invariant-unpinned"
  /** A cited test resolved but the runner could not execute it (toolchain) — info. */
  | "unrunnable"
  /** `*(untested)*`, or no marker at all — honestly (or silently) unenforced; info,
   *  and counts against the honesty ratio. */
  | "untested"
  /** `*(honest …)*` — a deliberate non-testable boundary; info, excluded from the ratio. */
  | "honest";

export interface InvariantResult {
  doc: string;
  summary: string;
  line: number;
  verdict: InvariantVerdict;
  detail?: string;
}

export interface DocInvariants {
  /** The registered doc's repo-relative path. */
  doc: string;
  invariants: ParsedInvariant[];
}

export interface InvariantProbes {
  /** Runs a resolved test file, red/green/unrunnable. */
  run: TestRunner;
  /** Whether a test reference resolves to an existing, in-tree file (unpinned check). */
  exists: (testRef: string) => boolean;
}

export interface InvariantCheckReport {
  results: InvariantResult[];
  /** Green invariants — the numerator of the honesty ratio. */
  enforced: number;
  /** Invariants that count toward the ratio: green + broken + unpinned + untested.
   *  `unrunnable` and `honest` are excluded (a toolchain gap and a deliberate
   *  non-testable boundary are neither enforced nor a pinning failure). */
  scored: number;
  /** Warn-level results (broken + unpinned) — what `--strict` fails on. */
  warnings: InvariantResult[];
}

const SCORED: ReadonlySet<InvariantVerdict> = new Set([
  "green",
  "invariant-broken",
  "invariant-unpinned",
  "untested",
]);

// Classify one invariant. A pinned invariant runs every cited test (deduped by the
// caller's memoized runner); the aggregate verdict surfaces the most actionable
// state — a red test outranks a missing pin, which outranks a toolchain failure,
// and only an all-green set is `green`.
function verdictFor(
  inv: ParsedInvariant,
  probes: InvariantProbes,
  runOnce: (ref: string) => TestRunResult,
): { verdict: InvariantVerdict; detail?: string } {
  const a = inv.annotation;
  if (a.kind === "untested") return { verdict: "untested" };
  if (a.kind === "none") return { verdict: "untested", detail: "no test marker" };
  if (a.kind === "honest") return { verdict: "honest", detail: a.note };
  if (a.kind === "malformed") {
    return { verdict: "invariant-unpinned", detail: `unparseable test marker: ${a.raw}` };
  }
  let broken: string | undefined;
  let unpinned: string | undefined;
  let unrunnable: string | undefined;
  for (const p of a.pointers) {
    if (!probes.exists(p.file)) {
      unpinned = p.file;
      continue;
    }
    const res = runOnce(p.file);
    if (res.outcome === "failed") broken = p.file;
    else if (res.outcome === "unrunnable") unrunnable = res.detail ?? p.file;
  }
  if (broken) return { verdict: "invariant-broken", detail: `${broken} ran red` };
  if (unpinned) return { verdict: "invariant-unpinned", detail: `test not found: ${unpinned}` };
  if (unrunnable) return { verdict: "unrunnable", detail: unrunnable };
  return { verdict: "green" };
}

// Run and classify every invariant across the registered docs. Identical cited
// test files run once (the runner is memoized), so a test shared by many
// invariants is not re-executed. Pure aside from the injected probes.
export function checkInvariants(
  docs: readonly DocInvariants[],
  probes: InvariantProbes,
): InvariantCheckReport {
  const cache = new Map<string, TestRunResult>();
  const runOnce = (ref: string): TestRunResult => {
    const hit = cache.get(ref);
    if (hit) return hit;
    const res = probes.run(ref);
    cache.set(ref, res);
    return res;
  };
  const results: InvariantResult[] = [];
  for (const { doc, invariants } of docs) {
    for (const inv of invariants) {
      results.push({ doc, summary: inv.summary, line: inv.line, ...verdictFor(inv, probes, runOnce) });
    }
  }
  const enforced = results.filter((r) => r.verdict === "green").length;
  const scored = results.filter((r) => SCORED.has(r.verdict)).length;
  const warnings = results.filter(
    (r) => r.verdict === "invariant-broken" || r.verdict === "invariant-unpinned",
  );
  return { results, enforced, scored, warnings };
}

// Build the real probes from a repo root: the hardened test runner plus an
// existence check that resolves a reference through the same search dirs and
// containment rules the runner uses, so "unpinned" means exactly "the runner
// would not find this file". `command` overrides the default test command
// (`review`'s `--test-command` contract).
export function invariantProbes(root: string, command?: readonly string[]): InvariantProbes {
  return {
    run: makeTestRunner({ root, command, searchDirs: DEFAULT_TEST_SEARCH_DIRS }),
    exists: (ref) => resolveTestPath(root, ref, DEFAULT_TEST_SEARCH_DIRS) !== null,
  };
}

// Read every registered doc (primary + additional) and parse its invariants,
// deduped by path and sorted for a deterministic order. A doc missing from disk
// is skipped here (that is analyze's link-rot concern, not this mode's), and a doc
// with no invariants section contributes nothing.
export function gatherDocInvariants(root: string, registry: Registry): DocInvariants[] {
  const seen = new Set<string>();
  const out: DocInvariants[] = [];
  const consider = (docPath: string | undefined): void => {
    if (!docPath || seen.has(docPath)) return;
    seen.add(docPath);
    const full = join(root, docPath);
    if (!existsSync(full)) return;
    const invariants = parseInvariants(readFileSync(full, "utf8"));
    if (invariants.length > 0) out.push({ doc: docPath, invariants });
  };
  for (const entry of Object.values(registry.features)) {
    consider(entry.doc);
    for (const d of entry.docs ?? []) consider(d);
  }
  return out.sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0));
}

// The honesty ratio: the enforced (green) share of invariants that count toward
// scoring, or null when none are scorable (the same zero-denominator rule doctor
// uses for coverage). Kept here so the ratio definition lives with the classes.
export function honestyRatio(report: InvariantCheckReport): number | null {
  return report.scored === 0 ? null : report.enforced / report.scored;
}

// Top-level convenience for `doctor --verify-invariants`: gather, run, classify.
export function runInvariantCheck(
  root: string,
  registry: Registry,
  command?: readonly string[],
): InvariantCheckReport {
  return checkInvariants(gatherDocInvariants(root, registry), invariantProbes(root, command));
}
