import { existsSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import pc from "picocolors";
import { readRegistry, writeRegistry } from "../lib/registry.js";
import { DEFAULT_EXCLUSION_SPEC } from "../lib/analyze.js";
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

    // Create minimal scaffold — an agent fills in the content via update-docs.
    const docContent = scaffoldDoc(feature, today);
    await writeFile(fullDocPath, docContent);

    registry.features[feature.name] = {
      doc: docPath,
      type: feature.type,
      primary_sources: feature.sources,
      related_sources: [],
      docs: [],
      depends_on: [],
      risk: [],
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
    console.log(`    Open your coding agent and run ${pc.cyan("/update-docs")}`);
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
      // Shared with the analyzer so source discovery never disagrees.
      if (DEFAULT_EXCLUSION_SPEC.dirs.includes(entry.name)) continue;
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
  const keyFiles = feature.sources.map((s) => `- \`${s}\``).join("\n");

  // Generated docs carry the audience layers (see docs/concepts/doc-audience-layers.md)
  // from the start: a plain-language front door, an optional technical dive, and the
  // durable "why". scan can only guess ownership by directory, so every file is placed
  // in primary_sources with status needs-review and an explicit ambiguity marker.
  return `---
title: ${feature.name}
status: needs-review
type: ${feature.type}
owner: ""
primary_sources:
${sourcesYaml}
related_sources: []
depends_on: []
risk: []
last_reviewed: ${date}
---

# ${feature.name}

## In plain terms

<!-- What this does and why it exists. A few sentences, no jargon. Fill in during plan-with-docs. -->

## Design approach

<!-- Why it is shaped this way, at role level. No identifiers, counts, or call order — that is mechanism and it lives in the code. -->

## Invariants & boundaries

<!-- What must hold or is forbidden — landmines not visible in local code. Link each to its enforcing test, or mark "untested". -->

## Decisions

<!-- Pointers to ADRs. The durable why; reference, never restate. -->

## Key files

${keyFiles}

<!-- codument:ambiguity scan grouped these files by directory and assumed all are primary_sources (owned). Review which belong in related_sources, add depends_on/risk, then set status to current. -->
`;
}
