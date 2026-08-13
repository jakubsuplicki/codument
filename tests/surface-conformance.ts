import { execFileSync } from "node:child_process";
import {
  CONDITION_IDS,
  renderRoute,
  routesFor,
  whyNoAck,
  type ConditionContext,
  type ConditionId,
} from "../src/lib/remedies.js";

// The surface conformance battery: the ONE testable meaning of "the guidance is
// honest", regardless of which surface printed it.
//
// Its sibling `adapter-conformance.ts` pins what "precise" means for a language.
// This pins what a *route* means for a reader. Six consecutive releases fixed the
// same defect in a different surface — a route printed over a finding it cannot
// clear, a route withheld where it would have worked, an anchor rendered as a
// command no shell accepts — because each route's promise lived only in whichever
// test its author happened to write. A promise asserted per case is a promise with
// gaps, and the gaps are where the field reports keep landing.
//
// THE INVERSION. Written as scenarios, this battery could only ever judge the
// routes some surface remembered to print, and every one of the seventh release's
// field failures was a route no surface printed at all — a condition the tool can
// put a reader in with nothing to do about it, which no amount of asserting the
// printed ones can find. So the catalog drives: `CONDITION_IDS` is walked, each
// member must be claimed by a scenario that genuinely fires it, and the catalog's
// own words for that condition must reach the reader's screen. A condition added
// to the catalog and routed nowhere is now a red suite, not a field report.
//
// Like the adapter battery, the checks are pure functions returning violations
// rather than describe/it blocks, precisely so a runner can assert green on the
// real CLI AND red on a deliberately lying surface.

/** Strip SGR sequences. A child process gets no TTY so picocolors should already
 *  be off; stripping anyway keeps a coloured runner from silently matching nothing. */
export function plain(s: string): string {
  return s.replace(/\[[0-9;]*m/g, "");
}

/**
 * A ROUTE is a concrete `codument …` command the surface printed — one a reader
 * can paste. A line carrying a `<placeholder>` is a POINTER: prose telling you
 * which edit to make, with no claim that it runs. The distinction is the whole
 * reason this battery can execute anything: pointers are exempt from "it must
 * run and clear", routes never are.
 */
export function routesIn(output: string): string[] {
  const found: string[] = [];
  for (const raw of plain(output).split("\n")) {
    // Commands appear bare after `→` and inside backticks; both forms are things
    // a reader copies, so both are collected. A subcommand is a bare word — which
    // is what tells `codument ack …` from the verdict line's `codument review:`.
    for (const m of raw.matchAll(/`?(codument\s+[a-z][a-z-]*\s[^`\n]+?)`?(?:\s{2,}|$)/g)) {
      // A trailing parenthetical is prose about the command, not part of it. An
      // anchor's own parens carry no space before them (`area().`), so a SPACE
      // followed by `(` is where the command ends and the aside begins.
      const cmd = m[1]
        .split(/\s\(/)[0]
        .trim()
        .replace(/[.,;]$/, "");
      if (/<[^>]+>/.test(cmd)) continue; // a pointer, not a route
      found.push(cmd);
    }
  }
  return [...new Set(found)];
}

/**
 * The same commands in their PLACEHOLDER form — `codument ack <path>` and friends.
 * A pointer cannot be executed, so it is exempt from "it must run and clear"; it is
 * NOT exempt from "it must not be offered where nothing it names can work". The
 * epilogue offers its routes this way, which is how a dead ack route survived there
 * after being withdrawn from the finding three lines above.
 */
export function pointersIn(output: string): string[] {
  const found: string[] = [];
  for (const raw of plain(output).split("\n")) {
    for (const m of raw.matchAll(/`(codument\s+[a-z][a-z-]*\s[^`\n]+)`/g)) {
      if (/<[^>]+>/.test(m[1])) found.push(m[1].trim());
    }
  }
  return [...new Set(found)];
}

/**
 * The region a route is judged in: the finding's own section, plus the `--strict`
 * epilogue.
 *
 * Scope is the whole question. Judged over the entire output, an ack that correctly
 * resolves a DIFFERENT finding standing beside this one reads as a dead route —
 * which would push a surface into withdrawing a command that works. Judged only
 * inside the section, the epilogue goes unchecked, and the epilogue is exactly where
 * a withdrawn route survived in placeholder form. So: both, and nothing else.
 *
 * Sections are two-space-indented headings; their entries are indented further, so a
 * section runs until the next line that is neither blank nor deeper than its heading.
 */
export function judgedRegion(output: string, heading: RegExp): string {
  const lines = plain(output).split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  const section: string[] = [];
  if (start >= 0) {
    const depth = lines[start].length - lines[start].trimStart().length;
    section.push(lines[start]);
    for (const line of lines.slice(start + 1)) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() !== "" && indent <= depth) break;
      section.push(line);
    }
  }
  // The epilogue: everything from the strict verdict's own line onward. It claims to
  // list only routes that can clear what actually fired, so it is judged for every
  // scenario whether or not the section above was found.
  const verdict = lines.findIndex((l) => /✗ --strict:/.test(l));
  const epilogue = verdict >= 0 ? lines.slice(verdict) : [];
  return [...section, ...epilogue].join("\n");
}

/** Characters a POSIX shell acts on. A printed command carrying one of these
 *  unquoted is a command the reader must repair before it runs — plan 42's
 *  defect, where every per-symbol ack command ever printed was a syntax error. */
const SHELL_META = /[()<>|&;$*?[\]{}!~#]/;

/** Split a printed command the way a shell would, honouring double quotes. Returns
 *  null when the quoting is unbalanced (itself a violation). */
export function tokenize(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  for (const ch of cmd) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (started || cur !== "") out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quoted) return null;
  if (started || cur !== "") out.push(cur);
  return out;
}

/** Unquoted tokens carrying shell metacharacters — the repair a reader would
 *  otherwise have to make. `--reason "..."` is quoted, so it never lands here. */
export function unsafeTokens(cmd: string): string[] {
  const bad: string[] = [];
  let quoted = false;
  let cur = "";
  let curQuoted = false;
  const flush = () => {
    if (cur !== "" && !curQuoted && SHELL_META.test(cur)) bad.push(cur);
    cur = "";
    curQuoted = false;
  };
  for (const ch of cmd) {
    if (ch === '"') {
      quoted = !quoted;
      curQuoted = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return bad;
}

/**
 * A scenario's claim that it puts a reader in one catalog condition, and how the
 * catalog's words for that condition reach them.
 *
 * `"routes"` — the labelled routes print, so the exact rendered text is looked
 * for in the output. `"reason"` — the condition is one no acknowledgment reaches
 * and what prints is the sentence saying why (a refusal, or a summary clause).
 *
 * The expected text is DERIVED from the catalog, never written here: a claim that
 * restated the route in its own words would be a third copy of the sentence whose
 * second copy this whole module exists to delete.
 */
export interface ConditionClaim {
  id: ConditionId;
  as: "routes" | "reason";
  /** What the surface would render this instance with — the fixture's own paths.
   *  Wrong values fail the claim, which is the point: a claim is only evidence if
   *  it is checked against the concrete text the reader saw. */
  ctx?: ConditionContext;
}

export interface SurfaceScenario {
  name: string;
  /** Files written before the baseline commit. */
  base: Record<string, string>;
  /** Files written (or deleted, via null) after it — the change under review. */
  change: Record<string, string | null>;
  /** The argv after `cli.js` for the surface being asked. */
  invoke: string[];
  /** The finding this scenario is about. Rule 0 fails if it does not appear. */
  finding: RegExp;
  /**
   * `"routes-clear"` — every route printed must run and clear `finding`.
   * `"no-ack-route"` — the same, AND no `codument ack` route may be offered at
   * all, because no acknowledgment of any grain can reach this finding.
   * `"refusal"` — the surface is a command that REFUSED, so there is nothing to
   * clear and the routes it names are the ones it is redirecting to; only the
   * pasteability rule applies. Without this, a refusal could only be modelled as
   * one of the two above, and both would ask it the wrong question.
   */
  expect: "routes-clear" | "no-ack-route" | "refusal";
  /** The catalog conditions this scenario puts a reader in. Every member of
   *  `CONDITION_IDS` must be claimed by some scenario (rule 6) and every claim
   *  must be visible in the output (rule 7). */
  conditions?: ConditionClaim[];
  /** Conditions that change what the reader does next and must therefore survive a
   *  pipe. Readers grep `| tail -1`, so anything reachable only above the verdict is
   *  in practice unreachable — which cost an adversarial field report two false
   *  entries about behaviour the tool has and prints. */
  verdictNames?: RegExp[];
  /** A known gap a later step closes: the ONE rule exempted, and the step that
   *  ends the exemption. Naming the rule keeps the exemption from covering every
   *  other question asked of this scenario. A pending rule that starts PASSING is
   *  itself a violation, so the list cannot quietly rot. */
  pending?: { rule: string; step: string };
}

export interface SurfaceHarness {
  /** Build the scenario's repo and return its root. */
  arrange: (s: SurfaceScenario) => Promise<string>;
  /** Run the CLI in `root`; return combined output. The seam the mutant rides. */
  run: (root: string, argv: string[]) => string;
  scenarios: SurfaceScenario[];
}

export interface SurfaceViolation {
  scenario: string;
  rule: string;
  detail: string;
}

/** Every label the catalog can print, so a route line is told from an ordinary
 *  line that happens to carry an arrow (`file → doc`, and the like). */
const CATALOG_LABELS = new Set(
  CONDITION_IDS.flatMap((id) => routesFor(id, { claimants: 2 }).map((r) => r.label)),
);

/**
 * The label columns in one render, as (indent, arrow column) groups.
 *
 * A route line is `<indent><label padded> → <route>`. Contiguous ones at the same
 * indent are one block and their arrows must line up; a hardcoded pad width is
 * right until a label is renamed past it, and the block then misaligns silently —
 * no assertion about WHICH route printed can see that.
 */
export function labelColumns(output: string): { indent: number; arrow: number; label: string }[][] {
  const groups: { indent: number; arrow: number; label: string }[][] = [];
  let current: { indent: number; arrow: number; label: string }[] = [];
  for (const line of plain(output).split("\n")) {
    const m = /^(\s*)(\S[^→]*?)\s*(→)/.exec(line);
    const row =
      m && CATALOG_LABELS.has(m[2])
        ? { indent: m[1].length, arrow: line.indexOf("→"), label: m[2] }
        : null;
    if (row && (current.length === 0 || current[0].indent === row.indent)) {
      current.push(row);
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = row ? [row] : [];
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** The real runner: the built CLI, in a real repo, exactly as a reader invokes it. */
export function cliRunner(cli: string) {
  return (root: string, argv: string[]): string => {
    try {
      return execFileSync(process.execPath, [cli, ...argv], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", NO_COLOR: "1" },
      });
    } catch (err) {
      // A nonzero exit is the normal case here — a red gate is what these
      // scenarios arrange. The output is the subject either way.
      const e = err as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
  };
}

/**
 * The catalog members no scenario claims — the inversion's whole point, computed
 * over the scenario SET rather than per scenario, because "nobody covers this" is
 * not a fact any single scenario can hold.
 *
 * Takes the id list as an argument rather than reading the catalog directly so a
 * test can seed a condition that exists and is routed nowhere, and watch this
 * fail. A guard nothing can be shown to trip is a guard nobody should trust.
 */
export function uncoveredConditions(
  scenarios: SurfaceScenario[],
  ids: readonly ConditionId[] = CONDITION_IDS,
): ConditionId[] {
  const claimed = new Set(scenarios.flatMap((s) => (s.conditions ?? []).map((c) => c.id)));
  return ids.filter((id) => !claimed.has(id));
}

export async function checkSurfaceConformance(h: SurfaceHarness): Promise<SurfaceViolation[]> {
  const violations: SurfaceViolation[] = [];

  // Rule 6 — every condition the catalog names is claimed by a scenario. Reported
  // against the battery itself, since the gap belongs to no one scenario.
  for (const id of uncoveredConditions(h.scenarios)) {
    violations.push({
      scenario: "(the catalog)",
      rule: "6-condition-covered",
      detail: `${id} is in the catalog and no scenario puts a reader in it`,
    });
  }

  for (const s of h.scenarios) {
    const flag = (rule: string, detail: string) =>
      violations.push({ scenario: s.name, rule, detail });
    const before = violations.length;

    const root = await h.arrange(s);
    const output = plain(h.run(root, s.invoke));

    // Rule 0 — the scenario must actually produce its finding. A scenario that
    // fires nothing passes every rule below vacuously, which is the failure mode
    // a battery exists to make impossible.
    if (!s.finding.test(output)) {
      flag("0-scenario-fires", `finding ${s.finding} not present in output`);
      continue;
    }

    // Routes are judged where the reader meets them: under the finding this
    // scenario is about, and in the epilogue that claims to list only what clears
    // it. Everything else in the output belongs to some other finding and answers
    // to its own row.
    const judged = judgedRegion(output, s.finding);
    const routes = routesIn(judged);

    // Rule 7 — the catalog's words for a claimed condition reached the reader.
    // Judged over the WHOLE output, not the finding's section: a refusal is the
    // whole message, and the summary clauses live below the verdict by design.
    // This is the half that inverts the battery — rules 1-3 ask whether what was
    // printed is honest, and only this one asks whether it was printed at all.
    for (const claim of s.conditions ?? []) {
      if (claim.as === "reason") {
        const reason = whyNoAck(claim.id, claim.ctx ?? {});
        if (reason === null) {
          flag("7-catalog-reaches-reader", `${claim.id} claims a reason and the catalog gives none`);
          continue;
        }
        // Minus its first character: a surface that starts a sentence with it
        // capitalizes, and that is a presentation choice, not a second claim.
        if (!output.includes(reason.slice(1))) {
          flag("7-catalog-reaches-reader", `${claim.id}'s reason never printed: "${reason}"`);
        }
        continue;
      }
      // EVERY route the catalog names for this instance, not a subset: a claim
      // that could excuse the routes it did not want checked would be a claim
      // that proves whatever it was written to prove.
      for (const r of routesFor(claim.id, claim.ctx ?? {})) {
        const text = renderRoute(r);
        if (!output.includes(text)) {
          flag("7-catalog-reaches-reader", `${claim.id}'s "${r.label}" route never printed: ${text}`);
        }
      }
    }

    // Rule 1 — a printed command is one a reader can paste. Unbalanced quoting or
    // an unquoted shell metacharacter means the reader repairs it first, which is
    // the same defect as printing a route that cannot clear, one layer out.
    for (const cmd of routes) {
      if (tokenize(cmd) === null) flag("1-pasteable", `unbalanced quoting: ${cmd}`);
      const unsafe = unsafeTokens(cmd);
      if (unsafe.length > 0) flag("1-pasteable", `unquoted shell metacharacters in: ${cmd}`);
    }

    // Rule 2 — no route is offered that cannot clear the finding it sits under.
    // A plausible command leaving the gate exactly as red costs more than silence.
    if (s.expect === "no-ack-route") {
      // Routes AND pointers. Withdrawing the command from the finding while the
      // epilogue goes on naming the same dead route in placeholder form is the
      // defect moved, not fixed — the reader reaches the refusal either way.
      for (const cmd of [...routes, ...pointersIn(judged)]) {
        if (/^codument\s+ack\b/.test(cmd)) {
          flag("2-no-dead-route", `an ack was offered where none can clear: ${cmd}`);
        }
      }
    }

    // Rule 3 — every route offered, run verbatim, clears what it sat under. The
    // reason placeholder is the one substitution a reader makes; everything else
    // runs exactly as printed.
    if (s.expect === "routes-clear") {
      if (routes.length === 0) {
        flag("3-routes-clear", "no runnable route offered for a finding that has one");
      }
      for (const cmd of routes) {
        const argv = tokenize(cmd.replace(/"\.\.\."/, '"conformance battery"'));
        if (argv === null) continue; // already flagged by rule 1
        // A FRESH repo per route. Reusing one would let the first route clear the
        // finding and every later route pass over an already-clean tree — a route
        // green because nothing was left to fail, which is the vacuous pass this
        // battery exists to make impossible.
        const fresh = await h.arrange(s);
        h.run(fresh, argv.slice(1));
        const after = plain(h.run(fresh, s.invoke));
        if (s.finding.test(after)) {
          flag("3-routes-clear", `route left the finding standing: ${cmd}`);
        }
      }
    }

    // Rule 8 — a block's label column fits every label in it.
    for (const group of labelColumns(output)) {
      const arrows = new Set(group.map((r) => r.arrow));
      if (arrows.size > 1) {
        flag(
          "8-label-column-aligned",
          `labels ${group.map((r) => `"${r.label}"`).join(", ")} put their arrows at ${[...arrows].join(", ")}`,
        );
      }
    }

    // Rule 5 — the verdict line stands alone. Whatever else the render says, the
    // last line carries every condition that changes the reader's next action,
    // because the last line is the only part a piped read reliably keeps.
    for (const re of s.verdictNames ?? []) {
      const last = plain(output).trimEnd().split("\n").pop() ?? "";
      if (!re.test(last)) {
        flag("5-verdict-stands-alone", `the verdict line does not name ${re}: ${last}`);
      }
    }

    // Rule 4 — the pending list cannot rot. A row named as pending that passes is
    // a row someone forgot to remove, and a stale exemption is how a battery
    // quietly stops being the contract it claims to be.
    if (s.pending && !violations.slice(before).some((v) => v.rule === s.pending?.rule)) {
      flag(
        "4-pending-is-honest",
        `declared ${s.pending.rule} pending (${s.pending.step}) but it passes — remove the marker`,
      );
    }
  }

  return violations;
}

/** Violations minus the ONE rule a scenario declared pending. Narrow on purpose: a
 *  known gap must not buy silence on every other question asked of the same
 *  scenario, which is how an exemption grows into a hole. What the suite asserts
 *  empty; the pending set shrinks to nothing as the release lands. */
export function blocking(
  violations: SurfaceViolation[],
  scenarios: SurfaceScenario[],
): SurfaceViolation[] {
  const exempt = new Map(
    scenarios.filter((s) => s.pending).map((s) => [s.name, s.pending?.rule] as const),
  );
  return violations.filter((v) => exempt.get(v.scenario) !== v.rule);
}
