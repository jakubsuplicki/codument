import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFileSync } from "./events.js";
import { ConfigValueError, readJsonFileOrThrow } from "./state-io.js";

export interface FileHash {
  path: string;
  hash: string;
}

export interface CharterMeta {
  /** How serious the project is, set by the establish-charter gate. */
  seriousness: "demo" | "serious";
  /** ISO date the charter was established. */
  established: string;
}

/**
 * The user-maintained half of the coverage denominator: project-specific dirs
 * and globs that are legitimately not documentation targets (a `tsc` outDir, a
 * deploy tree, generated-but-committed files). Additive to the built-in spec —
 * it can only widen what is excluded, never re-include a built-in exclusion.
 */
export interface ExcludeConfig {
  /** Directory names excluded anywhere in a path. Bare names, never paths. */
  dirs?: string[];
  /** Glob patterns matched against the root-relative path. */
  globs?: string[];
}

export interface MetaFile {
  version: string;
  initialized: string;
  agents?: string[];
  project: Record<string, unknown>;
  lastScan?: Record<string, unknown>;
  fileHashes?: Record<string, string>;
  /**
   * At-a-glance charter status, set when the establish-charter gate runs.
   * `docs/charter.md` remains the source of truth; this is a convenience mirror.
   * Absent until a charter is established.
   */
  charter?: CharterMeta;
  /** Project-specific additions to the exclusion spec. Absent = defaults only. */
  exclude?: ExcludeConfig;
  /**
   * How this project runs ONE test file, with the literal `{file}` token standing
   * for the resolved path — e.g. `"vitest run {file}"`. Declared once here rather
   * than passed as `--test-command` on every run: a project's runner is a fact
   * about the project, not a per-invocation choice. `--test-command` still wins
   * when given. Absent = codument's local-only default (`npx --no-install tsx`).
   */
  testCommand?: string;
}

const EXCLUDE_KEYS = new Set(["dirs", "globs"]);

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

/**
 * Reject an `exclude` block that would not mean what its author intended.
 *
 * Every check here is a case where silence would be worse than failure: an
 * unknown key, a path where a bare dir name belongs, or an empty string (which
 * matches nothing, or everything, depending on where it lands) all read as a
 * working exclusion while excluding nothing.
 */
export function validateExclude(value: unknown, path: string): ExcludeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigValueError(path, "exclude", `expected an object, got ${describe(value)}`);
  }
  for (const key of Object.keys(value)) {
    if (!EXCLUDE_KEYS.has(key)) {
      throw new ConfigValueError(
        path,
        "exclude",
        `unknown key ${JSON.stringify(key)} (expected ${[...EXCLUDE_KEYS].join(" or ")})`,
      );
    }
  }
  const config = value as Record<string, unknown>;
  for (const key of EXCLUDE_KEYS) {
    const list = config[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new ConfigValueError(
        path,
        `exclude.${key}`,
        `expected an array of strings, got ${describe(list)}`,
      );
    }
    for (const item of list) {
      if (typeof item !== "string") {
        throw new ConfigValueError(
          path,
          `exclude.${key}`,
          `expected a string, got ${describe(item)}`,
        );
      }
      if (item.trim() === "") {
        throw new ConfigValueError(path, `exclude.${key}`, "an entry is empty");
      }
      if (key === "dirs" && (item.includes("/") || item.includes("\\"))) {
        throw new ConfigValueError(
          path,
          "exclude.dirs",
          `${JSON.stringify(item)} is a path — dirs takes bare directory names ` +
            `matched at any depth; use exclude.globs for a path pattern`,
        );
      }
    }
  }
  return config as ExcludeConfig;
}

export type MergeResult =
  | { action: "overwrite"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "merge"; reason: string };

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function readMeta(root: string): Promise<MetaFile | null> {
  return readMetaSync(root);
}

/**
 * The same read for callers that cannot await — the editor nudge hook runs as a
 * synchronous script. One implementation, so a validation rule can never apply
 * on one path and not the other.
 */
export function readMetaSync(root: string): MetaFile | null {
  const metaPath = join(root, ".codument-meta.json");
  // Fail loud: a corrupt meta must not read as "absent" and let a re-init,
  // adopt, or update overwrite the fileHashes/charter it carries.
  const parsed = readJsonFileOrThrow<MetaFile>(metaPath, "project metadata");
  if (parsed === undefined) return null;
  // Validated on read, not at the point of use, so a malformed exclusion is
  // rejected by whichever command the user runs next rather than only by the
  // ones that happen to consult the spec.
  if (parsed?.exclude !== undefined) validateExclude(parsed.exclude, metaPath);
  return parsed;
}

export async function writeMeta(
  root: string,
  meta: MetaFile,
): Promise<void> {
  const metaPath = join(root, ".codument-meta.json");
  atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Determines the correct merge strategy for a managed file.
 *
 * - upstream changed + user didn't modify → overwrite
 * - both changed → merge (caller handles section-based merge)
 * - only user changed → skip
 * - no changes → skip
 */
export function decideMergeStrategy(
  upstreamContent: string,
  currentContent: string,
  storedHash: string | undefined,
): MergeResult {
  const upstreamHash = hashContent(upstreamContent);
  const currentHash = hashContent(currentContent);

  // No stored hash means first update — treat current as user-modified
  if (!storedHash) {
    if (currentHash === upstreamHash) {
      return { action: "skip", reason: "already up to date" };
    }
    return { action: "merge", reason: "no prior hash recorded, merging conservatively" };
  }

  const upstreamChanged = upstreamHash !== storedHash;
  const userChanged = currentHash !== storedHash;

  if (!upstreamChanged && !userChanged) {
    return { action: "skip", reason: "no changes" };
  }
  if (upstreamChanged && !userChanged) {
    return { action: "overwrite", reason: "upstream updated, no local modifications" };
  }
  if (!upstreamChanged && userChanged) {
    return { action: "skip", reason: "only local modifications, upstream unchanged" };
  }
  // Both changed
  return { action: "merge", reason: "both upstream and local modified" };
}

/**
 * Records the hash of a file's content in the meta file.
 */
export function setFileHash(
  meta: MetaFile,
  relativePath: string,
  content: string,
): void {
  if (!meta.fileHashes) meta.fileHashes = {};
  meta.fileHashes[relativePath] = hashContent(content);
}
