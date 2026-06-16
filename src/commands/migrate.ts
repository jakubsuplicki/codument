import { existsSync, copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import {
  migrateRegistry,
  registryNeedsMigration,
  writeRegistry,
} from "../lib/registry.js";

interface MigrateOptions {
  root?: string;
  dryRun?: boolean;
}

/**
 * One-shot legacy → v2 registry migration. Reads `docs/.registry.json`, and if
 * it still holds legacy data (flat `sources` arrays or old `mappings`), converts
 * it to the v2 ownership shape with an optional backup. Idempotent: a registry
 * already in v2 is reported as up to date and left untouched.
 */
export async function migrateRegistryCommand(
  options: MigrateOptions = {},
): Promise<void> {
  const root = options.root ?? process.cwd();
  const dryRun = options.dryRun ?? false;

  console.log(pc.bold("codument migrate-registry"));
  if (dryRun) console.log(pc.yellow("  (dry run — no files will be modified)"));
  console.log();

  const registryPath = join(root, "docs", ".registry.json");
  if (!existsSync(registryPath)) {
    console.log(
      pc.red("  Error: docs/.registry.json not found. Run `codument init` first."),
    );
    process.exitCode = 1;
    return;
  }

  const rawText = await readFile(registryPath, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    console.log(pc.red("  Error: docs/.registry.json is not valid JSON."));
    process.exitCode = 1;
    return;
  }

  if (!registryNeedsMigration(raw)) {
    console.log(`  ${pc.dim("○")} Already v2 — nothing to migrate.`);
    return;
  }

  const { registry } = migrateRegistry(raw);
  const entries = Object.keys(registry.features).length;

  if (dryRun) {
    console.log(
      `  ${pc.green("✓")} Would migrate ${entries} entries to v2 (legacy sources/mappings → primary_sources).`,
    );
    console.log(
      pc.dim(
        "  Review primary_sources vs related_sources and add risk hints by hand after migrating.",
      ),
    );
    return;
  }

  const backupPath = nextBackupPath(root);
  copyFileSync(registryPath, backupPath);
  await writeRegistry(registryPath, registry);

  console.log(
    `  ${pc.green("✓")} Migrated ${entries} entries to v2 (backup: ${backupPath.replace(root + "/", "")}).`,
  );
  console.log(
    pc.dim(
      "  Next: split related_sources out of primary_sources and add risk hints where ownership needs human judgment.",
    ),
  );
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
