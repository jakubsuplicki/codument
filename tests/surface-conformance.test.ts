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
  plain,
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
