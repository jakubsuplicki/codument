import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { forgetWorkspace } from "../src/lib/git.js";
import {
  blocking,
  checkSurfaceConformance,
  cliRunner,
  routesIn,
  type SurfaceScenario,
  unsafeTokens,
} from "./surface-conformance.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

const roots: string[] = [];

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

async function put(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    if (content === null) {
      await rm(full, { force: true });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

async function arrange(s: SurfaceScenario): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codument-surface-"));
  roots.push(root);
  await put(root, s.base);
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "baseline"]);
  await put(root, s.change);
  return root;
}

/** One entry, spread across the fixtures by name. */
const entry = (over: Record<string, unknown>) => ({
  doc: "docs/features/x.md",
  type: "feature",
  primary_sources: [],
  related_sources: [],
  docs: [],
  depends_on: [],
  risk: [],
  status: "current",
  ...over,
});

const registry = (features: Record<string, unknown>) => JSON.stringify({ features }, null, 2);

const DOC =
  "---\ntitle: X\nstatus: current\ntype: feature\n---\n\n# X\n\n## In plain terms\n\nA thing.\n";

const SRC = `export function area(w: number, h: number): number {
  return w * h;
}

export function perimeter(w: number, h: number): number {
  return 2 * (w + h);
}
`;

const SCENARIOS: SurfaceScenario[] = [
  {
    // ADR 017: a registered file no adapter can judge is governed at file grain,
    // and BOTH routes print — doc update, or the pasteable file-grain ack. The
    // ack is the one that must actually run, which is what plan 42's coarse-file
    // signpost promised and only a case-by-case test ever checked.
    name: "coarse governed file — the printed file ack clears it",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["config/rules.conf"] }) }),
      "docs/features/x.md": DOC,
      "config/rules.conf": "allow read: if owner;\n",
    },
    change: { "config/rules.conf": "allow read: if owner;\n# a second line\n" },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "routes-clear",
  },
  {
    // A body-only move keeps the cheap ack path (ADR 006). The printed per-symbol
    // command must carry its real anchor AND survive a shell — `area().` bare is a
    // parse error, which is how every such command shipped broken until plan 42.
    name: "body-only symbol move — the printed per-symbol ack runs and clears",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: { "src/shapes.ts": SRC.replace("return w * h;", "return h * w;") },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "routes-clear",
  },
  {
    // A signature move is unackable at every grain, so the ack route must be
    // withheld — while the doc-update route beside it survives on its own. The two
    // shared a sentence once, and dropping the sentence left no route at all.
    name: "signature move — no ack route at any grain",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: {
      "src/shapes.ts": SRC.replace(
        "export function area(w: number, h: number): number {",
        "export function area(w: number, h: number, scale: number): number {",
      ),
    },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "no-ack-route",
  },
  {
    // A registry pointer this change stranded is false, not judged — no ack of any
    // grain reaches it, and offering one sends the reader to a refusal.
    name: "registry pointer stranded by a deletion — no ack applies",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: { "src/shapes.ts": null },
    invoke: ["review", "--strict"],
    finding: /registry|deleted/i,
    expect: "no-ack-route",
    // Found by this battery on its first run, and reproduced by hand: the stale
    // doc a deletion wakes is offered `codument ack <path>`, which `ack` refuses
    // by name ("no acknowledgment clears a deletion") — so the gate is left
    // exactly as red by the command printed to clear it. Plans 36 and 42 closed
    // this for unclaimed symbols and for signature moves; deletions were never
    // covered, because nothing asked all the routes the same question at once.
    pending: { rule: "2-no-dead-route", step: "step 13" },
  },
  {
    // Plan 36's shape, the most-broken route in this tool's history: a symbol two
    // features claim as primary with no `owned_symbols` between them. The wake is
    // ownership, not doc debt, so no ack reaches it — the fix is a registry edit.
    name: "unclaimed shared symbol — the wake is ownership, not doc debt",
    base: {
      "docs/.registry.json": registry({
        x: entry({ primary_sources: ["src/shapes.ts"] }),
        y: entry({ doc: "docs/features/y.md", primary_sources: ["src/shapes.ts"] }),
      }),
      "docs/features/x.md": DOC,
      "docs/features/y.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: { "src/shapes.ts": SRC.replace("return w * h;", "return h * w;") },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "no-ack-route",
  },
];

/** The seeded liar: the real CLI, plus one route it cannot honour. A battery too
 *  weak to reject this is theater — the same bar the adapter battery holds. */
function lyingRunner(cli: string) {
  const real = cliRunner(cli);
  return (root: string, argv: string[]): string => {
    const out = real(root, argv);
    if (argv[0] !== "review") return out;
    return `${out}\n        no doc impact → codument ack definitely/not/a/real/path.conf --reason "..."\n`;
  };
}

after(async () => {
  forgetWorkspace();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("surface conformance battery", () => {
  it("the shipped CLI honours every route it prints", async () => {
    const violations = await checkSurfaceConformance({
      arrange,
      run: cliRunner(CLI),
      scenarios: SCENARIOS,
    });
    assert.deepEqual(
      blocking(violations, SCENARIOS),
      [],
      `surface conformance violations:\n${violations.map((v) => `  [${v.rule}] ${v.scenario}: ${v.detail}`).join("\n")}`,
    );
  });

  it("rejects a seeded surface that prints a route it cannot honour — the battery bites", async () => {
    const violations = await checkSurfaceConformance({
      arrange,
      run: lyingRunner(CLI),
      scenarios: SCENARIOS,
    });
    assert.ok(violations.length > 0, "the lying surface produced no violations");
  });

  it("a later route is judged on a red tree, not on one an earlier route already cleared", async () => {
    // The liar's route rides ALONGSIDE a route that genuinely works. Run against
    // one shared repo, the working route clears the finding first and the liar is
    // then judged over a clean tree — green because nothing was left to fail. Each
    // route gets its own freshly-arranged repo precisely so that cannot happen.
    const violations = await checkSurfaceConformance({
      arrange,
      run: lyingRunner(CLI),
      scenarios: [SCENARIOS[0]],
    });
    assert.ok(
      violations.some((v) => v.rule === "3-routes-clear" && v.detail.includes("definitely/not")),
      `the liar escaped behind a working route: ${JSON.stringify(violations)}`,
    );
  });

  it("a pending marker exempts one rule, never the whole scenario", () => {
    const scenarios = [{ ...SCENARIOS[0], pending: { rule: "2-no-dead-route", step: "step 13" } }];
    const violations = [
      { scenario: SCENARIOS[0].name, rule: "2-no-dead-route", detail: "the known gap" },
      { scenario: SCENARIOS[0].name, rule: "1-pasteable", detail: "an unrelated defect" },
    ];
    assert.deepEqual(
      blocking(violations, scenarios).map((v) => v.rule),
      ["1-pasteable"],
      "a known gap must not buy silence on every other question asked of the same scenario",
    );
  });

  it("a scenario that fires nothing is a violation, never a vacuous pass", async () => {
    // Rule 0 is the anti-vacuity guard, so it needs its own proof that it bites:
    // every rule below it would pass trivially over output with no finding in it.
    const violations = await checkSurfaceConformance({
      arrange,
      run: cliRunner(CLI),
      scenarios: [
        { ...SCENARIOS[0], finding: /this finding can never appear/, pending: undefined },
      ],
    });
    assert.deepEqual(
      violations.map((v) => v.rule),
      ["0-scenario-fires"],
    );
  });

  it("a route is a pasteable command; a placeholder line is a pointer, not a route", () => {
    const out = [
      '        no doc impact → codument ack src/a.ts --reason "..." (file-grain)',
      '        internal only → codument ack src/a.ts::area(). --reason "..."',
      "    Materialize unmapped sources: `codument map materialize <file>`.",
    ].join("\n");
    const routes = routesIn(out);
    assert.ok(
      routes.some((r) => r.startsWith("codument ack src/a.ts --reason")),
      "the concrete file-grain ack is a route",
    );
    assert.ok(
      !routes.some((r) => r.includes("<file>")),
      "a placeholder command is a pointer, never a route",
    );
  });

  it("names an anchor a shell would choke on", () => {
    assert.deepEqual(unsafeTokens('codument ack src/a.ts::area(). --reason "x"'), [
      "src/a.ts::area().",
    ]);
    assert.deepEqual(unsafeTokens('codument ack "src/a.ts::area()." --reason "x"'), []);
  });
});
