import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFileOrThrow, StateFileError } from "./state-io.js";

// Locate codument's OWN package.json by walking up from this module and
// checking the name — works in both layouts (bundled `dist/`, unbundled
// `src/lib/` under a test runner) and can never silently read a consumer's
// package.json. scaffold.ts's packageRoot() stays bundle-strict because it
// copies templates; this walk-up serves everything that must also work under
// the test runner (the version number, the bundled grammar directory).
function readOwnPackage(): { root: string; version: string } {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf-8"));
        if (parsed.name === "codument") return { root: dir, version: parsed.version };
      } catch {
        // unreadable candidate — keep walking; the loud throw below still guards
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("codument: could not locate its own package.json from " + import.meta.url);
}

const own = readOwnPackage();

export const version: string = own.version;

/** The directory holding codument's own package.json, in both layouts. */
export function ownPackageRoot(): string {
  return own.root;
}

// Dotted-numeric version compare (enough for codument's own x.y.z versions):
// negative when a < b, zero when equal, positive when a > b.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * One-line nudge when the project was scaffolded by an OLDER codument than the
 * one running — after an upgrade the installed skills/managed sections silently
 * lag until `codument update` re-syncs them. Null when in sync, never
 * scaffolded, or scaffolded by a NEWER version (downgrades are the user's
 * call, not a nudge). A present-but-unparseable meta file cannot crash an
 * advisory surface: the notice then names the repair instead of the skew.
 */
export function versionSkewNotice(root: string): string | null {
  let meta: { version?: unknown } | undefined;
  try {
    meta = readJsonFileOrThrow<{ version?: unknown }>(
      join(root, ".codument-meta.json"),
      "project metadata",
    );
  } catch (err) {
    if (err instanceof StateFileError) {
      return ".codument-meta.json is unreadable — run `codument init` (or restore it) to repair";
    }
    throw err;
  }
  if (!meta || typeof meta.version !== "string" || !meta.version) return null;
  if (compareVersions(meta.version, version) >= 0) return null;
  return `codument ${version} installed, project scaffolded at ${meta.version} — run \`codument update\` to re-sync the managed files`;
}
