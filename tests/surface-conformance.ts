import { execFileSync } from "node:child_process";

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
   */
  expect: "routes-clear" | "no-ack-route";
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

export async function checkSurfaceConformance(h: SurfaceHarness): Promise<SurfaceViolation[]> {
  const violations: SurfaceViolation[] = [];

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

    const routes = routesIn(output);

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
      for (const cmd of routes) {
        if (/^codument\s+ack\b/.test(cmd)) {
          flag("2-no-dead-route", `an ack route was offered where none can clear: ${cmd}`);
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
