import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// This hook runs after Write/Edit tool use.
// It checks if a source file was modified and reminds the developer that
// documentation should be updated as part of the same task.
// Output goes to the terminal (developer-facing). Claude enforces this via
// the path-scoped rule in .claude/rules/documentation.md.

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

let registry: { features: Record<string, { sources: string[]; doc: string }> } | undefined;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf-8"));
} catch {
  process.exit(0);
}

if (!registry) process.exit(0);

for (const [name, entry] of Object.entries(registry.features)) {
  const matches = entry.sources.some(
    (s) => relPath === s || relPath.startsWith(s + "/"),
  );
  if (matches) {
    console.log(
      `⚠️  codument: ${relPath} → documented in "${name}" (${entry.doc}) — doc must be updated in this same task`,
    );
    break;
  }
}
