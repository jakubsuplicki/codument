import { existsSync, cpSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import {
  DELIVERY_SKILLS,
  getAgentProfiles,
  resolveAgentIds,
  type AgentProfile,
  type AgentProfileId,
} from "../lib/agent-profiles.js";
import { ensureClaudeDocsHook } from "../lib/claude-settings.js";
import { detectProject } from "../lib/detect.js";
import {
  ensureDir,
  skillsDir,
  agentsDir,
  rulesDir,
  upsertManagedSection,
  buildManagedSection,
  copyTemplate,
} from "../lib/scaffold.js";
import { writeRegistry } from "../lib/registry.js";
import type { Registry } from "../lib/registry.js";
import { version as pkgVersion } from "../lib/version.js";

interface InitOptions {
  force?: boolean;
  agents?: string;
}

export async function init(options: InitOptions): Promise<void> {
  const root = process.cwd();
  console.log(pc.bold("codument init"));
  console.log();

  let agentIds: AgentProfileId[];
  try {
    agentIds = resolveAgentIds(root, options.agents);
  } catch (error) {
    console.log(pc.red(`  ${String((error as Error).message)}`));
    process.exitCode = 1;
    return;
  }
  const profiles = getAgentProfiles(agentIds);

  // Detect project
  const project = await detectProject(root);
  console.log(
    `  Detected: ${pc.cyan(project.language)}${project.framework ? ` + ${pc.cyan(project.framework)}` : ""}`,
  );
  console.log(`  Source dir: ${pc.cyan(project.srcDir)}`);
  console.log(
    `  Agents: ${profiles.map((profile) => pc.cyan(profile.displayName)).join(", ")}`,
  );
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

  // Install agent profile assets
  for (const profile of profiles) {
    await installProfile(root, profile, project.sourceGlobs, options.force);
  }

  // Write shared and profile-specific instruction files
  const managedContent = buildManagedSection();
  const instructionFiles = new Set(
    profiles.flatMap((profile) => profile.instructionFiles),
  );
  for (const file of instructionFiles) {
    const content =
      file === "CLAUDE.md" ? buildClaudeManagedSection() : managedContent;
    await upsertManagedSection(join(root, file), content);
    console.log(`  ${pc.green("✓")} Updated ${file}`);
  }

  // Write meta file
  const metaPath = join(root, ".codument-meta.json");
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        version: pkgVersion,
        initialized: new Date().toISOString().split("T")[0],
        agents: agentIds,
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
  console.log(`    ${pc.dim("1.")} Start with ${pc.cyan("/grill-with-docs")} to shape the next feature`);
  console.log(`    ${pc.dim("2.")} For existing code, run ${pc.cyan("npx codument scan")} to bootstrap docs`);
  console.log();
}

async function installProfile(
  root: string,
  profile: AgentProfile,
  sourceGlobs: string[],
  force?: boolean,
): Promise<void> {
  const skillSource = skillsDir();
  for (const name of DELIVERY_SKILLS) {
    const source = join(skillSource, name, "SKILL.md");
    if (!existsSync(source)) continue;

    const dest = join(root, profile.skillsDir, name, "SKILL.md");
    if (!existsSync(dest) || force) {
      ensureDir(join(root, profile.skillsDir, name));
      cpSync(source, dest);
    }
  }
  console.log(
    `  ${pc.green("✓")} Installed ${DELIVERY_SKILLS.length} skills for ${profile.displayName}`,
  );

  if (profile.rulesDir) {
    const rulesDest = join(root, profile.rulesDir, "documentation.md");
    if (!existsSync(rulesDest) || force) {
      ensureDir(join(root, profile.rulesDir));
      const ruleTemplate = readFileSync(
        join(rulesDir(), "documentation.md"),
        "utf-8",
      );
      const rule = ruleTemplate.replace(
        /^paths: \[.*\]/m,
        `paths: ${JSON.stringify(sourceGlobs)}`,
      );
      await writeFile(rulesDest, rule);
    }
    console.log(`  ${pc.green("✓")} Updated ${profile.rulesDir}/`);
  }

  if (profile.agentsDir) {
    ensureDir(join(root, profile.agentsDir));
    const agentSource = agentsDir();
    for (const agent of ["doc-writer.md", "doc-scanner.md", "code-reviewer.md"]) {
      const dest = join(root, profile.agentsDir, agent);
      if (!existsSync(dest) || force) {
        cpSync(join(agentSource, agent), dest);
      }
    }
    console.log(`  ${pc.green("✓")} Updated ${profile.agentsDir}/`);
  }

  if (profile.settingsFile) {
    await writeSettings(join(root, profile.settingsFile), force);
    console.log(`  ${pc.green("✓")} Updated ${profile.settingsFile}`);
  }
}

function buildClaudeManagedSection(): string {
  return `## Claude Compatibility

Shared agent guidance lives in \`AGENTS.md\`. Follow that file as the canonical Codument workflow contract.

${buildManagedSection()}`;
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

  const result = ensureClaudeDocsHook(settings);
  await writeFile(settingsPath, JSON.stringify(result.settings, null, 2) + "\n");
}
