import { globToRegExp } from "./analyze.js";

// The Feature Map is the plan-doc artifact that decides decomposition: a fenced
// ```feature-map``` block whose rows route source paths to the feature that owns
// them. This module is the PURE half — parse a markdown string into rows and
// route a single file deterministically. The fs / CLI / registry-writing seam
// lives in the `codument map` command, mirroring how plan-steps.ts keeps pure
// checkbox parsing separate from emit. Keeping this pure makes every routing and
// precedence rule exhaustively testable on plain strings.
//
// Block shape — four pipe-delimited fields, optional trailing secondary list:
//
//   ```feature-map
//   src/fairness.ts | fairness  | feature | provably-fair engine; isolated seam
//   src/main.ts     | app-shell | feature | DOM wiring  [secondary: game, board]
//   ```
//
// path-or-glob | feature-slug | type(feature|concept) | one-line responsibility

export interface FeatureMapRow {
  /** The repo-relative path or glob this row owns. */
  pathOrGlob: string;
  /** Primary owning feature (kebab-case slug). */
  feature: string;
  type: "feature" | "concept";
  /** One-line responsibility, with any `[secondary: ...]` stripped off. */
  responsibility: string;
  /** Zero or more secondary feature slugs (from `[secondary: a, b]`). */
  secondary: string[];
}

export interface FeatureMapError {
  /** 1-based line number within the source markdown. */
  line: number;
  raw: string;
  message: string;
}

export interface FeatureMap {
  rows: FeatureMapRow[];
  errors: FeatureMapError[];
}

export interface RouteResult {
  /** Primary owning feature, or null when unmapped or ambiguous. */
  feature: string | null;
  secondary: string[];
  /** True when ≥2 glob rows tie on specificity — the caller surfaces a flag. */
  ambiguous: boolean;
  row: FeatureMapRow | null;
}

const FENCE_OPEN = /^\s*```feature-map\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECONDARY = /\[secondary:\s*([^\]]*)\]\s*$/i;
const FEATURE_MAP_HEADING = /^#{1,6}\s+.*feature\s+map\b/i;

/** True when a markdown *heading* line reads "Feature Map" (any level). Used to
 *  tell "this plan has no Feature Map" (fine for a no-source plan) apart from
 *  "the author wrote a Feature Map section but not a parseable `feature-map`
 *  fenced block" (a table or prose) — the latter silently routes nothing and
 *  must be flagged, not treated as absent. */
export function hasFeatureMapHeading(markdown: string): boolean {
  return markdown.split(/\r?\n/).some((line) => FEATURE_MAP_HEADING.test(line));
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function isGlob(pathOrGlob: string): boolean {
  return pathOrGlob.includes("*");
}

/** Length of the literal prefix before the first glob char — the specificity
 *  used to break ties between matching globs (longer prefix wins). */
function literalPrefixLength(glob: string): number {
  const star = glob.indexOf("*");
  return star === -1 ? glob.length : star;
}

/** Parse the first ```feature-map``` block in `markdown`. No block → no rows and
 *  no errors (a missing map is not an error; the routing rule's no-map branch
 *  handles it). Malformed rows are collected, not thrown. */
export function parseFeatureMap(markdown: string): FeatureMap {
  const lines = markdown.split(/\r?\n/);
  const rows: FeatureMapRow[] = [];
  const errors: FeatureMapError[] = [];
  const seenExact = new Set<string>();

  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock) {
      if (FENCE_OPEN.test(line)) inBlock = true;
      continue;
    }
    if (FENCE_CLOSE.test(line)) break; // first block only

    const raw = line.trim();
    if (raw === "") continue;

    const lineNo = i + 1;
    // Split on the first three pipes only, so a responsibility may itself contain
    // a "|" without tripping a false field-count error.
    const p1 = raw.indexOf("|");
    const p2 = p1 < 0 ? -1 : raw.indexOf("|", p1 + 1);
    const p3 = p2 < 0 ? -1 : raw.indexOf("|", p2 + 1);
    if (p3 < 0) {
      errors.push({ line: lineNo, raw, message: "row must have four fields: path | feature | type | responsibility" });
      continue;
    }
    const pathOrGlob = raw.slice(0, p1).trim();
    const feature = raw.slice(p1 + 1, p2).trim();
    const type = raw.slice(p2 + 1, p3).trim();
    const responsibilityField = raw.slice(p3 + 1).trim();
    if (!pathOrGlob) {
      errors.push({ line: lineNo, raw, message: "empty path/glob" });
      continue;
    }
    if (!SLUG.test(feature)) {
      errors.push({ line: lineNo, raw, message: `feature must be a kebab-case slug, got "${feature}"` });
      continue;
    }
    if (type !== "feature" && type !== "concept") {
      errors.push({ line: lineNo, raw, message: `type must be "feature" or "concept", got "${type}"` });
      continue;
    }

    let responsibility = responsibilityField;
    let secondary: string[] = [];
    const sec = SECONDARY.exec(responsibilityField);
    if (sec) {
      secondary = sec[1].split(",").map((s) => s.trim()).filter(Boolean);
      const badSlug = secondary.find((s) => !SLUG.test(s));
      if (badSlug) {
        errors.push({ line: lineNo, raw, message: `secondary "${badSlug}" must be a kebab-case slug` });
        continue;
      }
      responsibility = responsibilityField.slice(0, sec.index).trim();
    }

    const path = toPosix(pathOrGlob);
    if (!isGlob(path)) {
      if (seenExact.has(path)) {
        errors.push({ line: lineNo, raw, message: `duplicate exact-path row for "${path}"` });
        continue;
      }
      seenExact.add(path);
    }

    rows.push({ pathOrGlob: path, feature, type, responsibility, secondary });
  }

  return { rows, errors };
}

/** Route one repo-relative file to its owning feature. Precedence: an exact-path
 *  row wins; otherwise the matching glob with the longest literal prefix wins; a
 *  tie between two globs is ambiguous (feature null, ambiguous true). No match →
 *  unmapped (feature null, ambiguous false). */
export function routeFile(rows: FeatureMapRow[], file: string): RouteResult {
  const path = toPosix(file);

  const exact = rows.find((r) => !isGlob(r.pathOrGlob) && r.pathOrGlob === path);
  if (exact) {
    return { feature: exact.feature, secondary: exact.secondary, ambiguous: false, row: exact };
  }

  const matches = rows
    .filter((r) => isGlob(r.pathOrGlob) && globToRegExp(r.pathOrGlob).test(path))
    .sort((a, b) => literalPrefixLength(b.pathOrGlob) - literalPrefixLength(a.pathOrGlob));

  if (matches.length === 0) {
    return { feature: null, secondary: [], ambiguous: false, row: null };
  }
  if (
    matches.length > 1 &&
    literalPrefixLength(matches[0].pathOrGlob) === literalPrefixLength(matches[1].pathOrGlob)
  ) {
    return { feature: null, secondary: [], ambiguous: true, row: null };
  }
  const win = matches[0];
  return { feature: win.feature, secondary: win.secondary, ambiguous: false, row: win };
}
