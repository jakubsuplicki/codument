import { existsSync, cpSync, readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import { detectProject } from "../lib/detect.js";
import {
  ensureDir,
  copyTemplate,
  skillsDir,
  agentsDir,
  rulesDir,
  upsertManagedSection,
  buildManagedSection,
} from "../lib/scaffold.js";
import { writeRegistry } from "../lib/registry.js";
import type { Registry } from "../lib/registry.js";

interface InitOptions {
  force?: boolean;
}

export async function init(options: InitOptions): Promise<void> {
  const root = process.cwd();
  console.log(pc.bold("codument init"));
  console.log();

  // Detect project
  const project = await detectProject(root);
  console.log(
    `  Detected: ${pc.cyan(project.language)}${project.framework ? ` + ${pc.cyan(project.framework)}` : ""}`,
  );
  console.log(`  Source dir: ${pc.cyan(project.srcDir)}`);
  console.log();

  // Create docs structure
  const docsDir = join(root, "docs");
  const dirs = [
    docsDir,
    join(docsDir, "features"),
    join(docsDir, "concepts"),
    join(docsDir, "architecture", "decisions"),
    join(docsDir, "guides"),
  ];
  for (const dir of dirs) {
    ensureDir(dir);
  }
  console.log(`  ${pc.green("✓")} Created docs/ structure`);

  // Copy docs templates
  const docFiles: [string, string][] = [
    ["overview.md", join(docsDir, "overview.md")],
    ["getting-started.md", join(docsDir, "getting-started.md")],
  ];
  for (const [template, dest] of docFiles) {
    if (!existsSync(dest) || options.force) {
      copyTemplate(template, dest);
    }
  }

  // Create empty registry
  const registryPath = join(docsDir, ".registry.json");
  if (!existsSync(registryPath) || options.force) {
    const emptyRegistry: Registry = { features: {} };
    await writeRegistry(registryPath, emptyRegistry);
    console.log(`  ${pc.green("✓")} Created docs/.registry.json`);
  }

  // Set up .claude/ directory
  const claudeDir = join(root, ".claude");
  ensureDir(join(claudeDir, "rules"));
  ensureDir(join(claudeDir, "skills", "update-docs"));
  ensureDir(join(claudeDir, "agents"));

  // Copy rules — substitute paths based on detected project
  const rulesDest = join(claudeDir, "rules", "documentation.md");
  if (!existsSync(rulesDest) || options.force) {
    const ruleTemplate = readFileSync(join(rulesDir(), "documentation.md"), "utf-8");
    const pathsJson = JSON.stringify(project.sourceGlobs);
    const rule = ruleTemplate.replace(
      /^paths: \[.*\]/m,
      `paths: ${pathsJson}`,
    );
    await writeFile(rulesDest, rule);
    console.log(`  ${pc.green("✓")} Created .claude/rules/documentation.md`);
  }

  // Copy all skills
  const skillSource = skillsDir();
  const skillNames = readdirSync(skillSource).filter(
    (name: string) => existsSync(join(skillSource, name, "SKILL.md")),
  );
  for (const name of skillNames) {
    const dest = join(claudeDir, "skills", name, "SKILL.md");
    if (!existsSync(dest) || options.force) {
      ensureDir(join(claudeDir, "skills", name));
      cpSync(join(skillSource, name, "SKILL.md"), dest);
    }
  }
  console.log(`  ${pc.green("✓")} Installed ${skillNames.length} skills: ${skillNames.join(", ")}`);

  // Copy agents
  const agentSource = agentsDir();
  for (const agent of ["doc-writer.md", "doc-scanner.md"]) {
    const dest = join(claudeDir, "agents", agent);
    if (!existsSync(dest) || options.force) {
      cpSync(join(agentSource, agent), dest);
    }
  }
  console.log(`  ${pc.green("✓")} Created .claude/agents/`);

  // Update settings.json with hook
  const settingsPath = join(claudeDir, "settings.json");
  await writeSettings(settingsPath, options.force);
  console.log(`  ${pc.green("✓")} Updated .claude/settings.json`);

  // Update CLAUDE.md with managed section
  const claudeMdPath = join(root, "CLAUDE.md");
  const managedContent = buildManagedSection();
  await upsertManagedSection(claudeMdPath, managedContent);
  console.log(`  ${pc.green("✓")} Updated CLAUDE.md`);

  // Write meta file
  const metaPath = join(root, ".codument-meta.json");
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        version: "0.1.0",
        initialized: new Date().toISOString().split("T")[0],
        project,
      },
      null,
      2,
    ) + "\n",
  );

  console.log();
  console.log(pc.green(pc.bold("Done!")));
  console.log();
  console.log("  Next steps:");
  console.log(`    ${pc.dim("1.")} Start using Claude Code — documentation happens automatically`);
  console.log(`    ${pc.dim("2.")} For existing code, run ${pc.cyan("npx codument scan")} to bootstrap docs`);
  console.log();
}

async function writeSettings(
  settingsPath: string,
  force?: boolean,
): Promise<void> {
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath) && !force) {
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.PostToolUse ?? []) as Array<{
    matcher: string;
    command: string;
  }>;

  const hookCommand = "node node_modules/codument/dist/hooks/check-docs.js";
  const hasHook = postToolUse.some((h) => h.command === hookCommand);
  if (!hasHook) {
    postToolUse.push({
      matcher: "Write|Edit",
      command: hookCommand,
    });
  }

  hooks.PostToolUse = postToolUse;
  settings.hooks = hooks;

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
