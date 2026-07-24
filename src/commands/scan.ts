import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import pc from "picocolors";
import { readRegistry, writeRegistry } from "../lib/registry.js";
import { atomicWriteFileSync } from "../lib/events.js";
import { readJsonFileOrThrow } from "../lib/state-io.js";
import {
  discoverSourceFiles,
  makeIgnoredPredicate,
  resolveScopeSync,
} from "../lib/analyze.js";
import { listIgnoredPaths, resolveWorkspace } from "../lib/git.js";
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
    // Zero-commitment entry point: on an unadopted repo scan CREATES the
    // provisional registry (the `scan → audit` trial recipe depends on this).
    // It proposes a mapping and writes scaffolds — it installs no workflow;
    // `init` remains the installer.
    console.log(pc.yellow("  No docs/.registry.json yet — creating a provisional one."));
    console.log();
    ensureDir(dirname(registryPath));
  }

  const srcDir = existsSync(join(root, "src")) ? "src" : ".";
  console.log(`  Scanning ${pc.cyan(srcDir + "/")}...`);
  const workspace = resolveWorkspace(root);
  if (workspace.isWorkspace) {
    console.log(
      pc.cyan(
        `  workspace: ${workspace.members.length} member repositories (${workspace.members.map((m) => m.prefix || "<root>").join(", ")}) — git scope aggregated`,
      ),
    );
  }
  console.log();

  // Discovery runs through the analyzer's own walker, gitignore predicate and
  // all — the same function, not a copy of it. scan's previous private walker
  // shared the exclusion spec but had silently dropped the ignore predicate, so
  // it proposed build output the coverage analyzer would never have counted.
  // Two walkers is how they came to disagree; there is now one.
  const ignoredListing = listIgnoredPaths(root);
  // A registry entry is durable, so scan is the one consumer that cannot degrade
  // past an unreadable declaration: the writes below outlive the run, and a build
  // tree swept into `primary_sources` because the declaration could not be read
  // is a wrong answer with no expiry. Refuse before anything is written, rather
  // than write first and discover the unreadable file on the telemetry pass.
  const { spec: exclusion, unreadable } = resolveScopeSync(root);
  if (unreadable) {
    console.log(pc.red(`  ✗ ${unreadable}`));
    console.log(
      pc.dim(
        "    scan writes durable registry entries, so it will not propose a scope it could not read. Repair or remove .codument-meta.json, then re-run.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  const discovery = discoverSourceFiles(
    root,
    srcDir,
    exclusion,
    makeIgnoredPredicate(ignoredListing.ok ? ignoredListing.paths : []),
  );
  const sourceFiles = discovery.paths;
  console.log(`  Found ${pc.cyan(String(sourceFiles.length))} source files`);
  // Without the ignore rules the walk cannot tell build output from source, and
  // scan is the moment that decision becomes a durable registry entry. Say so
  // here rather than let the user discover it as a suspiciously good score.
  if (!ignoredListing.ok) {
    console.log(
      pc.cyan(
        `  note: ${ignoredListing.reason} — .gitignore rules were not applied, so build output may be proposed below`,
      ),
    );
    // The note's call to action. Without ignore rules, declaring the tree is the
    // only remaining way to keep it out of a registry this run is about to write.
    console.log(
      pc.dim(
        '        build output swept in? declare it: "exclude": { "dirs": ["out"] } in .codument-meta.json',
      ),
    );
  }
  // A directory the walk could not read omits whatever is under it, so the
  // proposal below is a floor rather than the mapping. A NOTE, not the refusal
  // an unreadable declaration gets: that one risks writing WRONG entries with no
  // expiry, while this one only omits — a later run picks them up, and a
  // permanently unreadable tree (a root-owned mount) would otherwise make scan
  // unusable rather than merely incomplete.
  if (discovery.unreadable.length > 0) {
    console.log(
      pc.cyan(
        `  note: ${discovery.unreadable.length} ${discovery.unreadable.length === 1 ? "directory" : "directories"} could not be read, so sources under ${discovery.unreadable.length === 1 ? "it are" : "them are"} not proposed: ${discovery.unreadable.join(", ")}`,
      ),
    );
  }
  const declared = resolveScopeSync(root).configured;
  if (declared) {
    const parts: string[] = [];
    if (declared.dirs?.length) parts.push(`dirs: ${declared.dirs.join(", ")}`);
    if (declared.globs?.length) parts.push(`globs: ${declared.globs.join(", ")}`);
    console.log(pc.cyan(`  scope: also excluding ${parts.join(" · ")} — .codument-meta.json`));
  }

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
    // Fully documented already (entry + its doc on disk): leave it untouched.
    if (existingEntry && existsSync(join(root, existingEntry.doc))) {
      skipped++;
      continue;
    }

    // Keep an existing entry's own doc path; only derive one for a new feature.
    const docDir = feature.type === "feature" ? "features" : "concepts";
    const docPath = existingEntry?.doc ?? `docs/${docDir}/${feature.name}.md`;
    const fullDocPath = join(root, docPath);

    // Never overwrite a doc that already exists on disk — a human-authored file
    // (or one owned by another entry) is left exactly as-is. Scaffold only when
    // the path is free.
    if (existsSync(fullDocPath)) {
      skipped++;
      console.log(`  ${pc.dim(`Skipped ${docPath} — file already exists`)}`);
    } else {
      ensureDir(dirname(fullDocPath));
      await writeFile(fullDocPath, scaffoldDoc(feature, today));
      console.log(`  ${pc.green("✓")} Created ${pc.dim(docPath)}`);
      created++;
    }

    // Preserve a human-curated entry's fields (depends_on, risk, related_sources,
    // docs, status); refresh only the scanned sources. A brand-new feature gets a
    // fresh needs-review entry.
    registry.features[feature.name] = existingEntry
      ? { ...existingEntry, primary_sources: feature.sources }
      : {
          doc: docPath,
          type: feature.type,
          primary_sources: feature.sources,
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          status: "needs-review",
        };
  }

  if (skipped > 0) {
    console.log(`  ${pc.dim(`Skipped ${skipped} already-documented features`)}`);
  }

  await writeRegistry(registryPath, registry);
  console.log();
  console.log(`  ${pc.green("✓")} Updated docs/.registry.json`);

  // Track scan results in .codument-meta.json. Readable by construction: the
  // scope resolution above refused the run if this file could not be parsed, so
  // this read cannot be the first place a corrupt meta is discovered — which is
  // what previously let the registry writes above land before the failure.
  const metaPath = join(root, ".codument-meta.json");
  const meta =
    readJsonFileOrThrow<Record<string, unknown>>(metaPath, "project metadata") ?? {};
  meta.lastScan = {
    date: today,
    featuresFound: features.length,
    docsCreated: created,
    skipped,
    sourceFiles: sourceFiles.length,
    // Durable, because the registry this run wrote is durable. A console note
    // dies with the terminal; the entries it qualified outlive it, and a later
    // reader needs to know these sources were proposed without the ignore rules.
    ...(ignoredListing.ok ? {} : { scopeUnverified: ignoredListing.reason }),
    // Durable for the same reason: the entries this run wrote were proposed over
    // a tree it could not fully read, and a later reader needs to know that.
    ...(discovery.unreadable.length > 0
      ? { unreadableDirs: discovery.unreadable }
      : {}),
  };
  atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

  console.log();
  console.log(pc.bold("  Summary:"));
  console.log(`    Features found:    ${features.length}`);
  console.log(`    Docs created:      ${created}`);
  console.log(`    Already documented: ${skipped}`);
  if (!ignoredListing.ok) {
    // Repeated here on purpose: the Summary is what a reader skims, and this
    // qualifies every number above it.
    console.log(
      pc.cyan(`    Scope:             unverified — .gitignore rules were not applied`),
    );
  }
  console.log();

  if (created > 0) {
    console.log(pc.bold("  Next step:"));
    console.log(`    Open your coding agent and run ${pc.cyan("/update-docs")}`);
    console.log();
  }
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
  const keyFiles = feature.sources.map((s) => `- \`${s}\``).join("\n");

  // Generated docs carry the audience layers (see docs/concepts/doc-audience-layers.md)
  // from the start: a plain-language front door, an optional technical dive, and the
  // durable "why". Frontmatter carries prose-side identity only (title/status/type/
  // last_reviewed): ownership, dependencies, and risk live solely in
  // docs/.registry.json — an unvalidated frontmatter copy only drifts (ADR 001).
  // scan can only guess ownership by directory, so every file lands in the registry
  // entry's primary_sources with status needs-review and an explicit ambiguity marker.
  return `---
title: ${feature.name}
status: needs-review
type: ${feature.type}
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

<!-- codument:ambiguity scan grouped these files by directory and registered them all as primary_sources (owned) in docs/.registry.json. Review ownership there (move shared files to related_sources, add depends_on/risk), then set status to current. -->
`;
}
