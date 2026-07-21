import { existsSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { allSources, readRegistrySync, RegistryError } from "../lib/registry.js";
import { isSourceFile, resolveScopeSync, DEFAULT_EXCLUSION_SPEC } from "../lib/analyze.js";

// This hook runs after Write/Edit tool use.
// It checks if a source file was modified and reminds the developer that
// documentation should be updated as part of the same task.
// Output goes to the terminal (developer-facing). The Claude profile pairs this
// with the path-scoped rule in .claude/rules/documentation.md.

// Resolve the hook payload. Current Claude Code delivers it as JSON on stdin
// ({ tool_input: { file_path } }); older/explicit invocations set the
// CLAUDE_TOOL_INPUT env var ({ file_path }). Prefer the env var when present
// (also what the test suite injects), otherwise read stdin — guarding against an
// interactive TTY with no piped input so the hook never blocks.
function readToolInput(): string | undefined {
  if (process.env.CLAUDE_TOOL_INPUT) return process.env.CLAUDE_TOOL_INPUT;
  if (process.stdin.isTTY) return undefined;
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return undefined;
  }
}

const raw = readToolInput();
if (!raw || !raw.trim()) process.exit(0);

let parsed:
  | { file_path?: string; tool_input?: { file_path?: string } }
  | undefined;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(0);
}

const filePath = parsed?.tool_input?.file_path ?? parsed?.file_path;
if (!filePath) process.exit(0);

// Find the project root by walking up from the edited file to the directory that
// holds docs/.registry.json, so the hook works regardless of the cwd the harness
// runs it from. Fall back to cwd (preserves behavior for relative paths).
function findRoot(fromFile: string): string {
  let dir = dirname(fromFile);
  for (let i = 0; i < 50; i++) {
    if (existsSync(join(dir, "docs", ".registry.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const root = findRoot(filePath);
const registryPath = join(root, "docs", ".registry.json");

const relPath = relative(root, filePath);

// Only care about files the gate itself governs — the ONE shared spec from the
// analyzer, project-declared exclusions included, so the live nudge and the
// verdict can never disagree about what a source is (a module-flavored config
// nudges; a .d.ts, test file, or declared build tree does not).
//
// Fail safe, like the registry read below: this hook is advisory and fires on
// every edit, so an unreadable or invalid config degrades to the built-in spec
// rather than erroring on each keystroke. The loud "fix your config" belongs to
// the commands the user runs deliberately.
let exclusion = DEFAULT_EXCLUSION_SPEC;
try {
  exclusion = resolveScopeSync(root).spec;
} catch {
  // Advisory: keep nudging with the defaults.
}
if (!isSourceFile(relPath, exclusion)) process.exit(0);

if (!existsSync(registryPath)) process.exit(0);

// Fail safe: this hook is advisory and silent-on-doubt, so an unreadable
// registry no-ops exactly like an absent one — never a crash, never noise on
// every edit. The loud "fix your registry" belongs to review/doctor/watch.
let registry;
try {
  registry = readRegistrySync(registryPath);
} catch (err) {
  if (err instanceof RegistryError) process.exit(0);
  throw err;
}

const matches: string[] = [];
for (const [name, entry] of Object.entries(registry.features)) {
  const isMatch = allSources(entry).some(
    (s) => relPath === s || relPath.startsWith(s + "/"),
  );
  if (isMatch) {
    matches.push(`"${name}" (${entry.doc})`);
  }
}

if (matches.length > 0) {
  const docs = matches.join(", ");
  console.log(
    `⚠️  codument: ${relPath} → documented in ${docs} — docs must be updated in this same task`,
  );
}
