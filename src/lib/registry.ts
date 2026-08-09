import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteFileSync } from "./events.js";
import { DEFAULT_EXCLUSION_SPEC, globToRegExp, isExcluded, toPosix } from "./exclusion-spec.js";
import type { ExclusionSpec } from "./exclusion-spec.js";

// The registry entry is THE model the analyzers read. It splits ownership into
// owned (`primary_sources`) versus impacted (`related_sources`), adds durable
// `docs`, and carries optional `risk` hints. `status` preserves the project's
// real vocabulary instead of flattening unknown values to "current".
export interface RegistryEntry {
  doc: string;
  type: "feature" | "concept";
  primary_sources: string[];
  related_sources: string[];
  docs: string[];
  depends_on: string[];
  risk: string[];
  status: string;
  /** When true, mutes the `under-decomposed` shape nudge — a deliberately large
   *  but cohesive feature the author has acknowledged. Absent ⇒ not acknowledged. */
  cohesive?: boolean;
  /** When true, a human/agent reviewed this entry and confirmed it genuinely
   *  depends on nothing — the honest way for a true leaf to clear the
   *  `empty-depends-on` finding and step out of the dependency ratio (the
   *  foundation exemption needs inward edges; a leaf has none to show).
   *  Absent ⇒ unconfirmed. */
  depends_on_confirmed?: boolean;
  /** For a file SHARED across several features' `primary_sources`, the anchor
   *  descriptors (the `::`-tail of an anchor id, e.g. `reviewCommand().`) this
   *  feature owns within that file. Single-owner files need none — ownership is
   *  derived. Keyed by repo-relative source path. Consumed by the ownership
   *  resolver to split a shared file's symbols across their real owners. */
  owned_symbols?: Record<string, string[]>;
}

export interface Registry {
  features: Record<string, RegistryEntry>;
}

// A present-but-unparseable registry is a loud error, never an empty default.
// Reading a corrupt registry as `{ features: {} }` makes every downstream write
// (which starts from that object) overwrite the real registry with a single
// entry — silent, total data loss. Callers surface this red and fail closed;
// they never proceed as if the project had no registry.
export class RegistryError extends Error {
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    super(
      `registry unreadable: ${path} exists but does not parse` +
        (cause instanceof Error ? ` (${cause.message})` : ""),
    );
    this.name = "RegistryError";
  }
}

// Statuses that mean "not built yet". A registry entry with one of these is not
// considered "mature" for coverage ratios (e.g. an empty `depends_on` on a draft
// entry should not be penalized).
export const PLANNED_STATUSES = new Set(["draft", "planned", "proposed"]);

interface RawRegistry {
  features?: unknown;
}

// Union of every source path an entry maps, owned or related, deduped and sorted.
// Consumers that only care "is this file mentioned anywhere" use this.
export function allSources(entry: RegistryEntry): string[] {
  return uniqSort([...entry.primary_sources, ...entry.related_sources]);
}

/**
 * A source entry that names a SET rather than one file: a glob, or a directory
 * written with a trailing slash. Registration is governance (ADR 017), and a grain
 * that only ever registers one file makes governance cost one line per file —
 * which is why a field repo left 5,400 user-visible strings ungoverned rather than
 * type 380 registry lines for them.
 */
export function isSourcePattern(entry: string): boolean {
  return entry.includes("*") || entry.endsWith("/");
}

/**
 * The matcher for a pattern entry, through the SAME globber the exclusion spec and
 * the Feature Map router already use — one globber, so "what does this pattern
 * match" cannot get two answers. A trailing-slash directory is sugar for `dir/**`:
 * people write `i18n/locales/` and mean the tree, and refusing that to insist on a
 * glob is ceremony.
 */
export function sourceMatcher(entry: string): RegExp {
  return globToRegExp(entry.endsWith("/") ? `${entry}**` : entry);
}

/**
 * The input side of a source match: a relative path as the running platform spells
 * it. Separator conversion is the platform's own — a backslash is a legal character
 * in a POSIX filename, and rewriting one there would invent a path the caller never
 * named — but a `./` or a leading `/` means the same thing everywhere and is
 * stripped, because a tab-completed `./src/x.ts` is the file `src/x.ts` and telling
 * someone nothing owns it is a wrong answer, not a strict one.
 */
export function normalizeInputPath(path: string): string {
  return toPosix(path.trim())
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
}

/** Whether a source entry — literal path or pattern — names this path. */
export function sourceNames(entry: string, path: string): boolean {
  const stored = normalizeRelPath(entry);
  const posix = normalizeInputPath(path);
  return isSourcePattern(stored) ? sourceMatcher(stored).test(posix) : stored === posix;
}

/**
 * The literal directory prefix of a pattern: everything before its first wildcard,
 * with a partial trailing segment dropped. `dist/**` prefixes to `dist`, which is
 * what lets the authoring guard refuse a pattern aimed into an excluded tree
 * without walking the filesystem.
 */
export function patternPrefix(pattern: string): string {
  const star = pattern.indexOf("*");
  const head = star < 0 ? pattern : pattern.slice(0, star);
  return head.replace(/\/[^/]*$/, "").replace(/\/$/, "");
}

/**
 * Every tree an entry declares it governs — the pattern sources across the whole
 * registry, deduped and sorted. A tree-grain acknowledgment is honored only for a
 * pattern in this set: the vouch is wide by construction, and the thing that earns
 * it that width is a declaration someone committed (ADR 017), not a glob typed at
 * the command line. Without the check, `codument ack "src/**"` would clear every
 * coarse and additive wake in one line.
 */
export function registeredPatterns(registry: Registry): string[] {
  const out = new Set<string>();
  for (const entry of Object.values(registry.features)) {
    for (const src of entry.primary_sources) {
      if (isSourcePattern(src)) out.add(normalizeRelPath(src));
    }
  }
  return uniqSort([...out]);
}

// True when the entry represents real, built work: it owns at least one source
// and its status is not a planned/draft placeholder.
export function isMatureEntry(entry: RegistryEntry): boolean {
  return entry.primary_sources.length > 0 && !PLANNED_STATUSES.has(entry.status);
}

// Missing file → an empty registry (the project has none yet, a valid state).
// Present-but-unparseable → RegistryError (never an empty default; see above).
// Exported for callers that read registry CONTENT from somewhere other than the
// worktree file (e.g. the registry blob at a base ref) — same fail-loud rule.
export function parseRegistryOrThrow(content: string, registryPath: string): Registry {
  try {
    return normalizeRegistry(JSON.parse(content));
  } catch (err) {
    throw new RegistryError(registryPath, err);
  }
}

export async function readRegistry(registryPath: string): Promise<Registry> {
  if (!existsSync(registryPath)) {
    return { features: {} };
  }
  return parseRegistryOrThrow(await readFile(registryPath, "utf-8"), registryPath);
}

export function readRegistrySync(registryPath: string): Registry {
  if (!existsSync(registryPath)) {
    return { features: {} };
  }
  return parseRegistryOrThrow(readFileSync(registryPath, "utf-8"), registryPath);
}

export async function writeRegistry(registryPath: string, registry: Registry): Promise<void> {
  // Atomic (tmp + fsync + rename): a crash or a concurrent reader never sees a
  // torn registry — the corrupt-file state that used to trigger silent data loss.
  atomicWriteFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

export function updateRegistryEntry(
  registryPath: string,
  key: string,
  entry: Partial<RegistryEntry>,
  spec: ExclusionSpec = DEFAULT_EXCLUSION_SPEC,
): Registry {
  let registry: Registry = { features: {} };
  if (existsSync(registryPath)) {
    // Refuse to write when the existing registry does not parse: starting from an
    // empty object here would drop every real entry on the next line.
    registry = parseRegistryOrThrow(readFileSync(registryPath, "utf-8"), registryPath);
  }
  const existing = registry.features[key];
  assertNoExcludedSource(key, existing, entry, spec);
  registry.features[key] = ensureEntryDefaults(key, { ...existing, ...entry });
  atomicWriteFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  return registry;
}

/**
 * A pattern was written where nothing resolves one. Only `primary_sources` is read
 * through the matcher, because impact-only registration already costs nothing to
 * skip — so a pattern in `related_sources` would name a tree no surface consults.
 */
export class PatternFieldError extends Error {
  constructor(
    readonly key: string,
    readonly pattern: string,
  ) {
    super(
      `${key}: "${pattern}" is a pattern, and only primary_sources resolves one — a ` +
        `pattern in related_sources would name a tree nothing consults. List the ` +
        `impacted paths, or make the tree an owned source.`,
    );
    this.name = "PatternFieldError";
  }
}

/**
 * An entry tried to name a source the exclusion spec covers. The spec filters
 * these paths out of every analysis, so an entry naming one documents nothing
 * while appearing to document something — and no read path can undo that.
 */
export class ExcludedSourceError extends Error {
  constructor(
    readonly key: string,
    readonly path: string,
    readonly field: "primary_sources" | "related_sources",
    /**
     * The project's own `exclude` rule covering this path, when one does — the
     * same wording split the lint draws. A declaration and a built-in heuristic
     * call for different responses ("un-map it, or narrow what you declared"
     * versus "codument's guess may be wrong about your file"), and one generic
     * refusal sends both to the same dead end. Null ⇒ a built-in rule fired.
     */
    readonly rule: string | null = null,
  ) {
    super(
      rule
        ? `${key}: "${path}" cannot be listed in ${field} — the project's own \`exclude\` ` +
            `(${rule}) covers it, so it cannot be documented source too. Un-map it, or narrow ` +
            `the declaration.`
        : `${key}: "${path}" cannot be listed in ${field} — it matches a built-in exclusion ` +
            `rule (build/generated/test/data), so it is filtered out of every analysis and an ` +
            `entry naming it documents nothing. To point a doc at the test that enforces an ` +
            `invariant, link it in that invariant's prose instead.`,
    );
    this.name = "ExcludedSourceError";
  }
}

// Authoring is strict where reading is tolerant. Only a path this write
// INTRODUCES is refused: `map materialize` passes the merged source array, so
// checking every element would make an entry that already names a test file
// impossible to extend — or to repair — and would turn the lint that reports it
// into a dead end.
function assertNoExcludedSource(
  key: string,
  existing: RegistryEntry | undefined,
  incoming: Partial<RegistryEntry>,
  spec: ExclusionSpec,
): void {
  for (const field of ["primary_sources", "related_sources"] as const) {
    const proposed = incoming[field];
    if (!proposed) continue;
    const already = new Set((existing?.[field] ?? []).map(normalizeRelPath));
    for (const source of proposed) {
      // Check the path as it will be STORED, not as it was typed. The entry is
      // normalized on the way in, so a guard reading the raw string can be
      // walked past with a separator or prefix the normalizer would have
      // rewritten — and the excluded path lands in the registry anyway.
      const stored = normalizeRelPath(source);
      if (already.has(stored)) continue;
      // A pattern cannot be handed to `isExcluded` — the spec asks about a path, and
      // a pattern is a set. What IS decidable without walking the filesystem is where
      // the pattern is aimed: its literal prefix, and whether it restates a rule the
      // spec already owns. A pattern that resolves to nothing in scope is the other
      // half of this guard and lives in `doctor`, which is the surface that holds the
      // file list; refusing it here would mean walking the tree on every registry
      // write.
      if (isSourcePattern(stored)) {
        // Ownership is the only path that resolves patterns, so one accepted here
        // would sit in the registry naming a tree that nothing ever consults —
        // accepted and inert, which is the same lie as a green gate over an
        // unread file, just smaller. Refuse it where it cannot work.
        if (field === "related_sources") {
          throw new PatternFieldError(key, stored);
        }
        const prefix = patternPrefix(stored);
        const aimedIntoExcluded = prefix !== "" && isExcluded(`${prefix}/x`, spec);
        if (aimedIntoExcluded || spec.globs.includes(stored)) {
          throw new ExcludedSourceError(key, stored, field);
        }
        continue;
      }
      if (isExcluded(stored, spec)) {
        // Carry the STORED path, not the typed one. It is the path that was
        // actually tested, so a consumer that re-matches it — to name which rule
        // fired — reaches the same verdict instead of quietly disagreeing with
        // the guard that already refused it.
        throw new ExcludedSourceError(key, stored, field);
      }
    }
  }
}

// The read path validates/defaults/sorts registry entries and preserves the
// status vocabulary. An entry with no `primary_sources` normalizes to empty,
// which `doctor` surfaces.
export function normalizeRegistry(input: unknown): Registry {
  const raw = isRecord(input) ? (input as RawRegistry) : {};
  const registry: Registry = { features: {} };

  if (isRecord(raw.features)) {
    for (const [key, value] of Object.entries(raw.features)) {
      const entry = parseEntry(key, value);
      if (entry) {
        registry.features[key] = entry;
      }
    }
  }

  return registry;
}

// Parses one entry into the registry shape, defaulting and sorting its fields.
function parseEntry(key: string, value: unknown): RegistryEntry | null {
  if (!isRecord(value)) return null;

  const doc =
    typeof value.doc === "string" && value.doc.trim()
      ? normalizeDocPath(value.doc)
      : `docs/features/${key}.md`;
  const type =
    value.type === "feature" || value.type === "concept" ? value.type : typeFromDocPath(doc);

  const primary_sources = stringArray(value.primary_sources);
  const related_sources = stringArray(value.related_sources);
  // Auxiliary docs are consumed as string keys (ownership sets, dedup maps) as
  // well as filesystem paths, so a `./`/backslash spelling that the filesystem
  // would forgive must be canonicalized here or the two kinds of consumer
  // disagree about the same registry line. Shape only — unlike the main `doc`,
  // an auxiliary doc may legitimately live outside docs/ (agents/, skills/).
  const docs = stringArray(value.docs).map(normalizeRelPath);
  const depends_on = stringArray(value.depends_on);
  const risk = stringArray(value.risk);
  const owned_symbols = recordOfStringArrays(value.owned_symbols);

  // Preserve the real status vocabulary. Only an empty/non-string value falls
  // back to "current"; unknown statuses like "in-progress" are kept verbatim.
  const status = typeof value.status === "string" && value.status.trim() ? value.status : "current";

  return {
    doc,
    type,
    primary_sources: uniqSort(primary_sources),
    related_sources: uniqSort(related_sources),
    docs: uniqSort(docs),
    depends_on: uniqSort(depends_on),
    risk: uniqSort(risk),
    status,
    ...(value.cohesive === true ? { cohesive: true } : {}),
    ...(value.depends_on_confirmed === true ? { depends_on_confirmed: true } : {}),
    ...(owned_symbols ? { owned_symbols } : {}),
  };
}

// Fills any missing fields with safe defaults without reordering the arrays a
// caller supplied (merge semantics, used by updateRegistryEntry).
function ensureEntryDefaults(key: string, partial: Partial<RegistryEntry>): RegistryEntry {
  const doc = partial.doc ?? `docs/features/${key}.md`;
  return {
    doc,
    type: partial.type ?? typeFromDocPath(doc),
    primary_sources: partial.primary_sources ?? [],
    related_sources: partial.related_sources ?? [],
    docs: partial.docs ?? [],
    depends_on: partial.depends_on ?? [],
    risk: partial.risk ?? [],
    status: partial.status ?? "current",
    ...(partial.cohesive === true ? { cohesive: true } : {}),
    ...(partial.owned_symbols && Object.keys(partial.owned_symbols).length > 0
      ? { owned_symbols: partial.owned_symbols }
      : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// Normalizes a `Record<path, descriptor[]>` map: drops non-array values, keeps
// only string descriptors, sorts each list and the keys, and returns undefined
// when nothing survives (so the field stays absent for single-owner files).
function recordOfStringArrays(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const path of Object.keys(value).sort()) {
    const descriptors = uniqSort(stringArray(value[path]));
    if (descriptors.length > 0) out[path] = descriptors;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function uniqSort(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// Canonical repo-relative shape: forward slashes, no leading "./" or "/".
export function normalizeRelPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
}

function normalizeDocPath(doc: string): string {
  const trimmed = normalizeRelPath(doc);
  return trimmed.startsWith("docs/") ? trimmed : `docs/${trimmed}`;
}

function typeFromDocPath(docPath: string): RegistryEntry["type"] {
  return docPath.replace(/^docs\//, "").startsWith("features/") ? "feature" : "concept";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
