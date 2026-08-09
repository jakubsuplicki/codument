// Deterministic, lexical altitude heuristics over a registered doc's prose: the three
// "mechanism in prose" smells the doc standard forbids, each a separate id so soak data
// can judge them independently. NO NLP and NO model calls — pure string scanning, so the
// reading is reproducible. Info-only by contract: the caller renders these in doctor's
// Notes channel; they never fail --strict, and the promotion to a warning is a separate,
// soak-backed decision (mirrors co-movement's info-only stance, ADR 005).
//
//   symbol-mirror   — a prose line that opens with an exported identifier + a verb (the
//                     "readRegistry reads the registry" restatement of the code).
//   line-anchor     — a `path.ext:NNN` (or README:NNN) file-line anchor, which rots on
//                     every edit above it.
//   path-enumeration — a prose section that restates the file list (> N literal source
//                     paths), or a Key files entry that lists a path with no role text.
//   fenced-mirror   — a code fence reproducing the DECLARATION of a symbol the entry
//                     owns. The other three read prose and skip fences, which is right
//                     for the illustrative examples docs are full of and leaves the
//                     purest mirror there is unjudged: a doc carrying a declaration
//                     verbatim owes a hand-edit every time that declaration moves, and
//                     the change-control gate will demand one. Judged by the same
//                     exported-symbol list symbol-mirror uses, so "a symbol this entry
//                     owns" has one definition and no second source of truth.

export type ProseAltitudeId =
  | "symbol-mirror"
  | "line-anchor"
  | "path-enumeration"
  | "fenced-mirror"
  | "unsourced-decision";

export interface ProseAltitudeFinding {
  id: ProseAltitudeId;
  feature: string;
  doc: string;
  /** 1-based line of the offending prose. */
  line: number;
  message: string;
  evidence: string;
}

export interface ProseAltitudeInput {
  feature: string;
  doc: string;
  content: string;
  /** Exported identifier names from the entry's primary sources (precise files only). */
  exportedSymbols: string[];
}

export interface ProseAltitudeOptions {
  /** Literal source paths in one prose section above which path-enumeration fires. */
  maxPathsPerSection?: number;
  /**
   * Whether a path is a test file, and so exempt from the path-enumeration count.
   *
   * The documentation standard REQUIRES each invariant to link the test that
   * enforces it, so counting those links as a file-enumeration smell penalizes
   * exactly the behavior the standard exists to create — a metric that climbs as
   * a project complies is backwards, and it trains agents and humans alike to
   * strip test links to quiet `doctor`.
   *
   * Injected rather than imported so this module stays pure and separately
   * testable; the caller derives it from the one exclusion spec's test globs, so
   * "a test file" has a single definition (and picks up a project's configured
   * globs for free). Defaults to "nothing is a test path", which is the
   * pre-calibration behavior.
   */
  isTestPath?: (relPath: string) => boolean;
}

const DEFAULT_MAX_PATHS = 4;

// Words that, following an identifier at sentence start, do NOT read as a mechanism
// verb — so "State is the verdict" or "Config for the gate" never fires symbol-mirror.
const NON_VERBS = new Set([
  "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "the", "a", "an", "of", "in", "on", "to", "for", "with", "as", "at",
  "by", "from", "into", "over", "that", "which", "when", "then", "than", "but", "not",
  "can", "may", "will", "would", "should", "must", "also", "only", "vs", "versus",
]);

// A file-line anchor: a path with a KNOWN source/doc extension (or a bare uppercase
// doc name), followed by `:<digits>`. The extension is an explicit allow-list, not a
// generic `[A-Za-z]{1,5}` — the latter also matches domain TLDs, so a `host.com:8080`
// service URL would false-fire. Deliberately narrow so "10:30", "2.1.0", a plain
// filename mention (no line), or a URL:port never matches.
const LINE_ANCHOR =
  /\b(?:[\w/-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|mdx|ya?ml|sh|css|scss|html?|txt)|README|CHANGELOG|AGENTS|LICENSE|CONTRIBUTING):\d+\b/g;

// A literal first-party source path (a `src/…` file with an extension). The
// extension group repeats, so a multi-dot filename is captured WHOLE: truncating
// at the first dot made `x.service.ts` and `x.service.spec.ts` the same string,
// which both collapses two distinct files into one for counting and hides the
// `.spec.` a test-path predicate needs to see. Extensions stay LETTERS-ONLY for
// the same reason LINE_ANCHOR's list is an allow-list: admitting digits lets a
// version-shaped directory (`src/migrations/v1.2.3/…`) read as a filename, so a
// phantom path would inflate the very count this heuristic reports. No governed
// source extension contains a digit, so nothing real is lost.
const SOURCE_PATH = /\bsrc\/[\w/-]+(?:\.[A-Za-z]+)+\b/g;

// A declaration SITE inside a fence: an optional visibility/export prefix, then a
// declaring keyword, then the name. Deliberately not a general "mentions the symbol"
// test — a fence showing a symbol being CALLED is usage, and usage is what an
// illustrative example is made of.
const FENCED_DECLARATION =
  /^\s*(?:(export|pub(?:\([^)]*\))?|public|private|protected|internal|declare)\s+)?(?:default\s+)?(?:async\s+)?(type|interface|class|enum|struct|trait|record|func|fn|def|function|const|let|var)\s+([A-Za-z_$][\w$]*)/;

// Keywords that declare a NAMED SHAPE. These fire without an export marker because a
// shape declaration is a mirror whoever wrote it — and the languages that mark
// visibility by convention rather than keyword (Python, Go) have no prefix to find.
// The value keywords (const/let/var/function/…) need an explicit export marker,
// because bare ones are how every usage example opens.
const SHAPE_KEYWORDS = new Set([
  "type", "interface", "class", "enum", "struct", "trait", "record",
]);

/**
 * What counts as naming your evidence in a Decisions layer: a link (markdown or wiki),
 * an ADR by number, or a test citation. The standard says Decisions are pointers — "the
 * durable why; reference, never restate" — and a layer that points at nothing records a
 * conclusion nobody can re-derive or contest, which is how a wrong recorded decision
 * survives the attempts to fix what it was wrong about. Judged per SECTION rather than
 * per bullet: an individual small decision legitimately has no ADR, and a per-bullet
 * rule would pressure authors to decorate every line. A whole layer citing nothing is
 * the signal.
 */
const DECISION_EVIDENCE = /\]\(|\[\[|ADR[- ]?\d|\((?:tests?|structural boundary)[:)]/i;

/** Strip leading markdown list/quote/emphasis/backtick markers to reach the prose. */
function stripLeadMarkers(line: string): string {
  return line
    .replace(/^\s+/, "")
    .replace(/^(?:[-*>]\s+|#{1,6}\s+)+/, "")
    .replace(/^\*\*/, "")
    .replace(/^`/, "");
}

function isTableRow(line: string): boolean {
  return /^\s*\|/.test(line);
}

function headingText(line: string): string | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  return m ? m[2].trim() : null;
}

/**
 * Scan one registered doc's prose for the three altitude smells. Pure over its inputs;
 * code fences and markdown tables are excluded from every heuristic (they are not prose).
 */
export function analyzeProseAltitude(
  input: ProseAltitudeInput,
  options: ProseAltitudeOptions = {},
): ProseAltitudeFinding[] {
  const maxPaths = options.maxPathsPerSection ?? DEFAULT_MAX_PATHS;
  const isTestPath = options.isTestPath ?? (() => false);
  const findings: ProseAltitudeFinding[] = [];
  const exported = new Set(input.exportedSymbols);
  // Split on either line ending. A CRLF checkout leaves a trailing carriage return on
  // every line, and `.` does not match one in JavaScript — so the heading regex
  // returned null for every heading in the file, and section awareness was silently
  // dead on Windows: `path-enumeration` reported every doc against section "" at line
  // 0 (the whole-document flush), and nothing that reads a section could fire at all.
  // One split fixes every smell at once.
  const lines = input.content.split(/\r?\n/);

  let inFence = false;
  // At most ONE fenced-mirror per fence: a mirrored union or interface is one doc
  // defect the reader fixes with one deletion, not a finding per declared line.
  let fenceHit: { line: number; name: string } | null = null;
  let sectionTitle = "";
  let sectionHeadingLine = 0;
  let sectionIsKeyFiles = false;
  let sectionIsDecisions = false;
  let sectionHasEvidence = false;
  let sectionHasEntries = false;
  // DISTINCT non-test paths, not mentions: three invariants pinned by one spec
  // file are one file being cited three times, not a three-file enumeration.
  const sectionPaths = new Set<string>();
  const emit = (id: ProseAltitudeId, line: number, message: string, evidence: string) =>
    findings.push({ id, feature: input.feature, doc: input.doc, line, message, evidence });

  const flushSection = () => {
    if (sectionIsDecisions && sectionHasEntries && !sectionHasEvidence) {
      emit(
        "unsourced-decision",
        sectionHeadingLine,
        `section "${sectionTitle}" records decisions that point at nothing — the layer is meant to be pointers (an ADR, a test, a linked doc), and a conclusion nobody can re-derive is one nobody can contest`,
        sectionTitle,
      );
    }
    if (!sectionIsKeyFiles && sectionPaths.size > maxPaths) {
      emit(
        "path-enumeration",
        sectionHeadingLine,
        `section "${sectionTitle}" restates the file list (${sectionPaths.size} source paths in prose) — prose should carry the why, not enumerate files`,
        sectionTitle,
      );
    }
  };

  const emitFenceHit = () => {
    if (!fenceHit) return;
    emit(
      "fenced-mirror",
      fenceHit.line,
      `code fence reproduces the declaration of "${fenceHit.name}", a symbol this entry owns — the fence owes a hand-edit every time that declaration moves; state the contract, not the declaration`,
      fenceHit.name,
    );
    fenceHit = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    // Both CommonMark fence markers (``` and ~~~) open/close a code block; neither's
    // contents are prose.
    if (/^\s*(?:```|~~~)/.test(raw)) {
      if (inFence) {
        emitFenceHit();
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (!fenceHit && exported.size > 0) {
        const m = FENCED_DECLARATION.exec(raw);
        if (m && exported.has(m[3]) && (m[1] !== undefined || SHAPE_KEYWORDS.has(m[2]))) {
          fenceHit = { line: lineNo, name: m[3] };
        }
      }
      continue;
    }

    const heading = headingText(raw);
    if (heading !== null) {
      flushSection();
      sectionTitle = heading;
      sectionHeadingLine = lineNo;
      sectionIsKeyFiles = /key files/i.test(heading);
      sectionIsDecisions = /decisions?$/i.test(heading.trim());
      sectionHasEvidence = false;
      sectionHasEntries = false;
      sectionPaths.clear();
      continue;
    }

    if (sectionIsDecisions) {
      if (/^\s*[-*]\s+\S/.test(raw)) sectionHasEntries = true;
      if (DECISION_EVIDENCE.test(raw)) sectionHasEvidence = true;
    }

    if (isTableRow(raw)) continue; // a table is not prose

    // line-anchor: any file-line anchor in prose.
    for (const m of raw.matchAll(LINE_ANCHOR)) {
      emit(
        "line-anchor",
        lineNo,
        `file-line anchor "${m[0]}" — line numbers rot on every edit above them; cite the symbol or test, not the line`,
        m[0],
      );
    }

    if (sectionIsKeyFiles) {
      // Key files entries are exempt from the path-count smell, but a canonical
      // "path — role" entry (one that OPENS with a source path) that carries no role
      // text is the "paths, not roles" violation. A prose sentence that merely mentions
      // a path in passing is not an entry, so it is left alone.
      const pathFirstEntry = /^\s*[-*]\s+`?src\/[\w/-]+\.[A-Za-z]+`?/.test(raw);
      if (pathFirstEntry && !/\s[—–-]\s\S/.test(raw)) {
        emit(
          "path-enumeration",
          lineNo,
          "Key files entry lists a path with no role — say what the file does, not just its path",
          raw.trim(),
        );
      }
      continue;
    }

    // path-enumeration: accumulate DISTINCT non-test source paths per section. A
    // test path is a legitimate citation anywhere in prose (the standard asks for
    // it), so it is exempt everywhere rather than only inside the invariants
    // section — a section-scoped exemption would just invite heading games.
    for (const path of raw.match(SOURCE_PATH) ?? []) {
      if (!isTestPath(path)) sectionPaths.add(path);
    }

    // symbol-mirror: a prose line opening with an exported identifier + a verb.
    if (exported.size > 0) {
      const prose = stripLeadMarkers(raw);
      const m = /^([A-Za-z_$][\w$]*)`?\s+([a-z][a-zA-Z]{2,})\b/.exec(prose);
      if (m && exported.has(m[1]) && !NON_VERBS.has(m[2])) {
        emit(
          "symbol-mirror",
          lineNo,
          `prose mirrors code: "${m[1]} ${m[2]} …" restates an exported symbol — write the contract/why, not what the symbol is named`,
          `${m[1]} ${m[2]}`,
        );
      }
    }
  }
  // An unclosed fence runs to end of file in CommonMark, so its contents were read
  // as fenced and its finding is owed here — silence would make "forgot the closing
  // fence" a way to hide a mirror.
  emitFenceHit();
  flushSection();

  return findings;
}
