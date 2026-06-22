import pc from "picocolors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute, relative } from "node:path";
import {
  parseFeatureMap,
  routeFile,
  type FeatureMap,
  type FeatureMapRow,
} from "../lib/feature-map.js";
import { findActivePlans } from "../lib/plan-steps.js";
import { readRegistrySync, updateRegistryEntry } from "../lib/registry.js";
import { ensureDir } from "../lib/scaffold.js";

// `codument map` — the deterministic consumer of the plan doc's Feature Map.
// This is what makes the Map a routing table the loop is FORCED to obey rather
// than prose the agent can ignore (the failure that produced the one-feature
// "plinko" collapse). Three capabilities:
//   route <file>      → which feature owns this path (read-only)
//   check             → is the Map well-formed, and does its shape look too coarse
//   materialize <file>→ create/extend the owning feature's registry entry + doc
// work-step (Step 5) runs `materialize` before recording each landed source, so
// files land in the right feature as they are written — never lumped.

interface MapCliOptions {
  file?: string;
  plan?: string;
  json?: boolean;
  root?: string;
  dir?: string;
}

interface ResolvedMap {
  planPath: string;
  markdown: string;
  map: FeatureMap;
}

function resolveMap(root: string, planOpt?: string): ResolvedMap | { error: string } {
  let planPath: string;
  if (planOpt) {
    planPath = isAbsolute(planOpt) ? planOpt : join(root, planOpt);
  } else {
    const found = findActivePlans(root);
    if (found.length === 0)
      return { error: "no approved plan with an unchecked step — pass --plan <path>" };
    if (found.length > 1)
      return {
        error: `multiple approved plans (${found.map((p) => p.path).join(", ")}) — pass --plan <path>`,
      };
    planPath = join(root, found[0].path);
  }
  let markdown: string;
  try {
    markdown = readFileSync(planPath, "utf-8");
  } catch {
    return { error: `could not read plan doc: ${planOpt ?? planPath}` };
  }
  return { planPath, markdown, map: parseFeatureMap(markdown) };
}

// ── Materialization (the testable writer core) ──────────────────────────────

export type MaterializeStatus = "created" | "updated" | "noop" | "unmapped" | "ambiguous";

export interface MaterializeResult {
  file: string;
  feature: string | null;
  status: MaterializeStatus;
  docPath?: string;
  secondaryUpdated: string[];
}

function scaffoldDoc(key: string, row: FeatureMapRow, file: string, date: string): string {
  const seed = row.responsibility || "<!-- what this does and why it exists -->";
  return `---
title: ${key}
status: needs-review
type: ${row.type}
owner: ""
primary_sources:
  - ${file}
related_sources: []
docs: []
depends_on: []
risk: []
last_updated: ${date}
---

# ${key}

## In plain terms

${seed}

## How it works

<!-- Optional technical dive-in: architecture, data flow, trade-offs. -->

## Decisions

<!-- The durable "why" (ADR-lite). -->
`;
}

/**
 * Route `file` (repo-relative) through `rows` and reflect the result into the
 * registry, idempotently. Creates the owning feature's entry + a doc scaffold
 * (seeded from the Map responsibility) the first time its key is absent; appends
 * the file to an existing entry's primary_sources otherwise. Secondary features
 * gain the file in their related_sources only if they already exist. An unmapped
 * or ambiguous file is NOT written — the caller surfaces the flag.
 */
export function materializeFile(root: string, rows: FeatureMapRow[], file: string): MaterializeResult {
  const route = routeFile(rows, file);
  if (route.ambiguous) return { file, feature: null, status: "ambiguous", secondaryUpdated: [] };
  if (!route.feature || !route.row)
    return { file, feature: null, status: "unmapped", secondaryUpdated: [] };

  const registryPath = join(root, "docs", ".registry.json");
  const today = new Date().toISOString().split("T")[0];
  const key = route.feature;
  const row = route.row;
  const docDir = row.type === "feature" ? "features" : "concepts";
  const docPath = `docs/${docDir}/${key}.md`;

  const existing = readRegistrySync(registryPath).features[key];
  let status: MaterializeStatus;
  if (!existing) {
    const absDoc = join(root, docPath);
    if (!existsSync(absDoc)) {
      ensureDir(dirname(absDoc));
      writeFileSync(absDoc, scaffoldDoc(key, row, file, today));
    }
    updateRegistryEntry(registryPath, key, {
      doc: docPath,
      type: row.type,
      primary_sources: [file],
      status: "needs-review",
    });
    status = "created";
  } else if (existing.primary_sources.includes(file)) {
    status = "noop";
  } else {
    updateRegistryEntry(registryPath, key, {
      primary_sources: [...existing.primary_sources, file],
    });
    status = "updated";
  }

  const secondaryUpdated: string[] = [];
  for (const sec of row.secondary) {
    const secEntry = readRegistrySync(registryPath).features[sec];
    if (
      secEntry &&
      !secEntry.related_sources.includes(file) &&
      !secEntry.primary_sources.includes(file)
    ) {
      updateRegistryEntry(registryPath, sec, {
        related_sources: [...secEntry.related_sources, file],
      });
      secondaryUpdated.push(sec);
    }
  }

  return { file, feature: key, status, docPath, secondaryUpdated };
}

// ── Suspicious-shape check (deterministic, info-level) ──────────────────────

const BROAD_GLOBS = new Set(["**", "*", "src/**", "src/*", "**/*"]);

export interface ShapeWarning {
  message: string;
}

/** Deterministic, info-level shape smells on a parsed Map — never asserts the
 *  cut is wrong, only that the shape looks too coarse to resolve. */
export function shapeWarnings(map: FeatureMap): ShapeWarning[] {
  const out: ShapeWarning[] = [];
  const feats = map.rows.filter((r) => r.type === "feature");
  if (map.rows.length === 1) {
    out.push({ message: "the Feature Map has a single row — a one-feature project cannot resolve blast/cost/drift" });
  }
  for (const r of map.rows) {
    if (BROAD_GLOBS.has(r.pathOrGlob)) {
      out.push({ message: `row "${r.pathOrGlob} | ${r.feature}" is an umbrella glob over all sources — likely under-decomposed` });
    }
  }
  if (feats.length === 1 && map.rows.length > 1) {
    out.push({ message: "only one feature-type row (the rest are concepts) — confirm the app really is one feature" });
  }
  return out;
}

// ── CLI actions ─────────────────────────────────────────────────────────────

function toRepoRel(root: string, file: string): string {
  const abs = isAbsolute(file) ? file : join(root, file);
  return relative(root, abs).split("\\").join("/");
}

export function mapRoute(options: MapCliOptions = {}): void {
  const root = options.root ?? options.dir ?? process.cwd();
  if (!options.file) {
    console.log(pc.yellow("codument map route: missing <file>"));
    process.exitCode = 1;
    return;
  }
  const resolved = resolveMap(root, options.plan);
  if ("error" in resolved) {
    console.log(pc.yellow("codument map route: " + resolved.error));
    process.exitCode = 1;
    return;
  }
  const file = toRepoRel(root, options.file);
  const r = routeFile(resolved.map.rows, file);
  if (options.json) {
    console.log(JSON.stringify({ file, feature: r.feature, secondary: r.secondary, ambiguous: r.ambiguous }));
    return;
  }
  if (r.ambiguous) console.log(pc.yellow(`${file} → ambiguous (two glob rows tie)`));
  else if (!r.feature) console.log(pc.yellow(`${file} → unmapped`));
  else console.log(`${file} → ${pc.bold(r.feature)}${r.secondary.length ? pc.dim(` (+${r.secondary.join(", ")})`) : ""}`);
}

export function mapCheck(options: MapCliOptions = {}): void {
  const root = options.root ?? options.dir ?? process.cwd();
  const resolved = resolveMap(root, options.plan);
  if ("error" in resolved) {
    console.log(pc.yellow("codument map check: " + resolved.error));
    process.exitCode = 1;
    return;
  }
  const { map } = resolved;
  const errors = map.errors;
  const warnings = shapeWarnings(map);

  if (map.rows.length === 0 && errors.length === 0) {
    console.log(pc.yellow("codument map check: no `feature-map` block in the plan"));
    process.exitCode = 1;
    return;
  }
  for (const e of errors) console.log(pc.red(`  ✗ line ${e.line}: ${e.message}`));
  for (const w of warnings) console.log(pc.yellow(`  ▲ ${w.message}`));
  if (errors.length === 0 && warnings.length === 0) {
    console.log(pc.green(`  ✓ Feature Map OK — ${map.rows.length} rows`));
  }
  if (errors.length > 0) process.exitCode = 1; // malformed Map is a real, blocking problem
}

export function mapMaterialize(options: MapCliOptions = {}): void {
  const root = options.root ?? options.dir ?? process.cwd();
  if (!options.file) {
    console.log(pc.yellow("codument map materialize: missing <file>"));
    process.exitCode = 1;
    return;
  }
  const resolved = resolveMap(root, options.plan);
  if ("error" in resolved) {
    console.log(pc.yellow("codument map materialize: " + resolved.error));
    process.exitCode = 1;
    return;
  }
  const file = toRepoRel(root, options.file);
  const result = materializeFile(root, resolved.map.rows, file);
  if (result.status === "unmapped") {
    console.log(pc.yellow(`  ⚠ ${file} is not in the Feature Map — add a row or fix the path (not lumped)`));
    process.exitCode = 1;
    return;
  }
  if (result.status === "ambiguous") {
    console.log(pc.yellow(`  ⚠ ${file} matches two glob rows ambiguously — tighten the Map`));
    process.exitCode = 1;
    return;
  }
  const verb = result.status === "created" ? "created" : result.status === "updated" ? "added to" : "already in";
  console.log(`  ✓ ${file} ${verb} ${pc.bold(result.feature!)}${result.secondaryUpdated.length ? pc.dim(` (+secondary ${result.secondaryUpdated.join(", ")})`) : ""}`);
}
