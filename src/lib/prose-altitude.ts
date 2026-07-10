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

export type ProseAltitudeId = "symbol-mirror" | "line-anchor" | "path-enumeration";

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

// A literal first-party source path (a `src/…` file with an extension).
const SOURCE_PATH = /\bsrc\/[\w/-]+\.[A-Za-z]+\b/g;

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
  const findings: ProseAltitudeFinding[] = [];
  const exported = new Set(input.exportedSymbols);
  const lines = input.content.split("\n");

  let inFence = false;
  let sectionTitle = "";
  let sectionHeadingLine = 0;
  let sectionIsKeyFiles = false;
  let sectionPaths = 0;
  const emit = (id: ProseAltitudeId, line: number, message: string, evidence: string) =>
    findings.push({ id, feature: input.feature, doc: input.doc, line, message, evidence });

  const flushSection = () => {
    if (!sectionIsKeyFiles && sectionPaths > maxPaths) {
      emit(
        "path-enumeration",
        sectionHeadingLine,
        `section "${sectionTitle}" restates the file list (${sectionPaths} source paths in prose) — prose should carry the why, not enumerate files`,
        sectionTitle,
      );
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    // Both CommonMark fence markers (``` and ~~~) open/close a code block; neither's
    // contents are prose.
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = headingText(raw);
    if (heading !== null) {
      flushSection();
      sectionTitle = heading;
      sectionHeadingLine = lineNo;
      sectionIsKeyFiles = /key files/i.test(heading);
      sectionPaths = 0;
      continue;
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

    // path-enumeration: accumulate source paths per prose section.
    const paths = raw.match(SOURCE_PATH);
    if (paths) sectionPaths += paths.length;

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
  flushSection();

  return findings;
}
