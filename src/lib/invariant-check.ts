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
// The extensions mirror the TS adapter's (`.test.ts/tsx/mts/cts`). Back-ticks sit
// outside the capture, so the returned file is clean.
const TEST_FILE_RE = /`?([A-Za-z0-9_./-]+\.test\.[cm]?tsx?)`?(?:#([A-Za-z0-9_-]+))?/g;

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
