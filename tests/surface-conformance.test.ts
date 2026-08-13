import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { forgetWorkspace } from "../src/lib/git.js";
import { CONDITION_IDS, labelWidth, type ConditionId } from "../src/lib/remedies.js";
import {
  blocking,
  checkSurfaceConformance,
  cliRunner,
  plain,
  routesIn,
  type SurfaceScenario,
  uncoveredConditions,
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
      // Risk-declared: ADR 020 gates an unread file only where the project says it
      // can do damage unread, and this scenario is about the route it prints once it
      // has fired.
      "docs/.registry.json": registry({
        x: entry({ primary_sources: ["config/rules.conf"], risk: ["security"] }),
      }),
      "docs/features/x.md": DOC,
      "config/rules.conf": "allow read: if owner;\n",
    },
    change: { "config/rules.conf": "allow read: if owner;\n# a second line\n" },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "routes-clear",
    conditions: [
      {
        id: "blind-risk-file",
        as: "routes",
        ctx: { doc: "docs/features/x.md", file: "config/rules.conf" },
      },
    ],
  },
  {
    // New public surface on a precise file: a contract event the parser proves, and
    // the one class ADR 020 still gates that a signature can settle. The route it
    // prints is the FILE-grain form (`additive only →`), because a symbol that has
    // just appeared has no transition for a per-symbol ack to bind to — so the
    // command that pastes here is deliberately not the one the anchor id suggests.
    name: "additive export — the printed file ack runs and clears",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: {
      "src/shapes.ts": `${SRC}export function diagonal(w: number, h: number): number {\n  return w + h;\n}\n`,
    },
    invoke: ["review", "--strict"],
    // The drift entry, not the stale doc: the ack answers the move, and naming the
    // section it answers keeps the route judged where its reader actually meets it.
    finding: /Symbol drift/,
    expect: "routes-clear",
    conditions: [
      {
        id: "symbol-added-removed",
        as: "routes",
        ctx: { doc: "docs/features/x.md", file: "src/shapes.ts" },
      },
    ],
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
    conditions: [
      {
        id: "signature-move",
        as: "routes",
        // One claimant, so the demotion route is correctly absent — the claim is
        // written the way the surface renders it, or it would demand a route the
        // catalog is right to withhold.
        ctx: { doc: "docs/features/x.md", file: "src/shapes.ts", feature: "x", claimants: 1 },
      },
    ],
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
    conditions: [{ id: "registry-pointer", as: "reason" }],
  },
  {
    // The sharper half of the same defect, found by attacking the first fix: a doc
    // that lost ONE source among several. Judged per file, the surviving sibling's
    // ack is offered, records truthfully, is accepted — and leaves the gate red on
    // the line it sat under, because clearing one waker never settles a doc the
    // deletion still wakes. A deletion is therefore judged of the doc, not the file.
    name: "a doc that lost one source among several — no ack settles it",
    base: {
      "docs/.registry.json": registry({
        x: entry({ primary_sources: ["src/shapes.ts", "src/keep.ts"] }),
      }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
      "src/keep.ts": "export function keep(w: number): number {\n  return w;\n}\n",
    },
    change: {
      "src/shapes.ts": null,
      "src/keep.ts": "export function keep(w: number): number {\n  return w + 0;\n}\n",
    },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "no-ack-route",
    conditions: [{ id: "owned-file-deleted", as: "reason" }],
  },
  {
    // Two facts the tool has always known and always printed above the verdict, and
    // which an adversarial field report therefore wrote up as absent: registry rot it
    // inherited, and a scaffold behind the installed version. Neither gates — that is
    // settled — but a fact worth printing at all is worth printing where the reader
    // is looking, and where the reader is looking is `| tail -1`.
    name: "the verdict line carries what a pipe would otherwise destroy",
    base: {
      "docs/.registry.json": registry({
        x: entry({ primary_sources: ["src/keep.ts", "src/long-gone.ts"] }),
      }),
      "docs/features/x.md": DOC,
      "src/keep.ts": "export function keep(w: number): number {\n  return w;\n}\n",
      ".codument-meta.json": '{"version":"0.1.0"}\n',
    },
    // A CONTRACT move: ADR 020 keeps a body edit out of the drift block, and a
    // scenario whose finding never prints tests the battery, not the tool.
    change: {
      "src/keep.ts": "export function keep(w: number, pad: number): number {\n  return w + pad;\n}\n",
    },
    invoke: ["review", "--strict"],
    finding: /Symbol drift/,
    expect: "no-ack-route",
    verdictNames: [/registry path\(s\) missing/, /scaffold behind/],
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
    // A CONTRACT move. ADR 020 answers the body-only case by not asking the
    // ownership question at all — no doc goes stale, so there is no "which doc"
    // to settle — and a scenario that fires nothing cannot judge a route.
    change: {
      "src/shapes.ts": SRC.replace(
        "export function area(w: number, h: number): number {",
        "export function area(w: number, h: number, scale: number): number {",
      ),
    },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "no-ack-route",
    conditions: [
      {
        id: "ownership-unassigned",
        as: "routes",
        ctx: {
          file: "src/shapes.ts",
          feature: "x",
          candidates: ["x", "y"],
          descriptors: ["area()."],
        },
      },
    ],
  },
  {
    // The opposite ownership shape, and the one whose fix is the OPPOSITE edit:
    // both features claim the symbol, so the registry says two things. Never had a
    // scenario of its own — the catalog held a route for it that no test had ever
    // seen printed, which is the gap this inversion exists to find.
    name: "doubly-claimed symbol — the fix removes a claim, it does not add one",
    base: {
      "docs/.registry.json": registry({
        x: entry({
          primary_sources: ["src/shapes.ts"],
          owned_symbols: { "src/shapes.ts": ["area()."] },
        }),
        y: entry({
          doc: "docs/features/y.md",
          primary_sources: ["src/shapes.ts"],
          owned_symbols: { "src/shapes.ts": ["area()."] },
        }),
      }),
      "docs/features/x.md": DOC,
      "docs/features/y.md": DOC,
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
    conditions: [
      {
        id: "ownership-ambiguous",
        as: "routes",
        ctx: { file: "src/shapes.ts", candidates: ["x", "y"], descriptors: ["area()."] },
      },
    ],
  },
  {
    // A tree the registry declares, and the one collapse that keeps a locale drop
    // readable: one pattern, one command, however many files moved inside it.
    name: "a declared tree answers in one line",
    base: {
      // Risk-declared, because a tree of JSON is adapter-blind and ADR 020 only
      // gates a blind file the project says can hurt. Without the tag this
      // scenario is the "owned but unread" one below, not a tree at all.
      "docs/.registry.json": registry({
        x: entry({ primary_sources: ["locales/**"], risk: ["i18n"] }),
      }),
      "docs/features/x.md": DOC,
      "locales/en.json": '{ "hello": "hello" }\n',
      "locales/fr.json": '{ "hello": "bonjour" }\n',
    },
    change: {
      "locales/en.json": '{ "hello": "hello there" }\n',
      "locales/fr.json": '{ "hello": "bonjour à tous" }\n',
    },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "routes-clear",
    conditions: [
      {
        id: "stale-doc-tree",
        as: "routes",
        ctx: { doc: "docs/features/x.md", pattern: "locales/**", matched: 2 },
      },
    ],
  },
  {
    // The file-grain wake on a genuine source: a barrel has no precise exports, so
    // it is gated whole and the file ack is what settles it. Distinct population
    // from the blind-file case above — this one the adapter reads perfectly well
    // and there is simply nothing per-symbol in it.
    name: "a coarse source is settled at file grain",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/index.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/index.ts": 'export * from "./shapes.js";\n',
    },
    change: { "src/index.ts": 'export * from "./shapes.js";\nexport * from "./more.js";\n' },
    invoke: ["review", "--strict"],
    finding: /Stale docs/,
    expect: "routes-clear",
    conditions: [
      {
        id: "stale-doc-file",
        as: "routes",
        ctx: { doc: "docs/features/x.md", file: "src/index.ts" },
      },
    ],
  },
  {
    // A source no entry claims. The route is a POINTER (`<file>`), which is right —
    // the epilogue speaks about a set — so this is the one condition whose printed
    // form is deliberately not a pasteable command.
    name: "an unmapped source names the command that maps it",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: { "src/brand-new.ts": "export function fresh(): number {\n  return 1;\n}\n" },
    invoke: ["review", "--strict"],
    finding: /[Uu]nmapped/,
    expect: "no-ack-route",
    conditions: [{ id: "unmapped-source", as: "routes" }],
  },
  {
    // A doc still sending its reader to a path this change removed. Cousin of the
    // registry pointer and a different fix: the prose has to name where it went.
    name: "a doc pointing at a path this change removed",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": `${DOC}\n## Key files\n\n- \`src/legacy.ts\` — the old path.\n`,
      "src/shapes.ts": SRC,
      "src/legacy.ts": "export function legacy(): number {\n  return 0;\n}\n",
    },
    change: { "src/legacy.ts": null },
    invoke: ["review", "--strict"],
    finding: /doc pointer|point/i,
    expect: "no-ack-route",
    conditions: [{ id: "doc-pointer", as: "reason" }],
  },
  {
    // The same blind file as the first scenario with the risk tag taken off: ADR
    // 020 reports it and never gates, and the route it prints is the one that
    // reverses that — the project declaring the file can do damage unread.
    name: "a blind file with no declared risk is told how to earn its gate",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["config/rules.conf"] }) }),
      "docs/features/x.md": DOC,
      "config/rules.conf": "allow read: if owner;\n",
    },
    change: { "config/rules.conf": "allow read: if owner;\n# a second line\n" },
    invoke: ["review"],
    finding: /Owned but unread/,
    expect: "no-ack-route",
    conditions: [
      { id: "blind-unread-file", as: "routes", ctx: { file: "config/rules.conf", feature: "x" } },
    ],
  },
  {
    // The one surviving home of the per-symbol acknowledgment: a block-grained
    // adapter reports no signature, so nothing can prove the move was body-only and
    // ADR 020 leaves it gating. No test had ever seen this route printed either.
    name: "a move no adapter can prove body-only keeps the per-symbol ack",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/App.vue"] }) }),
      "docs/features/x.md": DOC,
      "src/App.vue": "<template>\n  <p>hello</p>\n</template>\n",
    },
    change: { "src/App.vue": "<template>\n  <p>hello there</p>\n</template>\n" },
    invoke: ["review", "--strict"],
    finding: /Symbol drift/,
    expect: "routes-clear",
    conditions: [
      {
        id: "symbol-internal-move",
        as: "routes",
        ctx: { doc: "docs/features/x.md", anchorId: "src/App.vue::template." },
      },
    ],
  },
  // ── The refusals. A command that says no is a routing surface too, and it is
  // where a reader lands after pasting something the report offered. ────────────
  {
    name: "ack refuses a move it can prove was body-only",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: { "src/shapes.ts": SRC.replace("return w * h;", "return h * w;") },
    invoke: ["ack", "src/shapes.ts::area", "--reason", "internal"],
    finding: /body-only move/,
    expect: "refusal",
    conditions: [{ id: "body-only-move", as: "reason" }],
  },
  {
    name: "ack refuses a symbol no feature owns",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/keep.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/keep.ts": "export function keep(w: number): number {\n  return w;\n}\n",
      "src/loose.ts": SRC,
    },
    change: {
      "src/loose.ts": SRC.replace(
        "export function area(w: number, h: number): number {",
        "export function area(w: number, h: number, scale: number): number {",
      ),
    },
    invoke: ["ack", "src/loose.ts::area", "--reason", "internal"],
    finding: /no feature owns/,
    expect: "refusal",
    conditions: [{ id: "symbol-unowned", as: "reason", ctx: { file: "src/loose.ts" } }],
  },
  {
    name: "ack refuses a per-symbol signature under a concept umbrella",
    base: {
      "docs/.registry.json": registry({
        x: entry({
          doc: "docs/concepts/x.md",
          type: "concept",
          primary_sources: ["src/shapes.ts"],
        }),
      }),
      "docs/concepts/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: {
      "src/shapes.ts": SRC.replace(
        "export function area(w: number, h: number): number {",
        "export function area(w: number, h: number, scale: number): number {",
      ),
    },
    invoke: ["ack", "src/shapes.ts::area", "--reason", "internal"],
    finding: /concept umbrella/,
    expect: "refusal",
    conditions: [{ id: "symbol-under-concept", as: "reason", ctx: { file: "src/shapes.ts" } }],
  },
  {
    name: "ack refuses a file the gate cannot read",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: { "src/shapes.ts": `${SRC}export function broken(: number {\n` },
    invoke: ["ack", "src/shapes.ts", "--reason", "internal"],
    finding: /does not parse/,
    expect: "refusal",
    conditions: [{ id: "unevaluable-source", as: "reason", ctx: { file: "src/shapes.ts" } }],
  },
  {
    name: "ack refuses a file that was added, not changed",
    base: {
      "docs/.registry.json": registry({ x: entry({ primary_sources: ["src/shapes.ts"] }) }),
      "docs/features/x.md": DOC,
      "src/shapes.ts": SRC,
    },
    change: { "src/fresh.ts": "export function fresh(): number {\n  return 1;\n}\n" },
    invoke: ["ack", "src/fresh.ts", "--reason", "internal"],
    finding: /was added, not changed/,
    expect: "refusal",
    conditions: [{ id: "added-file", as: "reason", ctx: { file: "src/fresh.ts" } }],
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
      // Minus the coverage rule, which is asked of the scenario SET and correctly
      // reports every condition a one-scenario run leaves unclaimed.
      violations.filter((v) => v.rule !== "6-condition-covered").map((v) => v.rule),
      ["0-scenario-fires"],
    );
  });

  it("a condition in the catalog that no scenario fires is a violation", async () => {
    // The inversion's own proof. A seeded id stands in for the real failure this
    // rule exists to catch — a capability shipped with a condition added to the
    // catalog and no surface routed to it, which every earlier version of this
    // battery would have passed silently because it only ever judged what printed.
    const seeded = "a-condition-nobody-routes" as ConditionId;
    assert.deepEqual(uncoveredConditions(SCENARIOS, [...CONDITION_IDS, seeded]), [seeded]);
    assert.deepEqual(uncoveredConditions(SCENARIOS), [], "the shipped catalog is fully covered");
  });

  it("rejects a surface that stops printing a condition's route — the inversion bites", async () => {
    // The mirror of the lying runner: not a route that cannot be honoured, but a
    // route withheld. Every rule but this one passes over the quieter output,
    // because silence is exactly what they cannot see.
    const mute = (cli: string) => {
      const real = cliRunner(cli);
      return (root: string, argv: string[]): string =>
        real(root, argv)
          .split("\n")
          .filter((l) => !/no doc impact/.test(l))
          .join("\n");
    };
    const scenario = SCENARIOS.find((s) => s.name === "a coarse source is settled at file grain");
    assert.ok(scenario, "the file-grain scenario is the one whose route is muted");
    const violations = await checkSurfaceConformance({
      arrange,
      run: mute(CLI),
      scenarios: [scenario],
    });
    assert.ok(
      violations.some(
        (v) => v.rule === "7-catalog-reaches-reader" && v.detail.includes("stale-doc-file"),
      ),
      `a withheld route went unnoticed: ${JSON.stringify(violations)}`,
    );
  });

  it("rejects a block whose label column stopped fitting its labels", async () => {
    // Rule 8's own proof. A hardcoded width is right until someone renames a label
    // past it, and then the block misaligns — a defect no assertion about WHICH
    // route printed can see, which is why the widths are now derived.
    const squeeze = (cli: string) => {
      const real = cliRunner(cli);
      return (root: string, argv: string[]): string =>
        real(root, argv).replace(/^(\s*doc impact) +→/m, "$1 →");
    };
    const scenario = SCENARIOS.find((s) => s.name === "a coarse source is settled at file grain");
    assert.ok(scenario);
    const violations = await checkSurfaceConformance({
      arrange,
      run: squeeze(CLI),
      scenarios: [scenario],
    });
    assert.ok(
      violations.some((v) => v.rule === "8-label-column-aligned"),
      `a misaligned label column went unnoticed: ${JSON.stringify(violations)}`,
    );
  });

  it("the label column is derived from the labels that share the block", () => {
    // Not a constant dressed as a call: a block of one narrow label is narrower
    // than one carrying a wide one, and adding a condition widens it.
    assert.ok(labelWidth("blind-unread-file") < labelWidth("signature-move"));
    assert.equal(
      labelWidth("signature-move", "symbol-internal-move", "symbol-added-removed"),
      labelWidth("signature-move"),
      "the widest label in the block sets the column",
    );
  });

  it("a file ack over a file no adapter reads names every line it covers", async () => {
    // The field's worst moment, as a fixture. A rules file carrying a comment edit
    // AND a rule change making private data world-readable was acked with a reason
    // naming only the comment. The reason was true; file grain covered the rest; the
    // gate went clean, exit 0, signed. Nothing in the output disclosed the rule.
    const root = await arrange({
      name: "probe 1",
      base: {
        "docs/.registry.json": registry({ x: entry({ primary_sources: ["firestore.rules"] }) }),
        "docs/features/x.md": DOC,
        "firestore.rules": "// collections - free tier\nallow read: if isOwner(userId);\n",
      },
      change: { "firestore.rules": "// collections - FREE tier\nallow read: if true;\n" },
      invoke: [],
      finding: /never used/,
      expect: "routes-clear",
    });
    const run = cliRunner(CLI);
    const signing = plain(
      run(root, ["ack", "firestore.rules", "--reason", "comment wording only"]),
    );
    assert.match(signing, /allow read: if isOwner\(userId\);/, "the removed rule is named");
    assert.match(signing, /\+ allow read: if true;/, "the rule it became is named");
    assert.ok(
      signing.indexOf("allow read: if true;") < signing.indexOf("✓ acknowledged"),
      "named BEFORE the signature is taken, not after",
    );
    const listed = JSON.parse(plain(run(root, ["ack", "--list", "--json"])));
    assert.ok(
      listed.acks[0].coveredLines.some((l: string) => l.includes("if true;")),
      "and it survives the round trip into the record",
    );
  });

  it("no surface authors a route the catalog already owns", async () => {
    // The boundary, asserted rather than left to be re-argued each release. The
    // catalog owns any route with more than one renderer — a concrete `codument`
    // command a surface offers as the fix. A POINTER (`codument ack <path>`) is
    // prose about a family of commands and stays where it reads best; a lint that
    // carries its fix inside its own single message has no twin to drift from.
    //
    // Every historical routing defect was one hand-written copy edited and its
    // twin not, so the test is: no source outside the catalog builds an ack or
    // materialize command out of a variable. Four such copies were live when this
    // was written, two of them already disagreeing about their column width.
    // `readdir` recursive rather than `fs.glob`: the CI matrix still runs Node 18
    // and 20, where `glob` does not exist and this test would throw instead of
    // asserting — a guard that fails to run is worse than one that fails.
    const src = join(here, "..", "src");
    const entries = await readdir(src, { recursive: true });
    const offenders: string[] = [];
    let scanned = 0;
    for (const rel of entries) {
      const path = `src/${String(rel).replace(/\\/g, "/")}`;
      if (!path.endsWith(".ts") || path === "src/lib/remedies.ts") continue;
      scanned += 1;
      const text = await readFile(join(src, String(rel)), "utf8");
      text.split("\n").forEach((line, i) => {
        // Interpolated: `codument ack ${...}`. A literal placeholder command is a
        // pointer and exempt; a comment is documentation, not output.
        if (!/codument (ack|map materialize) \$\{/.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        offenders.push(`${path}:${i + 1}`);
      });
    }
    // A scan that silently matched nothing would pass forever. The count is the
    // proof it looked; the catalog itself is excluded, so it can never be the one
    // file found.
    assert.ok(scanned > 50, `only ${scanned} sources scanned — the walk found nothing`);
    assert.deepEqual(offenders, [], "these build a route the catalog already renders");
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
