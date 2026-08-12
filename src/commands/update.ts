import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import pc from "picocolors";
import {
  resolveSkills,
  getAgentProfiles,
  resolveAgentIds,
  AGENT_DEFINITIONS,
  type AgentProfile,
  type AgentProfileId,
} from "../lib/agent-profiles.js";
import { ensureClaudeDocsHook } from "../lib/claude-settings.js";
import { readJsonFileOrThrow } from "../lib/state-io.js";
import { detectProject } from "../lib/detect.js";
import {
  readMeta,
  writeMeta,
  decideMergeStrategy,
  setFileHash,
  type MetaFile,
} from "../lib/codemod.js";
import {
  skillsDir,
  agentsDir,
  rulesDir,
  upsertManagedSection,
  buildManagedSection,
  ensureDir,
  nonDirectoryAncestor,
} from "../lib/scaffold.js";
import { MARKER_START, MARKER_END } from "../lib/markers.js";
import { version as pkgVersion, compareVersions } from "../lib/version.js";

interface UpdateOptions {
  dryRun?: boolean;
  agents?: string;
  /**
   * The version the project is coming FROM, for a caller that has already
   * rewritten the metadata this command would otherwise read it out of.
   * `adopt` is that caller: it stamps the new version and then delegates here,
   * so the file no longer remembers where the project started — which silently
   * suppressed the migration note on the one command whose whole job is
   * bringing an older project forward.
   *
   * `null` says the caller KNOWS there was no earlier install, which is a
   * different answer from "could not tell": a project that never ran codument
   * has nothing for a migration note to be about, while one whose version is
   * unreadable might. Absent means read it from the metadata as usual.
   */
  priorVersion?: string | null;
}

interface UpdateAction {
  file: string;
  action: "overwrite" | "skip" | "merge" | "create";
  reason: string;
}

interface ManagedFile {
  relativePath: string;
  upstream: () => Promise<string>;
}

function getManagedFiles(
  profiles: AgentProfile[],
  sourceGlobs: string[],
): ManagedFile[] {
  const files = new Map<string, ManagedFile>();

  for (const profile of profiles) {
    for (const name of resolveSkills()) {
      const skillDir = join(skillsDir(), name);
      const source = join(skillDir, "SKILL.md");
      if (!existsSync(source)) continue;
      const relativePath = `${profile.skillsDir}/${name}/SKILL.md`;
      files.set(relativePath, {
        relativePath,
        upstream: () => readFile(source, "utf-8"),
      });
      // Reference files (one level deep) ship alongside the skill entrypoint.
      const refsDir = join(skillDir, "references");
      if (existsSync(refsDir)) {
        for (const ref of readdirSync(refsDir)) {
          if (!ref.endsWith(".md")) continue;
          const refRel = `${profile.skillsDir}/${name}/references/${ref}`;
          const refSource = join(refsDir, ref);
          files.set(refRel, {
            relativePath: refRel,
            upstream: () => readFile(refSource, "utf-8"),
          });
        }
      }
    }

    if (profile.rulesDir) {
      const relativePath = `${profile.rulesDir}/documentation.md`;
      files.set(relativePath, {
        relativePath,
        upstream: () => readRule(sourceGlobs),
      });
    }

    if (profile.agentsDir) {
      for (const agent of AGENT_DEFINITIONS) {
        const relativePath = `${profile.agentsDir}/${agent}`;
        files.set(relativePath, {
          relativePath,
          upstream: () => readFile(join(agentsDir(), agent), "utf-8"),
        });
      }
    }
  }

  return [...files.values()];
}

export async function update(options: UpdateOptions): Promise<void> {
  const root = process.cwd();
  const dryRun = options.dryRun ?? false;

  console.log(pc.bold("codument update"));
  if (dryRun) console.log(pc.yellow("  (dry run — no files will be modified)"));
  console.log();

  // Read meta file
  const meta = await readMeta(root);
  if (!meta) {
    console.log(
      pc.red("  No .codument-meta.json found. Run `codument init` first."),
    );
    process.exitCode = 1;
    return;
  }

  // Captured before the write below overwrites it: the note below is keyed on
  // where the project is coming FROM, and by the time it prints that is gone.
  // A caller that already stamped the new version says so explicitly.
  const priorVersion =
    options.priorVersion !== undefined
      ? options.priorVersion
      : typeof meta.version === "string"
        ? meta.version
        : "";

  let agentIds: AgentProfileId[];
  try {
    agentIds = resolveAgentIds(root, options.agents ?? meta.agents);
  } catch (error) {
    console.log(pc.red(`  ${String((error as Error).message)}`));
    process.exitCode = 1;
    return;
  }
  const profiles = getAgentProfiles(agentIds);
  const project = await detectProject(root);
  const sourceGlobs = project.sourceGlobs;

  const actions: UpdateAction[] = [];

  // 1. Update managed files (rules, skills, agents)
  for (const managed of getManagedFiles(profiles, sourceGlobs)) {
    const absPath = join(root, managed.relativePath);

    // A non-directory where a directory must be (a pointer-file or a
    // symlink-to-file, common in shared-skill setups) makes writeFile throw
    // ENOTDIR and would abort the entire run mid-way. Skip it with a warning and
    // keep going, so one odd entry never leaves a half-applied tree.
    const blocker = nonDirectoryAncestor(absPath);
    if (blocker) {
      actions.push({
        file: managed.relativePath,
        action: "skip",
        reason: `${relative(root, blocker)} is not a directory (pointer or symlink) — left untouched`,
      });
      continue;
    }

    try {
      const upstreamContent = await managed.upstream();

      if (!existsSync(absPath)) {
        actions.push({
          file: managed.relativePath,
          action: "create",
          reason: "file missing from project",
        });
        if (!dryRun) {
          ensureDir(dirname(absPath));
          await writeFile(absPath, upstreamContent);
          setFileHash(meta, managed.relativePath, upstreamContent);
        }
        continue;
      }

      const currentContent = await readFile(absPath, "utf-8");
      const storedHash = meta.fileHashes?.[managed.relativePath];
      const result = decideMergeStrategy(upstreamContent, currentContent, storedHash);

      // For non-CLAUDE.md files, "merge" can't do section-based merge —
      // back up the user's version, then overwrite with upstream
      if (result.action === "merge") {
        const backupPath = absPath + ".backup";
        if (!dryRun) {
          await writeFile(backupPath, currentContent);
        }
        actions.push({
          file: managed.relativePath,
          action: "overwrite",
          reason: `both changed — upstream applied, local backed up to ${managed.relativePath}.backup`,
        });
      } else {
        actions.push({
          file: managed.relativePath,
          action: result.action,
          reason: result.reason,
        });
      }

      if (!dryRun) {
        if (result.action === "overwrite" || result.action === "merge") {
          await writeFile(absPath, upstreamContent);
          setFileHash(meta, managed.relativePath, upstreamContent);
        } else {
          // skip — but still record hash if missing
          if (!storedHash) {
            setFileHash(meta, managed.relativePath, currentContent);
          }
        }
      }
    } catch (error) {
      // Never let one file's failure abort the run and strand a partial tree.
      actions.push({
        file: managed.relativePath,
        action: "skip",
        reason: `could not write (${(error as Error).message}) — left untouched`,
      });
      process.exitCode = 1;
    }
  }

  // 2. Update managed instruction sections
  const instructionFiles = new Set(
    profiles.flatMap((profile) => profile.instructionFiles),
  );
  for (const file of instructionFiles) {
    try {
      const content =
        file === "CLAUDE.md" ? buildClaudeManagedSection() : buildManagedSection();
      const action = await updateInstructionFile(root, meta, dryRun, file, content);
      actions.push(action);
    } catch (error) {
      actions.push({
        file,
        action: "skip",
        reason: `could not update (${(error as Error).message}) — left untouched`,
      });
      process.exitCode = 1;
    }
  }

  // 3. Update profile settings/hooks
  for (const profile of profiles) {
    if (!profile.settingsFile) continue;
    try {
      const settingsAction = await updateSettings(
        root,
        profile.settingsFile,
        dryRun,
      );
      actions.push(settingsAction);
    } catch (error) {
      actions.push({
        file: profile.settingsFile,
        action: "skip",
        reason: `could not update (${(error as Error).message}) — left untouched`,
      });
      process.exitCode = 1;
    }
  }

  // 4. Update meta version
  if (!dryRun) {
    meta.version = pkgVersion;
    meta.agents = agentIds;
    meta.project = { ...project };
    await writeMeta(root, meta);
  }

  // Print summary
  printActions(actions, dryRun);

  if (dryRun) {
    console.log();
    console.log(pc.dim("  Run without --dry-run to apply changes."));
  }

  if (priorVersion !== null && compareVersions(priorVersion, MIGRATION_FROM_BELOW) < 0) {
    printMigrationNote();
  }

  console.log();
}

async function updateInstructionFile(
  root: string,
  meta: MetaFile,
  dryRun: boolean,
  relativePath: string,
  managedContent: string,
): Promise<UpdateAction> {
  const filePath = join(root, relativePath);
  const fullManaged = `${MARKER_START}\n${managedContent}\n${MARKER_END}`;

  if (!existsSync(filePath)) {
    if (!dryRun) {
      await upsertManagedSection(filePath, managedContent);
      setFileHash(meta, relativePath, fullManaged);
    }
    return { file: relativePath, action: "create", reason: "file missing" };
  }

  const current = await readFile(filePath, "utf-8");
  const startIdx = current.indexOf(MARKER_START);
  const endIdx = current.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) {
    // No managed section found — append it
    if (!dryRun) {
      await upsertManagedSection(filePath, managedContent);
      setFileHash(meta, relativePath, fullManaged);
    }
    return {
      file: relativePath,
      action: "merge",
      reason: "managed section missing, appending",
    };
  }

  // Extract current managed section for comparison
  const currentManaged = current.slice(startIdx, endIdx + MARKER_END.length);
  const storedHash = meta.fileHashes?.[relativePath];
  const result = decideMergeStrategy(fullManaged, currentManaged, storedHash);

  if (!dryRun && result.action !== "skip") {
    await upsertManagedSection(filePath, managedContent);
    setFileHash(meta, relativePath, fullManaged);
  } else if (!dryRun && !storedHash) {
    setFileHash(meta, relativePath, currentManaged);
  }

  return { file: relativePath, action: result.action, reason: result.reason };
}

async function updateSettings(
  root: string,
  relativePath: string,
  dryRun: boolean,
): Promise<UpdateAction> {
  const settingsPath = join(root, relativePath);

  const blocker = nonDirectoryAncestor(settingsPath);
  if (blocker) {
    return {
      file: relativePath,
      action: "skip",
      reason: `${relative(root, blocker)} is not a directory (pointer or symlink) — left untouched`,
    };
  }

  if (!existsSync(settingsPath)) {
    const result = ensureClaudeDocsHook();
    if (!dryRun) {
      ensureDir(dirname(settingsPath));
      await writeFile(
        settingsPath,
        JSON.stringify(result.settings, null, 2) + "\n",
      );
    }
    return { file: relativePath, action: "create", reason: "file missing" };
  }

  // Fail loud on a corrupt settings file rather than rewriting it down to just
  // the hook (destroying the user's permissions/env/other hooks). The caller
  // catches this, leaves the file untouched, and exits nonzero.
  const current =
    readJsonFileOrThrow<Record<string, unknown>>(settingsPath, "settings") ?? {};
  const result = ensureClaudeDocsHook(current);
  if (!result.changed) {
    return { file: relativePath, action: "skip", reason: "hook already present" };
  }

  if (!dryRun) {
    await writeFile(
      settingsPath,
      JSON.stringify(result.settings, null, 2) + "\n",
    );
  }
  return {
    file: relativePath,
    action: "merge",
    reason: result.foundExistingHook
      ? "updating hook matcher"
      : "adding missing hook",
  };
}

async function readRule(sourceGlobs: string[]): Promise<string> {
  const ruleTemplate = await readFile(join(rulesDir(), "documentation.md"), "utf-8");
  return ruleTemplate.replace(
    /^paths: \[.*\]/m,
    `paths: ${JSON.stringify(sourceGlobs)}`,
  );
}

function buildClaudeManagedSection(): string {
  return `## Claude Compatibility

Shared agent guidance lives in \`AGENTS.md\`. Follow that file as the canonical Codument workflow contract.

${buildManagedSection()}`;
}

/**
 * The one release whose upgrade leaves work behind, and what clears it.
 *
 * 0.18 narrowed the gate to what it can prove, which is a silent improvement for
 * everything going forward and a pile of stale state for everything already
 * recorded: acknowledgments banked against moves that no longer gate, `--standing`
 * records the release retires, registry lines the project's own declarations
 * contradict. None of it is dangerous and none of it announces itself, so the
 * upgrade is the only moment a reader is looking. It also names the one block that
 * got QUIETER — a loosening is the half of a release nobody discovers on their own,
 * and finding out later that a file stopped being watched is how trust in an exit
 * code dies.
 *
 * Keyed on the version the project was last updated FROM, so it appears exactly
 * once per repo and never nags a project already past it. An unreadable prior
 * version shows the note: we cannot prove they have crossed, and a second reading
 * costs a screen where a missed one costs the cleanup.
 */
const MIGRATION_FROM_BELOW = "0.18.0";

function printMigrationNote(): void {
  console.log();
  console.log(pc.bold("  codument 0.18 — the gate blocks only what it can prove"));
  console.log();
  console.log(
    "  A body-only symbol move is now reported, never blocked: the acknowledgment",
  );
  console.log(
    "  treadmill stops with no action from you. Two commands clear what earlier",
  );
  console.log("  releases left behind:");
  console.log();
  console.log(
    `    ${pc.cyan("codument ack --prune")}     sweeps acknowledgments that cover nothing any`,
  );
  console.log(
    "                             more, including every --standing record (0.18",
  );
  console.log("                             retires the flag)");
  console.log(
    `    ${pc.cyan("codument doctor --fix")}    drops registry lines your own .gitignore or`,
  );
  console.log("                             exclude block already contradicts");
  console.log();
  console.log(
    "  One block got quieter, deliberately: a registered file no adapter can read",
  );
  console.log(
    `  now gates only where an owning entry declares a ${pc.bold("risk")}. Run ${pc.cyan("codument doctor")}`,
  );
  console.log("  to see every file that lost its gate.");
}

function printActions(actions: UpdateAction[], dryRun: boolean): void {
  const verb = dryRun ? "would" : "was";
  for (const { file, action, reason } of actions) {
    const icon =
      action === "skip"
        ? pc.dim("  ○")
        : action === "overwrite" || action === "create"
          ? pc.green("  ✓")
          : pc.yellow("  ~");
    const label =
      action === "skip"
        ? pc.dim(`${file} — skipped (${reason})`)
        : action === "create"
          ? `${file} — ${verb} created (${reason})`
          : action === "overwrite"
            ? `${file} — ${verb} overwritten (${reason})`
            : pc.yellow(`${file} — ${verb} merged (${reason})`);
    console.log(`${icon} ${label}`);
  }
}
