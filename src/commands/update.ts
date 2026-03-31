import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import pc from "picocolors";
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
} from "../lib/scaffold.js";
import { MARKER_START, MARKER_END } from "../lib/markers.js";
import { version as pkgVersion } from "../lib/version.js";

interface UpdateOptions {
  dryRun?: boolean;
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

function getManagedFiles(): ManagedFile[] {
  const files: ManagedFile[] = [
    {
      relativePath: ".claude/rules/documentation.md",
      upstream: () => readFile(join(rulesDir(), "documentation.md"), "utf-8"),
    },
    {
      relativePath: ".claude/agents/doc-writer.md",
      upstream: () => readFile(join(agentsDir(), "doc-writer.md"), "utf-8"),
    },
    {
      relativePath: ".claude/agents/doc-scanner.md",
      upstream: () => readFile(join(agentsDir(), "doc-scanner.md"), "utf-8"),
    },
    {
      relativePath: ".claude/agents/code-reviewer.md",
      upstream: () => readFile(join(agentsDir(), "code-reviewer.md"), "utf-8"),
    },
  ];

  // Dynamically discover all skills
  const skillsRoot = skillsDir();
  const skillNames = readdirSync(skillsRoot).filter(
    (name: string) => existsSync(join(skillsRoot, name, "SKILL.md")),
  );
  for (const name of skillNames) {
    files.push({
      relativePath: `.claude/skills/${name}/SKILL.md`,
      upstream: () => readFile(join(skillsRoot, name, "SKILL.md"), "utf-8"),
    });
  }

  return files;
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

  const actions: UpdateAction[] = [];

  // 1. Update managed files (rules, skills, agents)
  for (const managed of getManagedFiles()) {
    const absPath = join(root, managed.relativePath);
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
  }

  // 2. Update CLAUDE.md managed section
  const claudeMdAction = await updateClaudeMd(root, meta, dryRun);
  actions.push(claudeMdAction);

  // 3. Update .claude/settings.json hook
  const settingsAction = await updateSettings(root, meta, dryRun);
  actions.push(settingsAction);

  // 4. Update meta version
  if (!dryRun) {
    meta.version = pkgVersion;
    await writeMeta(root, meta);
  }

  // Print summary
  printActions(actions, dryRun);

  if (dryRun) {
    console.log();
    console.log(pc.dim("  Run without --dry-run to apply changes."));
  }

  console.log();
}

async function updateClaudeMd(
  root: string,
  meta: MetaFile,
  dryRun: boolean,
): Promise<UpdateAction> {
  const claudeMdPath = join(root, "CLAUDE.md");
  const relPath = "CLAUDE.md";

  const managedContent = buildManagedSection();
  const fullManaged = `${MARKER_START}\n${managedContent}\n${MARKER_END}`;

  if (!existsSync(claudeMdPath)) {
    if (!dryRun) {
      await upsertManagedSection(claudeMdPath, managedContent);
      setFileHash(meta, relPath, fullManaged);
    }
    return { file: relPath, action: "create", reason: "file missing" };
  }

  const current = await readFile(claudeMdPath, "utf-8");
  const startIdx = current.indexOf(MARKER_START);
  const endIdx = current.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) {
    // No managed section found — append it
    if (!dryRun) {
      await upsertManagedSection(claudeMdPath, managedContent);
      setFileHash(meta, relPath, fullManaged);
    }
    return { file: relPath, action: "merge", reason: "managed section missing, appending" };
  }

  // Extract current managed section for comparison
  const currentManaged = current.slice(startIdx, endIdx + MARKER_END.length);
  const storedHash = meta.fileHashes?.[relPath];
  const result = decideMergeStrategy(fullManaged, currentManaged, storedHash);

  if (!dryRun && result.action !== "skip") {
    await upsertManagedSection(claudeMdPath, managedContent);
    setFileHash(meta, relPath, fullManaged);
  } else if (!dryRun && !storedHash) {
    setFileHash(meta, relPath, currentManaged);
  }

  return { file: relPath, action: result.action, reason: result.reason };
}

async function updateSettings(
  root: string,
  meta: MetaFile,
  dryRun: boolean,
): Promise<UpdateAction> {
  const settingsPath = join(root, ".claude", "settings.json");
  const relPath = ".claude/settings.json";
  const hookCommand = "node node_modules/codument/dist/hooks/check-docs.js";

  if (!existsSync(settingsPath)) {
    const settings = {
      hooks: {
        PostToolUse: [{ matcher: "Write|Edit", command: hookCommand }],
      },
    };
    if (!dryRun) {
      ensureDir(join(root, ".claude"));
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
    return { file: relPath, action: "create", reason: "file missing" };
  }

  let current: Record<string, unknown>;
  try {
    current = JSON.parse(await readFile(settingsPath, "utf-8"));
  } catch {
    current = {};
  }
  const hooks = (current.hooks ?? {}) as Record<string, unknown[]>;
  const postToolUse = (hooks.PostToolUse ?? []) as Array<{
    matcher: string;
    command: string;
  }>;

  const hasHook = postToolUse.some((h) => h.command === hookCommand);
  if (hasHook) {
    return { file: relPath, action: "skip", reason: "hook already present" };
  }

  if (!dryRun) {
    postToolUse.push({ matcher: "Write|Edit", command: hookCommand });
    hooks.PostToolUse = postToolUse;
    current.hooks = hooks;
    await writeFile(settingsPath, JSON.stringify(current, null, 2) + "\n");
  }
  return { file: relPath, action: "merge", reason: "adding missing hook" };
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