import { existsSync, copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import {
  getAgentProfiles,
  resolveAgentIds,
  type AgentProfileId,
} from "../lib/agent-profiles.js";
import { readMeta, writeMeta, type MetaFile } from "../lib/codemod.js";
import { detectProject } from "../lib/detect.js";
import {
  allSources,
  migrateRegistry,
  normalizeRegistry,
  registryNeedsMigration,
  writeRegistry,
} from "../lib/registry.js";
import { ensureDir } from "../lib/scaffold.js";
import { version as pkgVersion } from "../lib/version.js";
import { update } from "./update.js";

interface AdoptOptions {
  agents?: string;
  dryRun?: boolean;
}

export async function adopt(options: AdoptOptions): Promise<void> {
  const root = process.cwd();
  const dryRun = options.dryRun ?? false;

  console.log(pc.bold("codument adopt"));
  if (dryRun) console.log(pc.yellow("  (dry run — no files will be modified)"));
  console.log();

  const project = await detectProject(root);
  const existingMeta = await readMeta(root);

  let agentIds: AgentProfileId[];
  try {
    agentIds = resolveAgentIds(root, options.agents ?? existingMeta?.agents);
  } catch (error) {
    console.log(pc.red(`  ${String((error as Error).message)}`));
    process.exitCode = 1;
    return;
  }

  const profiles = getAgentProfiles(agentIds);
  console.log(
    `  Detected: ${pc.cyan(project.language)}${project.framework ? ` + ${pc.cyan(project.framework)}` : ""}`,
  );
  console.log(`  Source dir: ${pc.cyan(project.srcDir)}`);
  console.log(
    `  Agents: ${profiles.map((profile) => pc.cyan(profile.displayName)).join(", ")}`,
  );
  console.log();

  if (!dryRun) {
    ensureDir(join(root, "docs"));
  }
  const registryResult = await adoptRegistry(root, dryRun);
  printRegistryResult(registryResult, dryRun);

  const today = new Date().toISOString().split("T")[0];
  const meta: MetaFile = {
    version: pkgVersion,
    initialized: existingMeta?.initialized ?? today,
    agents: agentIds,
    project: { ...project },
    lastScan: existingMeta?.lastScan,
    fileHashes: existingMeta?.fileHashes,
  };

  if (!dryRun) {
    await writeMeta(root, meta);
    console.log(`  ${pc.green("✓")} Updated .codument-meta.json`);
  } else {
    console.log(`  ${pc.green("✓")} .codument-meta.json would be updated`);
  }

  console.log();
  if (dryRun && !existingMeta) {
    console.log(
      pc.dim("  Managed-file preview skipped because .codument-meta.json does not exist yet."),
    );
    console.log();
    return;
  }

  await update({ agents: agentIds.join(","), dryRun });
}

interface RegistryAdoptionResult {
  action: "create" | "migrate" | "normalize" | "skip";
  entries: number;
  sources: number;
}

async function adoptRegistry(
  root: string,
  dryRun: boolean,
): Promise<RegistryAdoptionResult> {
  const registryPath = join(root, "docs", ".registry.json");
  const today = new Date().toISOString().split("T")[0];

  if (!existsSync(registryPath)) {
    if (!dryRun) {
      await writeRegistry(registryPath, { features: {} });
    }
    return { action: "create", entries: 0, sources: 0 };
  }

  const rawText = await readFile(registryPath, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { action: "skip", entries: 0, sources: 0 };
  }

  const needsMigration = registryNeedsMigration(raw);
  const registry = needsMigration
    ? migrateRegistry(raw, today).registry
    : normalizeRegistry(raw, today);
  const canonical = JSON.stringify(registry, null, 2) + "\n";
  const changed = canonical !== rawText;
  if (!changed) {
    return {
      action: "skip",
      entries: Object.keys(registry.features).length,
      sources: countSources(registry),
    };
  }

  if (!dryRun) {
    const backupPath = nextBackupPath(root);
    copyFileSync(registryPath, backupPath);
    await writeRegistry(registryPath, registry);
  }

  return {
    action: needsMigration ? "migrate" : "normalize",
    entries: Object.keys(registry.features).length,
    sources: countSources(registry),
  };
}

function printRegistryResult(
  result: RegistryAdoptionResult,
  dryRun: boolean,
): void {
  const verb = dryRun ? "would be" : "was";
  if (result.action === "skip") {
    console.log(
      `  ${pc.dim("○")} docs/.registry.json already canonical (${result.entries} entries)`,
    );
    return;
  }

  if (result.action === "create") {
    console.log(`  ${pc.green("✓")} docs/.registry.json ${verb} created`);
    return;
  }

  const label =
    result.action === "migrate"
      ? "migrated from legacy mappings"
      : "normalized";
  console.log(
    `  ${pc.green("✓")} docs/.registry.json ${verb} ${label} (${result.entries} entries, ${result.sources} sources)`,
  );
}

function countSources(registry: ReturnType<typeof normalizeRegistry>): number {
  const sources = new Set<string>();
  for (const entry of Object.values(registry.features)) {
    for (const source of allSources(entry)) {
      sources.add(source);
    }
  }
  return sources.size;
}

function nextBackupPath(root: string): string {
  const base = join(root, "docs", ".registry.backup.json");
  if (!existsSync(base)) return base;

  let index = 1;
  while (existsSync(join(root, "docs", `.registry.backup-${index}.json`))) {
    index++;
  }
  return join(root, "docs", `.registry.backup-${index}.json`);
}
