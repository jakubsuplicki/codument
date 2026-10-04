import pc from "picocolors";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  parseFeatureMap,
  routeFile,
  hasFeatureMapHeading,
  type FeatureMap,
  type FeatureMapRow,
  type RouteResult,
} from "../lib/feature-map.js";
import { resolveActivePlan, parsePlanScope } from "../lib/plan-steps.js";
import { workPlanSelection, workPlanContext } from "../lib/work-state.js";
import {
  ExcludedSourceError,
  assertNoExcludedSource,
  isSourcePattern,
  readRegistrySync,
  normalizeRegistry,
  sourceNames,
  updateRegistryEntry,
  type Registry,
} from "../lib/registry.js";
import { resolveScopeSync, declaredRuleFor } from "../lib/analyze.js";
import { gatherPlanGrounding } from "../lib/plan-grounding.js";
import { ensureDir } from "../lib/scaffold.js";

// `codument map` — the deterministic consumer of the plan doc's Feature Map.
// This is what makes the Map a routing table the loop is FORCED to obey rather
// than prose the agent can ignore (the failure that produced the one-feature
// "plinko" collapse). Three capabilities:
//   route <file>      → which feature owns this path (read-only)
//   check             → is the Map well-formed, and does its shape look too coarse
//   materialize <files...> → create/extend the owners' registry entries + docs
// work-step (Step 5) runs `materialize` before recording each landed source, so
// files land in the right feature as they are written — never lumped.

interface MapCliOptions {
  file?: string;
  files?: string[];
  plan?: string;
  planId?: string;
  json?: boolean;
  root?: string;
  dir?: string;
  /** Name the owning feature outright, with no Feature Map in the loop — the
   *  post-ship route for a repo whose plans have shipped and compacted their Maps
   *  away. Must name an entry that already exists. */
  feature?: string;
}

interface ResolvedMap {
  planId?: string;
  planPath: string;
  markdown: string;
  map: FeatureMap;
}

function resolveMap(root: string, planOpt?: string, planId?: string): ResolvedMap | { error: string } {
  const selection = workPlanSelection(root, { plan: planOpt, planId });
  planOpt = selection.plan;
  planId = selection.planId;
  let planPath: string;
  if (planOpt) {
    planPath = isAbsolute(planOpt) ? planOpt : join(root, planOpt);
  } else {
    const resolved = resolveActivePlan(root);
    if ("error" in resolved) return resolved;
    planPath = join(root, resolved.plan.path);
  }
  let markdown: string;
  try {
    markdown = readFileSync(planPath, "utf-8");
  } catch {
    return { error: `could not read plan doc: ${planOpt ?? planPath}` };
  }
  const retained = workPlanContext(root, toRepoRel(root, planPath), markdown, planId);
  markdown = retained.markdown;
  return { planPath, planId, markdown, map: parseFeatureMap(markdown, planId, retained.approvalModel) };
}

// ── Materialization (the testable writer core) ──────────────────────────────

export type MaterializeStatus =
  | "created"
  | "updated"
  | "noop"
  | "unmapped"
  | "ambiguous"
  | "unknown-feature"
  | "governed";

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
  /** Set with `status: "governed"`: the entry and the pattern already covering this
   *  file. Writing the explicit path would restate what the tree already says, and
   *  the refusal is the only moment anyone learns the tree is doing its job. */
  governedBy?: { feature: string; pattern: string };
}

/**
 * The entry whose declared tree already covers `file`, if any — sorted by key so
 * two entries covering the same path always name the same one. Registering a tree
 * is what makes the per-file line unnecessary; materializing it anyway would grow
 * back the 380 lines the pattern exists to replace, one accidental call at a time.
 */
function governingTree(registry: Registry, file: string): { feature: string; pattern: string } | null {
  for (const key of Object.keys(registry.features).sort()) {
    for (const source of registry.features[key].primary_sources) {
      if (isSourcePattern(source) && sourceNames(source, file)) {
        return { feature: key, pattern: source };
      }
    }
  }
  return null;
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

/** Missing sources and scaffold parents are valid; their nearest existing
 * ancestor still has to resolve within the project. A dangling link is an
 * unreadable ancestor, not an ordinary missing directory. */
function assertContainedPath(root: string, path: string, role: string, requireFile = false): void {
  const rootPath = resolve(root);
  const target = resolve(rootPath, path);
  const outside = (base: string, candidate: string): boolean => {
    const rel = relative(base, candidate);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };
  if (outside(rootPath, target)) throw new Error(`${role} path leaves project root: ${path}`);
  const rootReal = realpathSync(rootPath);
  let ancestor = target;
  while (true) {
    try {
      lstatSync(ancestor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
      continue;
    }
    let canonical: string;
    try { canonical = realpathSync(ancestor); }
    catch { throw new Error(`${role} path has an unreadable or dangling link: ${path}`); }
    if (outside(rootReal, canonical)) throw new Error(`${role} path resolves outside project root: ${path}`);
    if (requireFile && ancestor === target && !statSync(target).isFile()) {
      throw new Error(`${role} path must resolve to a regular file: ${path}`);
    }
    return;
  }
}

function nameExclusion(error: unknown, scope: ReturnType<typeof resolveScopeSync>): unknown {
  if (error instanceof ExcludedSourceError && !error.rule) {
    const rule = declaredRuleFor(error.path, scope.configured);
    if (rule) return new ExcludedSourceError(error.key, error.path, error.field, rule);
  }
  return error;
}

function registerSource(
  root: string,
  key: string,
  patch: Parameters<typeof updateRegistryEntry>[2],
  scope: ReturnType<typeof resolveScopeSync>,
): void {
  assertContainedPath(root, "docs/.registry.json", "registry", true);
  try { updateRegistryEntry(join(root, "docs", ".registry.json"), key, patch, scope.spec); }
  catch (error) { throw nameExclusion(error, scope); }
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
  return materializeDirectFile(root, file, featureKey);
}

function materializeDirectFile(
  root: string,
  file: string,
  featureKey: string,
  scope?: ReturnType<typeof resolveScopeSync>,
): MaterializeResult {
  const registryPath = join(root, "docs", ".registry.json");
  assertContainedPath(root, "docs/.registry.json", "registry", true);
  const registry = readRegistrySync(registryPath);
  const existing = registry.features[featureKey];
  if (!existing) return { file, feature: null, status: "unknown-feature", secondaryUpdated: [] };
  assertContainedPath(root, file, "source", !isSourcePattern(file));
  if (existing.primary_sources.includes(file)) {
    assertContainedPath(root, existing.doc, "doc", true);
    return { file, feature: featureKey, status: "noop", docPath: existing.doc, secondaryUpdated: [] };
  }
  const tree = governingTree(registry, file);
  if (tree) return { file, feature: tree.feature, status: "governed", governedBy: tree, secondaryUpdated: [] };
  assertContainedPath(root, existing.doc, "doc", true);

  registerSource(root, featureKey, { primary_sources: [...existing.primary_sources, file] }, scope ?? resolveScopeSync(root));
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
  return materializeRoutedFile(root, routeFile(rows, file), file);
}

function materializeRoutedFile(
  root: string,
  route: RouteResult,
  file: string,
  withSecondaries = true,
  scope?: ReturnType<typeof resolveScopeSync>,
): MaterializeResult {
  if (route.ambiguous) return { file, feature: null, status: "ambiguous", secondaryUpdated: [] };
  if (!route.feature || !route.row)
    return { file, feature: null, status: "unmapped", secondaryUpdated: [] };
  // A tree already governs it, so there is nothing to materialize — whether the Map
  // routes it to that same entry (the line would be a restatement) or another one (a
  // second claim, which is a decision to make by hand, not a side effect of a routing
  // call). Checked before any write, so the refusal never half-lands.
  assertContainedPath(root, "docs/.registry.json", "registry", true);
  assertContainedPath(root, file, "source", !isSourcePattern(file));
  const registryPath = join(root, "docs", ".registry.json");
  const registry = readRegistrySync(registryPath);
  const tree = governingTree(registry, file);
  if (tree) return { file, feature: tree.feature, status: "governed", governedBy: tree, secondaryUpdated: [] };

  const today = new Date().toISOString().split("T")[0];
  const key = route.feature;
  const row = route.row;
  const docDir = row.type === "feature" ? "features" : "concepts";
  const existing = registry.features[key];
  const docPath = existing?.doc ?? `docs/${docDir}/${key}.md`;
  assertContainedPath(root, docPath, "doc", true);

  // Resolve the project's scope ONCE for this materialize. Without it the
  // authoring guard would see only the built-in defaults, leaving a path the
  // project itself declared out of scope quietly authorable through routing.
  const materialScope = scope ?? resolveScopeSync(root);
  const register = (entryKey: string, patch: Parameters<typeof updateRegistryEntry>[2]): void => {
    registerSource(root, entryKey, patch, materialScope);
  };

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
    status = "created";
  } else if (existing.primary_sources.includes(file)) {
    status = "noop";
  } else {
    register(key, {
      primary_sources: [...existing.primary_sources, file],
    });
    status = "updated";
  }

  // Registration can succeed while scaffolding fails. A retry repairs the
  // missing registered document even when the source itself is already owned.
  const absDoc = join(root, docPath);
  if (!existsSync(absDoc)) {
    assertContainedPath(root, docPath, "doc", true);
    ensureDir(dirname(absDoc));
    writeFileSync(absDoc, scaffoldDoc(key, { ...row, type: existing?.type ?? row.type }, file, today), { flag: "wx" });
  }

  const secondaryUpdated = withSecondaries ? materializeSecondaries(root, row, file, materialScope) : [];

  return {
    file,
    feature: key,
    status,
    docPath,
    secondaryUpdated,
    sharedPrimary: unclaimedSharedOwners(root, file),
  };
}

function materializeSecondaries(
  root: string,
  row: FeatureMapRow,
  file: string,
  scope: ReturnType<typeof resolveScopeSync>,
): string[] {
  const updated: string[] = [];
  for (const key of row.secondary) {
    const entry = readRegistrySync(join(root, "docs", ".registry.json")).features[key];
    if (!entry || entry.related_sources.includes(file) || entry.primary_sources.includes(file)) continue;
    assertContainedPath(root, entry.doc, "doc", true);
    registerSource(root, key, { related_sources: [...entry.related_sources, file] }, scope);
    updated.push(key);
  }
  return updated;
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
  const resolved = resolveMap(root, options.plan, options.planId);
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
  const resolved = resolveMap(root, options.plan, options.planId);
  if ("error" in resolved) {
    console.log(pc.yellow("codument map check: " + resolved.error));
    process.exitCode = 1;
    return;
  }
  const { map } = resolved;
  const errors: Array<{ line?: number; path?: string; message: string }> = [...map.errors];
  const scope = resolveScopeSync(root);
  for (const row of map.rows) {
    try {
      assertNoExcludedSource(row.feature, undefined, { primary_sources: [row.pathOrGlob] }, scope.spec);
    } catch (error) {
      if (!(error instanceof ExcludedSourceError)) throw error;
      const rule = declaredRuleFor(error.path, scope.configured);
      errors.push({
        path: row.pathOrGlob,
        message: rule ? new ExcludedSourceError(error.key, error.path, error.field, rule).message : error.message,
      });
    }
  }
  const warnings = shapeWarnings(map);

  // A plan that WROTE a "Feature Map" heading but produced no parseable rows and
  // no errors authored the routing table in the wrong form (a table or prose
  // instead of a fenced ```feature-map``` block). That is NOT the same as a plan
  // with no Feature Map at all: the former silently routes nothing, so the plan
  // adversary's proportionality skip would wrongly bypass it. Flag it loudly.
  const malformedMap =
    map.rows.length === 0 && errors.length === 0 && hasFeatureMapHeading(resolved.markdown, resolved.planId);
  const noBlockMessage = malformedMap
    ? "a `Feature Map` heading is present but no parseable ```feature-map``` block was found — write the routing table as a fenced ```feature-map``` block (`path | feature | type | responsibility`), not a table or prose"
    : "no `feature-map` block in the plan";

  // --json is the adversary's channel: alongside the shape verdict it emits the
  // plan grounding (the committed invariants/tests/deps/risk of every feature the
  // Map routes to) so the plan adversary attacks a real contract instead of
  // hallucinating one. The human `check` output below stays lean and unchanged.
  if (options.json) {
    const grounding = gatherPlanGrounding(
            root,
            map.rows,
            readRegistrySync(join(root, "docs", ".registry.json")),
            parsePlanScope(resolved.markdown, resolved.planId),
          );
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0 && map.rows.length > 0,
          hasMap: map.rows.length > 0,
          // The plan intended a Feature Map but it did not parse — the skill must
          // flag this, not treat the plan as source-free and skip the adversary.
          malformedMap,
          rows: map.rows.length,
          errors: errors.map((e) => ({ line: e.line, path: e.path, message: e.message })),
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
  for (const e of errors) console.log(pc.red(`  ✗ ${e.path ? `row "${e.path}"` : `line ${e.line}`}: ${e.message}`));
  for (const w of warnings) console.log(pc.yellow(`  ▲ ${w.message}`));
  if (errors.length === 0 && warnings.length === 0) {
    console.log(pc.green(`  ✓ Feature Map OK — ${map.rows.length} rows`));
  }
  if (errors.length > 0) process.exitCode = 1; // malformed Map is a real, blocking problem
}

interface MaterializeItem {
  file: string;
  route?: RouteResult;
  governed?: MaterializeResult;
}

/** Authoring validation is batch-wide. Project all primary owners before
 * checking secondary claims so a later owner in this batch is already known. */
function prepareMaterialization(
  root: string,
  files: string[],
  rows: FeatureMapRow[],
  feature?: string,
): { items: MaterializeItem[]; errors: string[]; scope: ReturnType<typeof resolveScopeSync> } {
  assertContainedPath(root, "docs/.registry.json", "registry", true);
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  const proposed = normalizeRegistry(registry);
  const scope = resolveScopeSync(root);
  const items: MaterializeItem[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      if (!file || file === ".") throw new Error("source path must name a file");
      assertContainedPath(root, file, "source", !isSourcePattern(file));
      const route = feature ? undefined : routeFile(rows, file);
      if (route?.ambiguous) throw new Error(`${file} matches two glob rows ambiguously — tighten the Map`);
      if (route && (!route.feature || !route.row)) throw new Error(`${file} is not in the Feature Map — add a row or fix the path (not lumped)`);
      const key = feature ?? route!.feature!;
      const literalNoop = feature && registry.features[key]?.primary_sources.includes(file);
      const tree = literalNoop ? null : governingTree(registry, file);
      if (tree) {
        items.push({ file, governed: { file, feature: tree.feature, status: "governed", governedBy: tree, secondaryUpdated: [] } });
        continue;
      }
      const existing = proposed.features[key];
      const doc = existing?.doc ?? `docs/${route!.row!.type === "feature" ? "features" : "concepts"}/${key}.md`;
      assertContainedPath(root, doc, "doc", true);
      const patch = existing
        ? { primary_sources: [...existing.primary_sources, file] }
        : { doc, type: route!.row!.type, primary_sources: [file], status: "needs-review" };
      assertNoExcludedSource(key, existing, patch, scope.spec);
      proposed.features[key] = normalizeRegistry({ features: { [key]: { ...existing, ...patch } } }).features[key];
      items.push({ file, route });
    } catch (error) {
      errors.push(`${file}: ${(nameExclusion(error, scope) as Error).message}`);
    }
  }
  for (const { file, route, governed } of items) {
    if (governed || !route?.row) continue;
    for (const key of route.row.secondary) {
      const existing = proposed.features[key];
      if (!existing || existing.primary_sources.includes(file) || existing.related_sources.includes(file)) continue;
      try {
        assertContainedPath(root, existing.doc, "secondary doc", true);
        const patch = { related_sources: [...existing.related_sources, file] };
        assertNoExcludedSource(key, existing, patch, scope.spec);
        proposed.features[key] = normalizeRegistry({ features: { [key]: { ...existing, ...patch } } }).features[key];
      } catch (error) {
        errors.push(`${file}: ${(nameExclusion(error, scope) as Error).message}`);
      }
    }
  }
  return { items, errors, scope };
}

function printMaterialized(result: MaterializeResult): void {
  if (printGoverned(result)) return;
  const verb = result.status === "created" ? "created" : result.status === "updated" ? "added to" : "already in";
  console.log(`  ✓ ${result.file} ${verb} ${pc.bold(result.feature!)}${result.secondaryUpdated.length ? pc.dim(` (+secondary ${result.secondaryUpdated.join(", ")})`) : ""}`);
  printSharedPrimaryWarning(result);
}

function printMaterializeFailure(
  file: string,
  error: unknown,
  completed: string[],
  pending: string[],
  phase: "primary" | "secondary",
): void {
  console.log(pc.red(`  ✗ ${file}: ${(error as Error).message}`));
  if (completed.length) console.log(`  Completed ${phase === "primary" ? "primary registration" : "materialization"}: ${completed.join(", ")}`);
  console.log(pc.yellow(`  ${file} failed during ${phase} materialization; registry or scaffold writes may already remain. No rollback was performed.`));
  if (phase === "secondary") console.log("  Primary registration finished for the batch; remaining secondary work is pending.");
  if (pending.length) console.log(`  Unattempted ${phase} materialization: ${pending.join(", ")}`);
  console.log(pc.dim("  Correct the I/O failure and retry the same batch; existing ownership and documents are preserved."));
  process.exitCode = 1;
}

export function mapMaterialize(options: MapCliOptions = {}): void {
  const root = options.root ?? options.dir ?? process.cwd();
  const requested = [...(options.files ?? []), ...(options.file ? [options.file] : [])];
  if (!requested.length) {
    console.log(pc.yellow("codument map materialize: missing <file>"));
    process.exitCode = 1;
    return;
  }
  let rows: FeatureMapRow[] = [];
  if (!options.feature) {
    const resolved = resolveMap(root, options.plan, options.planId);
    if ("error" in resolved) {
      console.log(pc.yellow("codument map materialize: " + resolved.error));
      console.log(pc.dim("  Working past a shipped plan? Name the owner directly: `codument map materialize <file> --feature <slug>`"));
      process.exitCode = 1;
      return;
    }
    if (resolved.map.errors.length) {
      for (const error of resolved.map.errors) console.log(pc.red(`  ✗ line ${error.line}: ${error.message}`));
      process.exitCode = 1;
      return;
    }
    rows = resolved.map.rows;
  }
  let prepared: ReturnType<typeof prepareMaterialization>;
  try {
    assertContainedPath(root, "docs/.registry.json", "registry", true);
    if (options.feature) {
      const registry = readRegistrySync(join(root, "docs", ".registry.json"));
      if (!registry.features[options.feature]) {
        const known = Object.keys(registry.features).sort();
        console.log(pc.yellow(`codument map materialize: no registry entry named "${options.feature}"`));
        console.log(pc.dim(known.length ? `  known features: ${known.join(", ")}` : "  the registry has no entries yet — run `codument scan` or plan the feature first"));
        console.log(pc.dim("  A NEW feature needs a responsibility line to seed its doc, which a plan's Feature Map row carries — plan it rather than naming it here."));
        process.exitCode = 1;
        return;
      }
    }
    const files = [...new Set(requested.map(file => file.trim() ? toRepoRel(root, file) : ""))];
    prepared = prepareMaterialization(root, files, rows, options.feature);
  } catch (error) {
    console.log(pc.red(`  ✗ ${(error as Error).message}`));
    process.exitCode = 1;
    return;
  }
  if (prepared.errors.length) {
    for (const error of prepared.errors) console.log(pc.red(`  ✗ ${error}`));
    console.log(pc.dim("  Batch validation failed; no files were materialized."));
    process.exitCode = 1;
    return;
  }

  const results: MaterializeResult[] = [];
  for (const [index, item] of prepared.items.entries()) {
    try {
      results.push(item.governed ?? (options.feature
        ? materializeDirectFile(root, item.file, options.feature, prepared.scope)
        : materializeRoutedFile(root, item.route!, item.file, false, prepared.scope)));
    } catch (error) {
      printMaterializeFailure(item.file, error, results.map(result => result.file), prepared.items.slice(index + 1).map(next => next.file), "primary");
      return;
    }
  }
  for (const [index, item] of prepared.items.entries()) {
    try {
      if (results[index].status !== "governed" && item.route?.row) results[index].secondaryUpdated = materializeSecondaries(root, item.route.row, item.file, prepared.scope);
    } catch (error) {
      printMaterializeFailure(item.file, error, results.slice(0, index).map(result => result.file), prepared.items.slice(index + 1).map(next => next.file), "secondary");
      return;
    }
  }
  for (const result of results) printMaterialized(result);
}

/**
 * The tree refusal, and the moment the user learns their registration is working.
 * It is not a dead end: the file IS governed, so the only thing left to decide is
 * whether it deserves an owner of its own — which is a registry edit someone makes
 * deliberately, and the one case where an explicit path beside a covering pattern
 * is a refinement rather than a restatement. Returns true when it handled the result.
 */
function printGoverned(result: MaterializeResult): boolean {
  if (result.status !== "governed" || !result.governedBy) return false;
  const { feature, pattern } = result.governedBy;
  console.log(`  ✓ ${result.file} is already governed by ${pc.bold(feature)} ${pc.dim(`(${pattern})`)}`);
  console.log(
    pc.dim("    A tree registration is what makes the per-file line unnecessary — nothing to add."),
  );
  console.log(
    pc.dim(
      `    If this file should have an owner of its own instead, add it to that entry by hand; the tree keeps the rest.`,
    ),
  );
  return true;
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
