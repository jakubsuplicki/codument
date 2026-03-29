import { mkdirSync, existsSync, cpSync, readFileSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER_START, MARKER_END } from "./markers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function packageRoot(): string {
  const root = join(__dirname, "..");
  if (!existsSync(join(root, "package.json"))) {
    throw new Error(
      `codument: expected package.json at ${root} — bundle output structure may have changed`,
    );
  }
  return root;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function templatePath(name: string): string {
  return join(packageRoot(), "templates", name);
}

export function readTemplate(name: string): string {
  return readFileSync(templatePath(name), "utf-8");
}

export function copyTemplate(name: string, dest: string): void {
  ensureDir(dirname(dest));
  cpSync(templatePath(name), dest);
}

export function skillsDir(): string {
  return join(packageRoot(), "skills");
}

export function agentsDir(): string {
  return join(packageRoot(), "agents");
}

export function rulesDir(): string {
  return join(packageRoot(), "rules");
}

export function buildManagedSection(): string {
  return `## Documentation Maintenance

### Definition of Done
A task is NOT complete until:
1. Code works and tests pass
2. \`docs/.registry.json\` is checked for affected source files
3. Corresponding docs are updated or created
4. Registry is updated with new mappings
5. Dependent features flagged if interface changed
6. \`last_updated\` set on touched docs

### Documentation Registry
The file \`docs/.registry.json\` maps source files to their documentation.
Always check it before and after modifying source files.

### Documentation Structure
- Feature docs: \`docs/features/{name}.md\`
- Concept docs: \`docs/concepts/{name}.md\`
- ADRs: \`docs/architecture/decisions/{NNN}-{title}.md\`
- All filenames: lowercase kebab-case`;
}

export async function upsertManagedSection(
  filePath: string,
  content: string,
): Promise<void> {
  const managed = `${MARKER_START}\n${content}\n${MARKER_END}`;

  if (!existsSync(filePath)) {
    await writeFile(filePath, managed + "\n");
    return;
  }

  const existing = await readFile(filePath, "utf-8");
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const updated =
      existing.slice(0, startIdx) +
      managed +
      existing.slice(endIdx + MARKER_END.length);
    await writeFile(filePath, updated);
  } else {
    await writeFile(filePath, existing.trimEnd() + "\n\n" + managed + "\n");
  }
}
