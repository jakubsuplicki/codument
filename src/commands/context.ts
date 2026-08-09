import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { readRegistrySync } from "../lib/registry.js";
import { parseFeatureMap } from "../lib/feature-map.js";
import { normalizeRelPath } from "../lib/registry.js";
import {
  applyBudget,
  gatherContextPack,
  ownersOfFile,
  ownershipOfFile,
  selectedFromPlanRows,
  type ContextEntry,
  type ContextPack,
  type ContextResolution,
  type FileOwner,
} from "../lib/context-pack.js";

// `codument context` — the pull-based context oracle. Given a feature, a file,
// or a plan, it projects the minimal grounded working set from the registry and
// the committed docs (orientation + invariants with test pointers, primary
// sources, one-hop deps) so an agent can pull its relevant slice on any turn.
// Informational and pure (registry + docs, no git, no model): it always "runs",
// so the only nonzero exit is a bad invocation (no selector, or two at once) or
// an unreadable registry (fails loud at the CLI boundary). A `--budget` trims
// tail-first and says what it dropped — never a silent cap.

interface ContextCliOptions {
  feature?: string;
  file?: string;
  plan?: string;
  budget?: string;
  owner?: boolean;
  json?: boolean;
  root?: string;
  dir?: string;
}

interface ContextJson {
  version: 1;
  selector: ContextPack["selector"];
  entries: ContextEntry[];
  unknownFeatures: string[];
  unmappedFile: string | null;
  planErrors: string[];
  estimatedTokens: number;
  budget: number | null;
  trimmed: string[];
  overBudget: boolean;
}

/** The `--owner` contract: the file as resolved, and every feature that owns it
 *  (empty when none does — a fact, not an error, so the exit code stays 0). */
interface OwnerJson {
  version: 1;
  file: string;
  owners: FileOwner[];
}

function fail(message: string): void {
  console.log(pc.red(`  ✗ ${message}`));
  process.exitCode = 1;
}

// Resolve the one selector to the features it names, plus any flag it raises
// (unknown slug, unmapped file). Returns null after rendering its own error.
function resolve(
  root: string,
  registry: ReturnType<typeof readRegistrySync>,
  options: ContextCliOptions,
): ContextResolution | null {
  const chosen = [options.feature, options.file, options.plan].filter((v) => v !== undefined);
  if (chosen.length === 0) {
    fail("choose one selector: --feature <slug> | --file <path> | --plan <path>");
    return null;
  }
  if (chosen.length > 1) {
    fail("--feature, --file and --plan are mutually exclusive — choose one");
    return null;
  }

  if (options.feature !== undefined) {
    const known = registry.features[options.feature] !== undefined;
    return {
      kind: "feature",
      input: options.feature,
      selected: known ? [options.feature] : [],
      unknownFeatures: known ? [] : [options.feature],
      unmappedFile: null,
      planErrors: [],
    };
  }

  if (options.file !== undefined) {
    const owners = ownersOfFile(registry, options.file);
    return {
      kind: "file",
      input: options.file,
      selected: owners,
      unknownFeatures: [],
      unmappedFile: owners.length === 0 ? options.file : null,
      planErrors: [],
    };
  }

  // --plan
  const planPath = join(root, options.plan!);
  if (!existsSync(planPath)) {
    fail(`plan not found: ${options.plan}`);
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(planPath, "utf8");
  } catch (err) {
    // existsSync passed but the read failed: a directory (EISDIR), a permission
    // block (EACCES), etc. Fail gracefully at this boundary rather than throwing
    // an uncaught stack trace — the same courtesy the missing-plan path gets.
    fail(`could not read plan ${options.plan}: ${(err as Error).message}`);
    return null;
  }
  const map = parseFeatureMap(raw);
  if (map.rows.length === 0) {
    fail(`no Feature Map rows in ${options.plan} — nothing to route`);
    return null;
  }
  const selected = selectedFromPlanRows(map.rows);
  return {
    kind: "plan",
    input: options.plan!,
    selected: selected.filter((s) => registry.features[s]),
    unknownFeatures: selected.filter((s) => !registry.features[s]),
    unmappedFile: null,
    // Malformed rows the parser rejected: surfaced, never silently dropped — a
    // typo'd row that routes nothing must be a visible flag, exactly like an
    // unknown slug. (A map with SOME valid rows still packs; these warn.)
    planErrors: map.errors.map((e) => `line ${e.line}: ${e.message}`),
  };
}

// The lean ownership answer. Before editing a file an agent needs one fact —
// which doc owns it — and charging a whole context pack for it is why the cheap
// habit is to skip the lookup and guess. One line, every case, so it is worth
// running every time.
function renderOwner(file: string, owners: FileOwner[]): string {
  if (owners.length === 0) {
    return pc.yellow(`  no feature owns ${file} — map it into a feature's primary_sources`);
  }
  const parts = owners.map(
    (o) => `${pc.bold(o.feature)} — ${o.doc}${o.via === file ? "" : pc.dim(` (via ${o.via})`)}`,
  );
  // Several owners is the shared-file case, and every candidate is named: which
  // one owns the symbol you are about to move is a decision, not something this
  // lookup may quietly pick for you.
  return `  ${file}: ${parts.join(pc.dim("  |  "))}`;
}

function renderEntry(entry: ContextEntry): string[] {
  const out: string[] = [];
  if (entry.relation === "dependency") {
    out.push(`  ${pc.dim("↳ depends on")} ${pc.bold(entry.feature)} — ${entry.doc}`);
    if (entry.summary) out.push(`      ${pc.dim(entry.summary)}`);
    return out;
  }
  out.push(`  ${pc.bold(entry.feature)} — ${entry.doc}  ${pc.dim(`~${entry.estimatedTokens} tok`)}`);
  if (entry.summary) {
    out.push(`    ${pc.dim("In plain terms")}`);
    for (const line of entry.summary.split("\n")) out.push(`      ${line}`);
  }
  if (entry.invariants) {
    out.push(`    ${pc.dim("Invariants & boundaries")}`);
    for (const line of entry.invariants.split("\n")) out.push(`      ${line}`);
  }
  if (entry.testPointers.length > 0) {
    out.push(`    ${pc.dim("tests")}: ${entry.testPointers.join(", ")}`);
  }
  if (entry.primarySources.length > 0) {
    out.push(`    ${pc.dim("primary sources")}: ${entry.primarySources.join(", ")}`);
  }
  if (entry.relatedSources.length > 0) {
    out.push(`    ${pc.dim("related sources")}: ${entry.relatedSources.join(", ")}`);
  }
  if (entry.risk.length > 0) {
    out.push(`    ${pc.dim("risk")}: ${entry.risk.join(", ")}`);
  }
  return out;
}

export function contextCommand(options: ContextCliOptions = {}): void {
  const root = options.root ?? options.dir ?? process.cwd();
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));

  // A flag's own value is validated before the command is interpreted, so no
  // route can quietly accept a malformed `--budget` by not reaching the check.
  let budget: number | null = null;
  if (options.budget !== undefined) {
    const n = Number(options.budget);
    // Require ≥ 1: a sub-1 value would floor to 0, which is the exact effective
    // budget `--budget 0` is rejected for — so reject it here too rather than
    // silently reinterpreting "0.9" as 0.
    if (!Number.isFinite(n) || n < 1) {
      fail(`--budget must be a whole number of tokens ≥ 1, got "${options.budget}"`);
      return;
    }
    budget = Math.floor(n);
  }

  // `--owner` short-circuits the pack: it is the same ownership resolution the
  // `--file` selector runs, rendered as the answer instead of as the doorway to
  // thousands of tokens of orientation nobody asked for. A budget has nothing to
  // act on here — the answer IS the head, and the head is never trimmed.
  if (options.owner) {
    if (options.file === undefined || options.feature !== undefined || options.plan !== undefined) {
      fail("--owner answers a file's ownership — use it with --file <path> alone");
      return;
    }
    const file = normalizeRelPath(options.file);
    const owners = ownershipOfFile(registry, file);
    if (options.json) {
      const payload: OwnerJson = { version: 1, file, owners };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(renderOwner(file, owners));
    return;
  }

  const resolution = resolve(root, registry, options);
  if (resolution === null) return;

  let pack = gatherContextPack(root, registry, resolution);
  let trimmed: string[] = [];
  let overBudget = false;
  if (budget !== null) {
    const result = applyBudget(pack, budget);
    pack = result.pack;
    trimmed = result.trimmed;
    overBudget = result.overBudget;
  }

  if (options.json) {
    const payload: ContextJson = {
      version: 1,
      selector: pack.selector,
      entries: pack.entries,
      unknownFeatures: pack.unknownFeatures,
      unmappedFile: pack.unmappedFile,
      planErrors: pack.planErrors,
      estimatedTokens: pack.estimatedTokens,
      budget,
      trimmed,
      overBudget,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(pc.bold("codument context") + pc.dim(`  ${pack.selector.kind}: ${pack.selector.value || "—"}`));
  console.log();

  if (pack.unmappedFile) {
    console.log(pc.yellow(`  ⚠ no feature owns ${pack.unmappedFile} — nothing to pack.`));
    console.log(pc.dim("    Map it into a feature's primary_sources (or run `codument scan`)."));
    return;
  }
  if (pack.entries.length === 0) {
    console.log(pc.yellow("  No matching registry entries."));
    if (pack.unknownFeatures.length > 0) {
      console.log(pc.dim(`    unknown: ${pack.unknownFeatures.join(", ")}`));
    }
    return;
  }

  for (const entry of pack.entries) {
    for (const line of renderEntry(entry)) console.log(line);
    console.log();
  }

  console.log(
    pc.dim(
      `  ~${pack.estimatedTokens} estimated tokens across ${pack.entries.length} entr${pack.entries.length === 1 ? "y" : "ies"}` +
        (budget !== null ? ` (budget ${budget})` : ""),
    ),
  );
  if (trimmed.length > 0) {
    console.log(pc.yellow(`  trimmed to fit the budget: ${trimmed.join(", ")}`));
  }
  if (overBudget) {
    console.log(
      pc.yellow("  still over budget: the selected orientation + invariants alone exceed it (never trimmed — it is what you asked for)."),
    );
  }
  if (pack.unknownFeatures.length > 0) {
    console.log(pc.yellow(`  ⚠ unknown feature(s) named but not in the registry: ${pack.unknownFeatures.join(", ")}`));
  }
  if (pack.planErrors.length > 0) {
    console.log(pc.yellow(`  ⚠ ${pack.planErrors.length} malformed Feature-Map row(s) skipped — this pack may be incomplete:`));
    for (const e of pack.planErrors) console.log(`      ${e}`);
  }
}
