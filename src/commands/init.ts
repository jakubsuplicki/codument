import { existsSync, cpSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import { atomicWriteFileSync } from "../lib/events.js";
import { readJsonFileOrThrow } from "../lib/state-io.js";
import type { MetaFile } from "../lib/codemod.js";
import {
  resolveSkills,
  getAgentProfiles,
  resolveAgentIds,
  AGENT_DEFINITIONS,
  type AgentProfile,
  type AgentProfileId,
} from "../lib/agent-profiles.js";
import { ensureClaudeDocsHook } from "../lib/claude-settings.js";
import { detectProject } from "../lib/detect.js";
import { HookError, installHook } from "../lib/git-hooks.js";
import {
  discoverSourceFiles,
  makeIgnoredPredicate,
  resolveScopeSync,
} from "../lib/analyze.js";
import type { ExclusionSpec } from "../lib/exclusion-spec.js";
import { listIgnoredPaths } from "../lib/git.js";
import { scan } from "./scan.js";
import {
  ensureDir,
  skillsDir,
  agentsDir,
  rulesDir,
  upsertManagedSection,
  buildManagedSection,
  copyTemplate,
} from "../lib/scaffold.js";
import { readRegistry, writeRegistry } from "../lib/registry.js";
import type { Registry } from "../lib/registry.js";
import { version as pkgVersion } from "../lib/version.js";

interface InitOptions {
  force?: boolean;
  agents?: string;
  hooks?: boolean;
  /** commander's `--no-scan`: absent or true = scan existing code, false = skip. */
  scan?: boolean;
}

/**
 * Does this repo have code to map, by exactly the rule `scan` itself will use?
 * Asked with scan's own walker, scope resolution and ignore predicate rather
 * than a private heuristic, so the decision to run it cannot disagree with what
 * it then finds.
 *
 * A scope that cannot be resolved answers "no" rather than propagating. Both of
 * its failures — a meta that does not parse, and one that parses but declares
 * an invalid exclusion — are refusals `scan` owns and states precisely, and
 * installing the workflow is worth doing either way. Letting them escape here
 * would mean a project could no longer install because of a field that only
 * governs the mapping half.
 */
function hasScannableSource(root: string): boolean {
  let spec: ExclusionSpec;
  try {
    const resolved = resolveScopeSync(root);
    if (resolved.unreadable) return false;
    spec = resolved.spec;
  } catch {
    return false;
  }
  const ignored = listIgnoredPaths(root);
  const srcDir = existsSync(join(root, "src")) ? "src" : ".";
  return (
    discoverSourceFiles(
      root,
      srcDir,
      spec,
      makeIgnoredPredicate(ignored.ok ? ignored.paths : []),
    ).paths.length > 0
  );
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

  // Create empty registry only when absent. --force overwrites codument-managed
  // scaffolds, but the registry carries human-authored ownership; never reset a
  // populated one. Re-scaffolding requires deleting the file deliberately.
  const registryPath = join(docsDir, ".registry.json");
  // A registry this run creates is empty, which is the whole "existing code,
  // nothing documented" case: the workflow is installed and owns none of the
  // user's source. One that already existed is `adopt`'s case — proposing over
  // authored ownership is not init's call.
  const registryIsNew = !existsSync(registryPath);
  if (registryIsNew) {
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

  // Write meta file. Read-merge so a re-init preserves the fields codument
  // accumulates (fileHashes, lastScan, charter) and the original init date, which
  // `update`'s three-way merge and the change detector depend on. A corrupt meta
  // is refused (StateFileError), never overwritten.
  const metaPath = join(root, ".codument-meta.json");
  const existingMeta = readJsonFileOrThrow<MetaFile>(metaPath, "project metadata");
  atomicWriteFileSync(
    metaPath,
    JSON.stringify(
      {
        ...existingMeta,
        version: pkgVersion,
        initialized:
          existingMeta?.initialized ?? new Date().toISOString().split("T")[0],
        agents: agentIds,
        project,
      },
      null,
      2,
    ) + "\n",
  );

  // Opt-in enforcement: init never wires a gate the user did not ask for, and a
  // project not yet under git degrades to a note rather than a failed init.
  if (options.hooks) {
    try {
      const { action, hookPath } = installHook(root);
      console.log(pc.green(`  ✓ pre-commit gate ${action}: ${hookPath}`));
    } catch (error) {
      if (error instanceof HookError) {
        console.log(pc.yellow(`  • pre-commit gate skipped: ${(error as Error).message}`));
        console.log(pc.dim("    Run `codument hooks install` once the repository exists."));
      } else {
        throw error;
      }
    }
  }

  // Map existing code as part of setup. Installing the workflow over a codebase
  // and leaving the registry empty is a silent half-install: the gate has
  // nothing to check and `/update-docs` has no scaffolds to fill, and nothing
  // says so until much later. Both halves of the condition are already known
  // here, so the second command the user used to have to remember is this one.
  let scanned = false;
  let mapped = false;
  if (options.scan !== false && registryIsNew && hasScannableSource(root)) {
    console.log();
    await scan({ root });
    scanned = true;
    // Finding source is not the same as mapping it: scan skips files sitting at
    // the source root (entry points and config, by its own rule), so a flat
    // project can scan cleanly and own nothing. The next step it earns depends
    // on what it produced, not on whether it ran — pointing a user at scaffolds
    // that do not exist is worse than the hint they had before.
    mapped = Object.keys((await readRegistry(registryPath)).features).length > 0;
  }

  console.log();
  if (scanned && process.exitCode) {
    // scan refuses rather than proposing a scope it could not read. The install
    // itself is complete and useful, so say which half is missing instead of
    // presenting the whole run as a failure — but keep its exit code, because a
    // caller that scripted this deserves to know the mapping never happened.
    console.log(pc.yellow(pc.bold("Installed, but the codebase was not mapped.")));
    console.log();
    console.log(`  Fix the reason above, then run ${pc.cyan("npx codument scan")} to map it.`);
    console.log();
    return;
  }
  console.log(pc.green(pc.bold("Done!")));
  console.log();
  console.log("  Next steps:");
  if (mapped) {
    console.log(`    ${pc.dim("1.")} Run ${pc.cyan("/update-docs")} in a NEW agent session to fill the scaffolds`);
    console.log(`    ${pc.dim("2.")} Then just chat — ${pc.cyan("/grill-with-docs")} shapes the next feature`);
  } else {
    console.log(`    ${pc.dim("1.")} Start with ${pc.cyan("/grill-with-docs")} to shape the next feature`);
    console.log(`    ${pc.dim("2.")} For existing code, run ${pc.cyan("npx codument scan")} to bootstrap docs`);
  }
  console.log();
}

async function installProfile(
  root: string,
  profile: AgentProfile,
  sourceGlobs: string[],
  force?: boolean,
): Promise<void> {
  const skillSource = skillsDir();
  const skills = resolveSkills();
  for (const name of skills) {
    const srcDir = join(skillSource, name);
    if (!existsSync(join(srcDir, "SKILL.md"))) continue;

    // Copy the whole skill directory (SKILL.md + any references/) so skills that
    // use progressive-disclosure reference files install completely, not just
    // their entrypoint.
    const destDir = join(root, profile.skillsDir, name);
    if (!existsSync(join(destDir, "SKILL.md")) || force) {
      ensureDir(destDir);
      cpSync(srcDir, destDir, { recursive: true });
    }
  }
  console.log(
    `  ${pc.green("✓")} Installed ${skills.length} skills for ${profile.displayName}`,
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
    for (const agent of AGENT_DEFINITIONS) {
      const dest = join(root, profile.agentsDir, agent);
      if (!existsSync(dest) || force) {
        cpSync(join(agentSource, agent), dest);
      }
    }
    console.log(`  ${pc.green("✓")} Updated ${profile.agentsDir}/`);
  }

  if (profile.settingsFile) {
    await writeSettings(join(root, profile.settingsFile));
    console.log(`  ${pc.green("✓")} Updated ${profile.settingsFile}`);
    // The hook target is resolved at edit time from the project root. Without a
    // local install the guarded command stays a silent no-op (never an error in
    // the editor loop) — say so once, here, where it can be fixed.
    if (!existsSync(join(root, "node_modules", "codument"))) {
      console.log(
        pc.yellow(
          "  ⚠ codument is not in this project's node_modules — the docs-nudge hook stays dormant (silent, never an error) until you `npm install -D codument`.",
        ),
      );
    }
  }
}

function buildClaudeManagedSection(): string {
  return `## Claude Compatibility

Shared agent guidance lives in \`AGENTS.md\`. Follow that file as the canonical Codument workflow contract.

${buildManagedSection()}`;
}

async function writeSettings(settingsPath: string): Promise<void> {
  // Always read-merge, even under --force: --force overwrites codument-managed
  // FILES, never the non-codument keys (permissions, other hooks, env) in a
  // shared settings file. We upsert only our hook. A present-but-unparseable
  // settings file is refused here (StateFileError), never silently rewritten
  // down to just the hook.
  const settings =
    readJsonFileOrThrow<Record<string, unknown>>(settingsPath, "settings") ?? {};
  const result = ensureClaudeDocsHook(settings);
  atomicWriteFileSync(settingsPath, JSON.stringify(result.settings, null, 2) + "\n");
}
