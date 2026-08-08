import type { ReviewReport } from "../commands/review.js";

// A pure ReviewReport -> SARIF 2.1.0 mapper: a lossless re-projection of what the
// gate already reports into the one shape CI already knows how to render inline on a
// PR (GitHub code-scanning upload / reviewdog). No I/O, no new findings, no wall
// clock — the output is a deterministic function of the ReviewReport alone, so the
// same repo state yields byte-identical SARIF. Only the fields codument populates are
// typed here; the output validates against the full 2.1.0 schema (see sarif.test.ts).

const SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const INFORMATION_URI = "https://github.com/jakubsuplicki/codument";
const DOCS = "https://github.com/jakubsuplicki/codument/blob/main/docs/features";

type Level = "warning" | "error" | "note";

export interface SarifLog {
  version: "2.1.0";
  $schema: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
  invocations?: SarifInvocation[];
}

interface SarifDriver {
  name: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  helpUri: string;
  defaultConfiguration: { level: Level };
}

interface SarifResult {
  ruleId: string;
  level: Level;
  message: { text: string };
  locations: SarifLocation[];
  relatedLocations?: SarifLocation[];
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region: { startLine: number };
  };
}

interface SarifInvocation {
  executionSuccessful: boolean;
  toolExecutionNotifications: SarifNotification[];
}

interface SarifNotification {
  level: Level;
  message: { text: string };
}

// The stable rule catalog (fixed ids and order). Emitted whole on every run — the
// tool's advertised rules, independent of which fired — so a consumer sees the full
// vocabulary and the driver block never varies by result set.
const RULES: SarifRule[] = [
  {
    id: "codument/stale-doc",
    name: "StaleDoc",
    shortDescription: { text: "A feature's source changed but its owning doc did not." },
    helpUri: `${DOCS}/change-control-gate.md`,
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "codument/unmapped-source",
    name: "UnmappedSource",
    shortDescription: { text: "A changed source file has no owning doc in the registry." },
    helpUri: `${DOCS}/registry-health.md`,
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "codument/out-of-plan",
    name: "OutOfPlan",
    shortDescription: { text: "A changed file falls outside the approved plan's scope." },
    helpUri: `${DOCS}/change-control-gate.md`,
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "codument/ownership-lint",
    name: "OwnershipLint",
    shortDescription: {
      text: "A symbol on a shared file could not be resolved to a single owning feature.",
    },
    helpUri: `${DOCS}/change-control-gate.md`,
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "codument/registry-pointer",
    name: "RegistryPointer",
    shortDescription: {
      text: "A registry entry still names a source path this change renamed or deleted.",
    },
    helpUri: `${DOCS}/registry-health.md`,
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "codument/unevaluable",
    name: "Unevaluable",
    shortDescription: {
      text: "A changed source file could not be parsed (parse error or conflict markers).",
    },
    helpUri: `${DOCS}/change-control-gate.md`,
    defaultConfiguration: { level: "warning" },
  },
];

// File-grain anchoring: the ReviewReport carries no per-symbol source spans, so every
// result anchors at line 1 of its file — a faithful projection of what review reports,
// never a fabricated line number. The startLine keeps GitHub rendering an annotation.
function loc(uri: string): SarifLocation {
  return { physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } };
}

// Codepoint order, NOT localeCompare — locale-dependent collation would make the
// output vary by machine, breaking the byte-identical contract.
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareResults(a: SarifResult, b: SarifResult): number {
  const byRule = cmp(a.ruleId, b.ruleId);
  if (byRule !== 0) return byRule;
  const au = a.locations[0]?.physicalLocation.artifactLocation.uri ?? "";
  const bu = b.locations[0]?.physicalLocation.artifactLocation.uri ?? "";
  const byUri = cmp(au, bu);
  if (byUri !== 0) return byUri;
  return cmp(a.message.text, b.message.text);
}

function log(results: SarifResult[], invocations?: SarifInvocation[]): SarifLog {
  const run: SarifRun = {
    tool: { driver: { name: "codument", informationUri: INFORMATION_URI, rules: RULES } },
    results,
  };
  if (invocations) run.invocations = invocations;
  return { version: "2.1.0", $schema: SCHEMA, runs: [run] };
}

/** Map a gate verdict (`gate: "ok"` ReviewReport) to SARIF. Results are sorted, so
 *  identical repo state produces byte-identical output. `notifications` (blocking
 *  reasons the results cannot express — e.g. the adversarial-review gate refusing a
 *  diff) attach as an UNSUCCESSFUL invocation, so a red check never uploads a SARIF
 *  that reads as a clean pass. */
export function reviewReportToSarif(report: ReviewReport, notifications: string[] = []): SarifLog {
  const state = report.state;
  const results: SarifResult[] = [];

  for (const sd of state.staleDocs) {
    // Enrich with the per-symbol moves behind the staleness: which symbols moved and
    // their fingerprint transition, so the annotation says WHY the doc went stale.
    const moved = report.drift.filter(
      (d) => d.feature === sd.feature && d.from !== undefined && d.to !== undefined,
    );
    const movedText = moved.length
      ? ` Moved: ${moved.map((d) => `${d.symbol} (${d.from}→${d.to})`).join(", ")}.`
      : "";
    const result: SarifResult = {
      ruleId: "codument/stale-doc",
      level: "warning",
      message: { text: `Feature "${sd.feature}" changed but its doc ${sd.doc} did not.${movedText}` },
      locations: [loc(sd.doc)],
    };
    const related = sd.changedSources.map((s) => loc(s));
    if (related.length > 0) result.relatedLocations = related;
    results.push(result);
  }

  for (const file of state.unmapped) {
    results.push({
      ruleId: "codument/unmapped-source",
      level: "warning",
      message: {
        text: `No doc owns ${file}. Add it to docs/.registry.json (or run codument map materialize).`,
      },
      locations: [loc(file)],
    });
  }

  for (const file of state.outOfPlan) {
    results.push({
      ruleId: "codument/out-of-plan",
      level: "warning",
      message: { text: `${file} changed outside the approved plan's scope.` },
      locations: [loc(file)],
    });
  }

  for (const lint of state.ownershipLints) {
    results.push({
      ruleId: "codument/ownership-lint",
      level: "warning",
      message: {
        text: `Symbol "${lint.descriptor}" on ${lint.file} is ${lint.kind} across features: ${lint.features.join(
          ", ",
        )}. Set owned_symbols in the registry to name the owner.`,
      },
      locations: [loc(lint.file)],
    });
  }

  // A registry entry left naming a path this change removed. A `--strict` input like
  // the two above, so it has to project: a run that failed on this alone was
  // uploading a SARIF with no results at all — a report reading as a clean pass
  // beside a check that exited 1, which is the "no findings" ⇒ "clean" misread the
  // whole fail-closed discriminant exists to prevent. Anchored on the entry's DOC,
  // because the vanished path has no file for an annotation to land on.
  for (const p of state.registryPointers) {
    const what =
      p.kind === "renamed"
        ? `was renamed to ${p.renamedTo ?? "another path"}`
        : "was deleted in this change";
    const result: SarifResult = {
      ruleId: "codument/registry-pointer",
      level: "warning",
      message: {
        text: `${p.file} ${what}, but docs/.registry.json still names it under ${p.features.join(
          ", ",
        )}. Re-point the entry, or drop the path — no acknowledgment clears a false pointer.`,
      },
      locations: [loc("docs/.registry.json")],
    };
    // Assigned only when there IS one: an explicit `undefined` survives in the
    // object even though JSON.stringify drops it, and the schema check reads the
    // object, not the serialization.
    if (p.renamedTo) result.relatedLocations = [loc(p.renamedTo)];
    results.push(result);
  }

  // A changed file the gate could not parse (parse error / conflict markers) is a
  // fail-loud signal on the human surface; project it here too so CI never reads a
  // clean SARIF for a change the gate could only evaluate coarsely.
  for (const file of state.unevaluable) {
    results.push({
      ruleId: "codument/unevaluable",
      level: "warning",
      message: {
        text: `${file} could not be parsed (parse error or conflict markers); the gate evaluated it whole, not per-symbol. Fix the file so drift can be checked precisely.`,
      },
      locations: [loc(file)],
    });
  }

  results.sort(compareResults);
  const invocations: SarifInvocation[] | undefined = notifications.length
    ? [
        {
          executionSuccessful: false,
          toolExecutionNotifications: notifications.map((text) => ({
            level: "error" as Level,
            message: { text },
          })),
        },
      ]
    : undefined;
  return log(results, invocations);
}

/** The SARIF for a gate that could not run (the `gate: "unavailable"` discriminant):
 *  no results, and an invocation marked unsuccessful with an error notification — so a
 *  consumer never reads "no findings" as "clean", exactly as the JSON contract refuses
 *  to emit a null verdict. */
export function gateUnavailableSarif(reason: string): SarifLog {
  return log(
    [],
    [
      {
        executionSuccessful: false,
        toolExecutionNotifications: [
          { level: "error", message: { text: `codument gate could not run: ${reason}` } },
        ],
      },
    ],
  );
}
