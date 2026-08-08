import pc from "picocolors";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute, relative } from "node:path";
import {
  parseFeatureMap,
  routeFile,
  hasFeatureMapHeading,
  type FeatureMap,
  type FeatureMapRow,
} from "../lib/feature-map.js";
import { findActivePlans } from "../lib/plan-steps.js";
import { readRegistrySync, updateRegistryEntry, ExcludedSourceError } from "../lib/registry.js";
import { resolveScopeSync, declaredRuleFor } from "../lib/analyze.js";
import { gatherPlanGrounding } from "../lib/plan-grounding.js";
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
  /** Name the owning feature outright, with no Feature Map in the loop — the
   *  post-ship route for a repo whose plans have shipped and compacted their Maps
   *  away. Must name an entry that already exists. */
  feature?: string;
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

export type MaterializeStatus =
  | "created"
  | "updated"
  | "noop"
  | "unmapped"
  | "ambiguous"
  | "unknown-feature";

export interface MaterializeResult {
  file: string;
  feature: string | null;
  status: MaterializeStatus;
  docPath?: string;
  secondaryUpdated: string[];
  /** Every FEATURE now claiming this file as primary, when there is more than one
   *  and none of them has claimed a symbol on it. This call is the moment the
   *  shared-file churn is created — from here every edit to the file wakes all of
   *  these docs until the registry says who owns what — and it used to pass in
   *  silence, so the cost was only ever met later, at a red gate, by someone who
   *  had no idea a second claim had been added. */
  sharedPrimary?: string[];
}

/** The FEATURES claiming `file` as primary with no per-symbol claim anywhere among
 *  them — empty unless that is genuinely more than one. A deliberate split whose
 *  owners are already authored is not warned about: it is the resolved state. */
function unclaimedSharedOwners(root: string, file: string): string[] {
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  const owners = Object.entries(registry.features)
    .filter(([, e]) => e.type === "feature" && e.primary_sources.includes(file))
    .map(([key]) => key)
    .sort();
  if (owners.length < 2) return [];
  const claimed = owners.some(
    (key) => (registry.features[key].owned_symbols?.[file] ?? []).length > 0,
  );
  return claimed ? [] : owners;
}

function scaffoldDoc(key: string, row: FeatureMapRow, file: string, date: string): string {
  const seed = row.responsibility || "<!-- what this does and why it exists -->";
  // Frontmatter carries prose-side identity only; ownership lives solely in
  // docs/.registry.json (ADR 001) — the materialize call writes the entry there.
  return `---
title: ${key}
status: needs-review
type: ${row.type}
last_reviewed: ${date}
---

# ${key}

## In plain terms

${seed}

## Design approach

<!-- Why it is shaped this way, at role level. No identifiers, counts, or call order — that is mechanism and it lives in the code. -->

## Invariants & boundaries

<!-- What must hold or is forbidden — landmines not visible in local code. Link each to its enforcing test, or mark "untested". -->

## Decisions

<!-- Pointers to ADRs. The durable why; reference, never restate. -->

## Key files

- \`${file}\` <!-- narrative role: orchestrator / analyzer / seam -->
`;
}

/**
 * Materialize `file` into an EXISTING feature named outright, with no Feature Map
 * in the loop. The post-ship route: a plan's Map is compacted out of its doc when
 * the work ships (the standard requires it), which left every later file addition
 * or rename on a refusal pointing at a plan that no longer carries a Map — two
 * mandated behaviors disabling each other, with a hand-edited registry as the only
 * way out.
 *
 * Deliberately refuses an unknown slug rather than inventing the feature: creating
 * one needs a responsibility line to seed its doc, and that is exactly what a Map
 * row carries and a bare flag cannot. Naming a new feature is new work, and new
 * work gets a plan. Secondary routing stays Map-only for the same reason.
 */
export function materializeFileTo(
  root: string,
  file: string,
  featureKey: string,
): MaterializeResult {
  const registryPath = join(root, "docs", ".registry.json");
  const existing = readRegistrySync(registryPath).features[featureKey];
  if (!existing) return { file, feature: null, status: "unknown-feature", secondaryUpdated: [] };
  if (existing.primary_sources.includes(file))
    return { file, feature: featureKey, status: "noop", docPath: existing.doc, secondaryUpdated: [] };

  const scope = resolveScopeSync(root);
  try {
    updateRegistryEntry(
      registryPath,
      featureKey,
      { primary_sources: [...existing.primary_sources, file] },
      scope.spec,
    );
  } catch (err) {
    // Same rule-naming courtesy the Map path gives: a project's own declaration
    // and a built-in heuristic call for different responses.
    if (err instanceof ExcludedSourceError && !err.rule) {
      const rule = declaredRuleFor(err.path, scope.configured);
      if (rule) throw new ExcludedSourceError(err.key, err.path, err.field, rule);
    }
    throw err;
  }
  return {
    file,
    feature: featureKey,
    status: "updated",
    docPath: existing.doc,
    secondaryUpdated: [],
    sharedPrimary: unclaimedSharedOwners(root, file),
  };
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

  // Resolve the project's scope ONCE for this materialize. Without it the
  // authoring guard would see only the built-in defaults, leaving a path the
  // project itself declared out of scope quietly authorable through routing.
  const scope = resolveScopeSync(root);
  const register = (entryKey: string, patch: Parameters<typeof updateRegistryEntry>[2]): void => {
    try {
      updateRegistryEntry(registryPath, entryKey, patch, scope.spec);
    } catch (err) {
      // Name which rule fired. The guard cannot: it is handed a resolved spec
      // and never sees whether a default or the project's own declaration put
      // the path there — and the two call for different responses.
      if (err instanceof ExcludedSourceError && !err.rule) {
        const rule = declaredRuleFor(err.path, scope.configured);
        if (rule) throw new ExcludedSourceError(err.key, err.path, err.field, rule);
      }
      throw err;
    }
  };

  const existing = readRegistrySync(registryPath).features[key];
  let status: MaterializeStatus;
  if (!existing) {
    // Register BEFORE scaffolding. The entry write validates the source against
    // the exclusion spec and refuses an out-of-scope path; writing the doc first
    // would strand an unregistered scaffold on disk for a feature that never
    // came into existence.
    register(key, {
      doc: docPath,
      type: row.type,
      primary_sources: [file],
      status: "needs-review",
    });
    const absDoc = join(root, docPath);
    if (!existsSync(absDoc)) {
      ensureDir(dirname(absDoc));
      writeFileSync(absDoc, scaffoldDoc(key, row, file, today));
    }
    status = "created";
  } else if (existing.primary_sources.includes(file)) {
    status = "noop";
  } else {
    register(key, {
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
      register(sec, {
        related_sources: [...secEntry.related_sources, file],
      });
      secondaryUpdated.push(sec);
    }
  }

  return {
    file,
    feature: key,
    status,
    docPath,
    secondaryUpdated,
    sharedPrimary: unclaimedSharedOwners(root, file),
  };
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

  // A plan that WROTE a "Feature Map" heading but produced no parseable rows and
  // no errors authored the routing table in the wrong form (a table or prose
  // instead of a fenced ```feature-map``` block). That is NOT the same as a plan
  // with no Feature Map at all: the former silently routes nothing, so the plan
  // adversary's proportionality skip would wrongly bypass it. Flag it loudly.
  const malformedMap =
    map.rows.length === 0 && errors.length === 0 && hasFeatureMapHeading(resolved.markdown);
  const noBlockMessage = malformedMap
    ? "a `Feature Map` heading is present but no parseable ```feature-map``` block was found — write the routing table as a fenced ```feature-map``` block (`path | feature | type | responsibility`), not a table or prose"
    : "no `feature-map` block in the plan";

  // --json is the adversary's channel: alongside the shape verdict it emits the
  // plan grounding (the committed invariants/tests/deps/risk of every feature the
  // Map routes to) so the plan adversary attacks a real contract instead of
  // hallucinating one. The human `check` output below stays lean and unchanged.
  if (options.json) {
    const grounding =
      map.rows.length > 0
        ? gatherPlanGrounding(
            root,
            map.rows,
            readRegistrySync(join(root, "docs", ".registry.json")),
          )
        : { features: [], unknownFeatures: [] };
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0 && map.rows.length > 0,
          hasMap: map.rows.length > 0,
          // The plan intended a Feature Map but it did not parse — the skill must
          // flag this, not treat the plan as source-free and skip the adversary.
          malformedMap,
          rows: map.rows.length,
          errors: errors.map((e) => ({ line: e.line, message: e.message })),
          warnings: warnings.map((w) => w.message),
          grounding,
        },
        null,
        2,
      ),
    );
    if (errors.length > 0 || map.rows.length === 0) process.exitCode = 1;
    return;
  }

  if (map.rows.length === 0 && errors.length === 0) {
    console.log(
      malformedMap
        ? pc.red("  ✗ " + noBlockMessage)
        : pc.yellow("codument map check: " + noBlockMessage),
    );
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
  const file = toRepoRel(root, options.file);

  // The explicit route: name the owning feature outright. This is what a plan's
  // Feature Map row records, made inline for a repo whose plans have all shipped
  // (and whose Maps are therefore compacted away).
  if (options.feature) {
    const direct = materializeFileTo(root, file, options.feature);
    if (direct.status === "unknown-feature") {
      const known = Object.keys(
        readRegistrySync(join(root, "docs", ".registry.json")).features,
      ).sort();
      console.log(
        pc.yellow(`codument map materialize: no registry entry named "${options.feature}"`),
      );
      console.log(
        pc.dim(
          known.length > 0
            ? `  known features: ${known.join(", ")}`
            : "  the registry has no entries yet — run `codument scan` or plan the feature first",
        ),
      );
      console.log(
        pc.dim(
          "  A NEW feature needs a responsibility line to seed its doc, which a plan's Feature Map row carries — plan it rather than naming it here.",
        ),
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `  ✓ ${file} ${direct.status === "updated" ? "added to" : "already in"} ${pc.bold(direct.feature!)}`,
    );
    printSharedPrimaryWarning(direct);
    return;
  }

  const resolved = resolveMap(root, options.plan);
  if ("error" in resolved) {
    console.log(pc.yellow("codument map materialize: " + resolved.error));
    // The refusal is a signpost, not a dead end: a shipped plan has had its Map
    // compacted out, so pointing at it cannot work and the explicit route is the
    // one that does.
    console.log(
      pc.dim(
        "  Working past a shipped plan? Name the owner directly: `codument map materialize <file> --feature <slug>`",
      ),
    );
    process.exitCode = 1;
    return;
  }
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
  printSharedPrimaryWarning(result);
}

/**
 * Say it at the moment the shared claim is made, not at the red gate weeks later.
 * From here, every edit to this file wakes all of these docs until the registry
 * says who owns what — which is a cost worth accepting deliberately and never
 * worth paying by accident. A warning, never a refusal: a genuine multi-owner file
 * is a legitimate thing to have, and the tool does not get to decide otherwise.
 */
function printSharedPrimaryWarning(result: MaterializeResult): void {
  const owners = result.sharedPrimary ?? [];
  if (owners.length < 2) return;
  console.log(
    pc.yellow(`  ⚠ ${result.file} is now primary for ${owners.length} features: ${owners.join(", ")}`),
  );
  console.log(
    pc.dim("    Every edit to it will wake all of them until one of these is true:"),
  );
  console.log(
    pc.dim(`    · a symbol on it is claimed — "owned_symbols": { ${JSON.stringify(result.file)}: ["<descriptor>"] }`),
  );
  console.log(
    pc.dim("    · one feature keeps it primary and the rest carry it in related_sources (a `[secondary: ...]` Map row does this)"),
  );
}
