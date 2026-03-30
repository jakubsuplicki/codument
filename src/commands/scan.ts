import { existsSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import pc from "picocolors";
import { readRegistry, writeRegistry } from "../lib/registry.js";
import { ensureDir } from "../lib/scaffold.js";

interface FeatureGroup {
  name: string;
  type: "feature" | "concept";
  sources: string[];
}

interface ScanOptions {
  root?: string;
}

export async function scan(options: ScanOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();
  console.log(pc.bold("codument scan"));
  console.log();

  const registryPath = join(root, "docs", ".registry.json");
  if (!existsSync(registryPath)) {
    console.log(
      pc.red("  Error: docs/.registry.json not found. Run `codument init` first."),
    );
    process.exitCode = 1;
    return;
  }

  const srcDir = existsSync(join(root, "src")) ? "src" : ".";
  console.log(`  Scanning ${pc.cyan(srcDir + "/")}...`);
  console.log();

  // Collect source files
  const sourceFiles = await collectSourceFiles(join(root, srcDir), root);
  console.log(`  Found ${pc.cyan(String(sourceFiles.length))} source files`);

  // Group into features by directory structure
  const features = groupIntoFeatures(sourceFiles, srcDir);
  console.log(`  Identified ${pc.cyan(String(features.length))} features/concepts`);
  console.log();

  // Read existing registry
  const registry = await readRegistry(registryPath);
  const today = new Date().toISOString().split("T")[0];

  let created = 0;
  let skipped = 0;

  for (const feature of features) {
    const existingEntry = registry.features[feature.name];
    if (existingEntry && existsSync(join(root, existingEntry.doc))) {
      skipped++;
      continue;
    }

    const docDir = feature.type === "feature" ? "features" : "concepts";
    const docPath = `docs/${docDir}/${feature.name}.md`;
    const fullDocPath = join(root, docPath);

    ensureDir(dirname(fullDocPath));

    // Create minimal scaffold — Claude fills in the content via the skill
    const docContent = scaffoldDoc(feature, today);
    await writeFile(fullDocPath, docContent);

    registry.features[feature.name] = {
      doc: docPath,
      type: feature.type,
      sources: feature.sources,
      depends_on: [],
      last_updated: today,
      status: "needs-review",
    };

    console.log(`  ${pc.green("✓")} Created ${pc.dim(docPath)}`);
    created++;
  }

  if (skipped > 0) {
    console.log(`  ${pc.dim(`Skipped ${skipped} already-documented features`)}`);
  }

  await writeRegistry(registryPath, registry);
  console.log();
  console.log(`  ${pc.green("✓")} Updated docs/.registry.json`);

  // Track scan results in .codument-meta.json
  const metaPath = join(root, ".codument-meta.json");
  let meta: Record<string, unknown> = {};
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(await readFile(metaPath, "utf-8"));
    } catch {
      meta = {};
    }
  }
  meta.lastScan = {
    date: today,
    featuresFound: features.length,
    docsCreated: created,
    skipped,
    sourceFiles: sourceFiles.length,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");

  console.log();
  console.log(pc.bold("  Summary:"));
  console.log(`    Features found:    ${features.length}`);
  console.log(`    Docs created:      ${created}`);
  console.log(`    Already documented: ${skipped}`);
  console.log();

  if (created > 0) {
    console.log(pc.bold("  Next step:"));
    console.log(`    Open Claude Code and run ${pc.cyan("/update-docs")}`);
    console.log();
  }
}

// ── File collection ────────────────────────────────────────────────────

async function collectSourceFiles(
  dir: string,
  root: string,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git", ".claude"].includes(entry.name))
        continue;
      files.push(...(await collectSourceFiles(fullPath, root)));
    } else if (
      /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(relative(root, fullPath));
    }
  }
  return files;
}

// ── Grouping ───────────────────────────────────────────────────────────

function groupIntoFeatures(
  files: string[],
  srcDir: string,
): FeatureGroup[] {
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const parts = file.split("/");
    const srcParts = srcDir === "." ? parts : parts.slice(1);

    let groupName: string;
    if (srcParts.length === 1) {
      // Root-level files go to _root (skipped) — they're entry points or configs
      groupName = "_root";
    } else {
      groupName = srcParts[0];
    }

    const existing = groups.get(groupName) ?? [];
    existing.push(file);
    groups.set(groupName, existing);
  }

  const features: FeatureGroup[] = [];

  for (const [groupName, groupFiles] of groups) {
    if (groupName === "_root") continue;

    const isConcept = ["lib", "utils", "helpers", "types", "shared", "common"].includes(groupName);

    features.push({
      name: groupName,
      type: isConcept ? "concept" : "feature",
      sources: groupFiles,
    });
  }

  return features;
}

// ── Doc scaffolding ────────────────────────────────────────────────────

function scaffoldDoc(feature: FeatureGroup, date: string): string {
  const sourcesYaml = feature.sources.map((s) => `  - ${s}`).join("\n");
  const keyFiles = feature.sources
    .map((s) => `- \`${s}\``)
    .join("\n");

  return `---
title: ${feature.name}
status: active
type: ${feature.type}
owner: ""
sources:
${sourcesYaml}
depends_on: []
last_reviewed: ${date}
---

## Summary

<!-- To be filled in by Claude Code using the update-docs skill -->

## How it works

<!-- To be filled in by Claude Code using the update-docs skill -->

## Key files

${keyFiles}
`;
}
