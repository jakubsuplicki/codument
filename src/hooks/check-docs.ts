import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { allSources, readRegistrySync } from "../lib/registry.js";

// This hook runs after Write/Edit tool use.
// It checks if a source file was modified and reminds the developer that
// documentation should be updated as part of the same task.
// Output goes to the terminal (developer-facing). The Claude profile pairs this
// with the path-scoped rule in .claude/rules/documentation.md.

const root = process.cwd();
const registryPath = join(root, "docs", ".registry.json");

const toolInput = process.env.CLAUDE_TOOL_INPUT;
if (!toolInput) process.exit(0);

let parsed: { file_path?: string } | undefined;
try {
  parsed = JSON.parse(toolInput);
} catch {
  process.exit(0);
}

if (!parsed?.file_path) process.exit(0);
const filePath = parsed.file_path;

const relPath = relative(root, filePath);

// Only care about source files (any directory, not just src/)
if (!/\.(ts|tsx|js|jsx)$/.test(relPath)) process.exit(0);

if (!existsSync(registryPath)) process.exit(0);

const registry = readRegistrySync(registryPath);

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
