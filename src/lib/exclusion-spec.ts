import { sep } from "node:path";

// ── Canonical exclusion spec ────────────────────────────────────────────
//
// One version-controlled spec, shared by every analyzer (doctor, review, watch,
// scan), applied to BOTH the coverage numerator and denominator. "What should be
// documented" is a choice; a naive every-file denominator turns the score into
// noise, so generated/build/test files and trivia are excluded here once.
//
// The exclusion overrides the registry's own contents: a test/generated path
// listed in some entry's sources is still filtered out of the in-scope set.

export interface ExclusionSpec {
  /** Directory names ignored anywhere in a path. */
  dirs: string[];
  /** Glob patterns ( ** and * supported ) matched against the relative path. */
  globs: string[];
  /** File extensions counted as source. */
  extensions: string[];
}

/**
 * Every language's "this file is a test" convention, in one place.
 *
 * Split out of the exclusion spec below rather than duplicated beside it,
 * because two surfaces need this exact question answered and a second copy is
 * how they would drift: the spec excludes tests from the coverage scope, and the
 * prose-altitude heuristic exempts a cited test path from the file-enumeration
 * count (the doc standard REQUIRES linking each invariant to its enforcing test,
 * so counting those links would penalize compliance). The spec is composed FROM
 * this, so there is one definition, not a copy.
 */
export const TEST_CONVENTIONS: { dirs: string[]; globs: string[] } = {
  dirs: ["__tests__"],
  globs: [
    "**/*.test.*",
    "**/*.spec.*",
    // Python test conventions — the `*.test.*` family's pytest analogs.
    "**/test_*.py",
    "**/*_test.py",
    "**/conftest.py",
    // Go's law: _test.go files are test binaries, never library surface.
    "**/*_test.go",
    // JVM conventions: Surefire/JUnit `*Test`/`*Tests`/`*TestCase` naming and
    // the canonical Maven/Gradle `src/test` source set (Java + Kotlin), never
    // library surface.
    "**/*Test.java",
    "**/*Tests.java",
    "**/*TestCase.java",
    "**/*Test.kt",
    "**/*Tests.kt",
    "**/*Spec.kt",
    "**/src/test/**",
    // Root-level test-fixture trees only — anchored (not a bare `fixtures` dir
    // name) so a project's real first-party source under e.g. `src/fixtures/`
    // is NOT silently dropped from governance.
    "fixtures/**",
  ],
};

export const DEFAULT_EXCLUSION_SPEC: ExclusionSpec = {
  dirs: [
    ".agents",
    ".claude",
    ".codument",
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".venv",
    ".wxt",
    "__pycache__",
    ...TEST_CONVENTIONS.dirs,
    "build",
    "coverage",
    "dist",
    "node_modules",
    "venv",
  ].sort(),
  globs: [
    ...TEST_CONVENTIONS.globs,
    "**/*.d.ts",
    "**/*.d.mts",
    "**/*.d.cts",
    "**/*.seed.json",
    "**/generated/**",
    "scripts/generate-*",
  ],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".pyi", ".go", ".rs", ".cs", ".java", ".kt", ".kts", ".vue", ".svelte", ".astro"],
};

/**
 * True when a path follows one of the test conventions above. The single
 * definition of "a test file" — `isExcluded`'s own matcher over the conventions,
 * never a fifth hand-rolled regex.
 */
export function isTestPath(relPath: string): boolean {
  return isExcluded(relPath, {
    dirs: TEST_CONVENTIONS.dirs,
    globs: TEST_CONVENTIONS.globs,
    extensions: [],
  });
}

// Exported so the Feature Map router (feature-map.ts) matches globs with the
// exact same semantics the exclusion spec uses — one globber, no drift.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"; // **/ → zero or more leading segments
          i += 2;
        } else {
          re += ".*"; // ** → anything
          i += 1;
        }
      } else {
        re += "[^/]*"; // * → anything but a path separator
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Normalize a platform path to POSIX separators for matching. */
export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** True when a relative path is excluded by the spec (dir, glob, or both). */
export function isExcluded(
  relPath: string,
  spec: ExclusionSpec = DEFAULT_EXCLUSION_SPEC,
): boolean {
  const posix = toPosix(relPath);
  const segments = posix.split("/");
  if (segments.some((segment) => spec.dirs.includes(segment))) {
    return true;
  }
  return spec.globs.some((glob) => globToRegExp(glob).test(posix));
}

/** True when a path is a non-excluded source file by extension. */
export function isSourceFile(
  relPath: string,
  spec: ExclusionSpec = DEFAULT_EXCLUSION_SPEC,
): boolean {
  const posix = toPosix(relPath);
  const hasSourceExt = spec.extensions.some((ext) => posix.endsWith(ext));
  return hasSourceExt && !isExcluded(posix, spec);
}
