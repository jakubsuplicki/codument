import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ackCommand } from "../src/commands/ack.js";
import { buildReview, review } from "../src/commands/review.js";
import {
  ackFileName,
  isFileGrainAck,
  isTreeGrainAck,
  parseAck,
  readAcks,
  shellArg,
  treeSetHash,
  writeAck,
} from "../src/lib/acknowledgment.js";
import { adapterFor, fileContentTransition } from "../src/lib/fingerprint.js";
import { readAllEvents } from "../src/lib/events.js";
import { getGitAuthor } from "../src/lib/git.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let tmp: string;

function gitInit(root: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["add", "-A"]);
  run(["commit", "-m", "baseline"]);
}

async function scaffold(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(tmp, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

async function capture(
  fn: () => void | Promise<void>,
): Promise<{ out: string; err: string; code: number | undefined }> {
  const origLog = console.log;
  const origErr = console.error;
  const origCode = process.exitCode;
  process.exitCode = undefined;
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => {
    out += a.map(String).join(" ") + "\n";
  };
  console.error = (...a: unknown[]) => {
    err += a.map(String).join(" ") + "\n";
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const code = process.exitCode;
  process.exitCode = origCode;
  return { out: stripAnsi(out), err: stripAnsi(err), code };
}

const REGISTRY = {
  features: {
    alpha: {
      doc: "docs/features/alpha.md",
      type: "feature",
      primary_sources: ["src/a.ts"],
      status: "current",
    },
  },
};

const A_SRC = "export function foo() {\n  return 1;\n}\n";
const B_SRC = "export function bar() {\n  return 1;\n}\n";

describe("codument ack — the reachable agent-judge surface", async () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ack-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(REGISTRY, null, 2),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "src/a.ts": A_SRC,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("a bare symbol name resolves to the moved anchor and clears the stale-doc verdict", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["alpha"],
    );

    const r = await capture(() =>
      ackCommand("src/a.ts::foo", { reason: "internal: same return shape", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.match(r.out, /acknowledged src\/a\.ts::foo/);

    // the ack was written, fingerprint-bound, and clears the verdict
    const acks = readAcks(tmp);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].anchorId, "src/a.ts::foo().");
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, []);
  });

  it("the exact anchorId review prints also resolves (the canonical invocation)", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    const r = await capture(() =>
      ackCommand("src/a.ts::foo().", { reason: "refactor: contract unchanged", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.equal(readAcks(tmp)[0]?.anchorId, "src/a.ts::foo().");
  });

  it("records an identity-bearing self-ack audit event (not just a count)", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "same outputs", root: tmp }));

    const ack = readAllEvents(tmp).find((e) => e.type === "ack");
    assert.ok(ack, "an ack event was appended");
    const d = ack!.data as Record<string, unknown>;
    assert.equal(d.anchorId, "src/a.ts::foo().");
    assert.equal(d.reason, "same outputs");
    assert.equal(d.signer, "Test <test@example.com>"); // resolved git author, not "agent"
    assert.equal(d.kind, "self"); // signer == change author
    assert.ok(typeof d.fromHash === "string" && typeof d.toHash === "string");
  });

  it("a distinct --signer is recorded as an independent ack", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() =>
      ackCommand("src/a.ts::foo", { reason: "reviewed", signer: "reviewer@x.com", root: tmp }),
    );
    const ack = readAllEvents(tmp).find((e) => e.type === "ack");
    assert.equal((ack!.data as Record<string, unknown>).kind, "independent");
  });

  it("fails loud when there is nothing moved to ack", async () => {
    const r = await capture(() => ackCommand("src/a.ts::foo", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /nothing to ack/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("review's guidance for ADDED/REMOVED symbols names the file-grain command — and pasting it works", async () => {
    // foo removed + bar added: two additive-kind findings, zero moved symbols.
    await scaffold({ "src/a.ts": "export function bar() {\n  return 2;\n}\n" });

    const out = stripAnsi(execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" }));
    assert.match(out, /additive only/, "kind-aware guidance branch");
    assert.match(out, /codument ack src\/a\.ts --reason/, "suggests the FILE-grain form");
    assert.doesNotMatch(
      out,
      /codument ack src\/a\.ts::/,
      "never suggests a per-symbol ack that ack would reject",
    );

    // Paste the suggested command: it must actually succeed and clear the verdict.
    const r = await capture(() =>
      ackCommand("src/a.ts", { reason: "helper swap; narration unchanged", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, []);
  });

  it("rejects acking an ADDED symbol (it needs doc attention, not an ack)", async () => {
    await scaffold({ "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\n" });
    const r = await capture(() => ackCommand("src/a.ts::bar", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /was added, not changed/);
    // the rejection is a signpost: it names the file-grain alternative
    assert.match(r.err, /codument ack src\/a\.ts --reason/);
  });

  it("requires a reason", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    const r = await capture(() => ackCommand("src/a.ts::foo", { root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /--reason is required/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("fails loud and lists candidates when a bare name is ambiguous", async () => {
    // a value + a type alias share the name `thing` (different SCIP descriptors)
    const src = "export function thing() {\n  return 1;\n}\nexport type thing = number;\n";
    await scaffold({ "src/x.ts": src });
    gitInit(tmp); // commit src/x.ts as the new baseline
    await scaffold({
      "src/x.ts": "export function thing() {\n  return 2;\n}\nexport type thing = string;\n",
    });
    const r = await capture(() => ackCommand("src/x.ts::thing", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /ambiguous/);
    assert.match(r.err, /src\/x\.ts::thing/); // lists the candidate descriptors
    assert.equal(readAcks(tmp).length, 0);
  });

  it("--list shows recorded acks; --remove retracts (audited) and the flag returns", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "refactor only", root: tmp }));

    const listed = await capture(() => ackCommand(undefined, { list: true, root: tmp }));
    assert.match(listed.out, /Acknowledgments \(1\)/);
    assert.match(listed.out, /refactor only/);

    const handle = ackFileName(readAcks(tmp)[0]).replace(/\.json$/, "");
    const removed = await capture(() => ackCommand(undefined, { remove: handle, root: tmp }));
    assert.equal(removed.code, undefined, removed.err);
    assert.equal(readAcks(tmp).length, 0);
    // the retraction is itself audited, and the verdict returns
    assert.ok(readAllEvents(tmp).some((e) => e.type === "ack-remove"));
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["alpha"],
    );
  });

  it("the ack auto-invalidates when the symbol moves again (through the CLI)", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "refactor", root: tmp }));
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs,
      [],
      "covered while the fingerprint matches",
    );

    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["alpha"],
      "a second move invalidates the recorded ack",
    );
  });
});

describe("ack loop end-to-end through the real CLI (the headline ergonomics)", async () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ack-e2e-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(REGISTRY, null, 2),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "src/a.ts": A_SRC,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("review prints a runnable ack command; running it verbatim clears the finding; a re-move auto-invalidates", async () => {
    // a contract-neutral refactor moves foo()
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });

    // 1. review prints the exact ack command to clear it (no fingerprint copying)
    const review1 = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    const m = review1.match(/codument ack "?([^"]+?)"? --reason/);
    assert.ok(m, "review printed a runnable ack command");
    const anchorArg = m![1];
    assert.equal(anchorArg, "src/a.ts::foo().");

    // 2. run that exact command verbatim (args array — descriptor round-trips unescaped)
    execFileSync("node", [CLI, "ack", anchorArg, "--reason", "internal: same return shape"], {
      cwd: tmp,
      encoding: "utf-8",
    });

    // 3. the finding cleared: --strict now passes and the summary counts the ack
    const review2 = execFileSync("node", [CLI, "review", "--strict"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.doesNotMatch(review2, /Stale docs/);
    assert.match(review2, /1 acked \(contract-neutral\)/);

    // 4. the symbol moves AGAIN: the ack (bound to the old fingerprint) no longer
    // covers it, so --strict fails again — no ride-forever exemption
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });
    assert.throws(
      () => execFileSync("node", [CLI, "review", "--strict"], { cwd: tmp, encoding: "utf-8" }),
      (err: unknown) => (err as { status?: number }).status === 1,
      "a re-move auto-invalidates the ack and re-fires the gate",
    );
  });
});

// Plan 36: `ack` recorded an acknowledgment for a shared symbol no feature claims —
// wrote the file, printed "✓ acknowledged … re-run to confirm the finding cleared" —
// and the finding could not clear, because drift consults acks only for an anchor
// with one resolved owner. A green checkmark over a red gate is worse than a
// refusal: it spends the reader's trust in the surface. In the field, two such acks
// accumulated on one contested file, one already auto-invalidated, gate still red.
describe("ack refuses what it cannot clear, and says what would (plan 36)", async () => {
  const SHARED = "src/shared.ts";
  const SHARED_SRC = "export function priceOf() {\n  return 1;\n}\n";
  const contested = (extra: Record<string, Record<string, unknown>> = {}) => ({
    features: {
      cart: {
        doc: "docs/features/cart.md",
        type: "feature",
        primary_sources: [SHARED],
        status: "current",
        ...extra.cart,
      },
      checkout: {
        doc: "docs/features/checkout.md",
        type: "feature",
        primary_sources: [SHARED],
        status: "current",
        ...extra.checkout,
      },
    },
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ack-own-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function setup(registry: unknown): Promise<void> {
    await scaffold({
      "docs/.registry.json": JSON.stringify(registry, null, 2),
      "docs/features/cart.md": "# cart\n\nThe cart.\n",
      "docs/features/checkout.md": "# checkout\n\nCheckout.\n",
      "docs/concepts/util.md": "# util\n\nUtilities.\n",
      [SHARED]: SHARED_SRC,
    });
    gitInit(tmp);
    await scaffold({ [SHARED]: SHARED_SRC.replace("return 1;", "return 2;") });
  }

  it("an unassigned shared symbol is refused, routed to both registry fixes, and writes nothing", async () => {
    await setup(contested());
    const r = await capture(() =>
      ackCommand(`${SHARED}::priceOf`, { reason: "internal only", root: tmp }),
    );
    assert.equal(r.code, 1, "refused");
    assert.match(r.err, /shared symbol no feature claims \(cart, checkout\)/);
    // Paste-ready, and keyed on the RESOLVED descriptor — a bare symbol name is a
    // valid invocation, and a fragment echoing it back would match nothing.
    assert.match(r.err, /"owned_symbols": \{ "src\/shared\.ts": \["priceOf\(\)\."\] \}/);
    assert.match(r.err, /related_sources/);
    assert.deepStrictEqual(readAcks(tmp), [], "a refusal records nothing");
    // And the wake it would have claimed to clear is still there.
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["cart", "checkout"],
    );
  });

  it("a symbol two features both claim is refused with the opposite instruction", async () => {
    await setup(
      contested({
        cart: { owned_symbols: { [SHARED]: ["priceOf()."] } },
        checkout: { owned_symbols: { [SHARED]: ["priceOf()."] } },
      }),
    );
    const r = await capture(() =>
      ackCommand(`${SHARED}::priceOf`, { reason: "internal only", root: tmp }),
    );
    assert.equal(r.code, 1);
    assert.match(r.err, /claimed by cart and checkout/);
    assert.match(r.err, /remove the claim .*all but one/);
    assert.deepStrictEqual(readAcks(tmp), []);
  });

  it("a concept-only file is routed to the file grain that actually clears it", async () => {
    await setup({
      features: {
        util: {
          doc: "docs/concepts/util.md",
          type: "concept",
          primary_sources: [SHARED],
          status: "current",
        },
      },
    });
    const r = await capture(() =>
      ackCommand(`${SHARED}::priceOf`, { reason: "internal only", root: tmp }),
    );
    assert.equal(r.code, 1);
    assert.match(r.err, /concept umbrella/);
    assert.match(r.err, /codument ack src\/shared\.ts/);
    assert.deepStrictEqual(readAcks(tmp), []);
  });

  it("a symbol nothing governs is refused rather than banked as a decision about nothing", async () => {
    await setup({ features: {} });
    const r = await capture(() =>
      ackCommand(`${SHARED}::priceOf`, { reason: "internal only", root: tmp }),
    );
    assert.equal(r.code, 1);
    assert.match(r.err, /nothing gates it/);
    assert.match(r.err, /map materialize/);
    assert.deepStrictEqual(readAcks(tmp), []);
  });

  it("claiming the symbol makes the very same ack work — the refusal was routing, not policy", async () => {
    await setup(contested({ cart: { owned_symbols: { [SHARED]: ["priceOf()."] } } }));
    const r = await capture(() =>
      ackCommand(`${SHARED}::priceOf`, { reason: "internal: same return shape", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.match(r.out, /acknowledged/);
    assert.equal(readAcks(tmp).length, 1);
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, [], "and it clears the wake");
  });
});

// Plan 41 remediation: the rename map reached `buildReview` and nothing else, so
// `review` and `ack` disagreed about the same moved file. Review called a renamed
// symbol `changed` and printed an ack for it; ack read the base blob at the
// DESTINATION, found nothing there, called it `added`, and refused its own
// instruction — leaving the doc edit the ack route exists to prevent. The rule the
// gate already claims: every resolution command the surface prints works when pasted.
describe("a MOVED file is judged the same way by review and by ack", async () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ack-rename-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const run = (args: string[]): { code: number; out: string } => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [CLI, ...args], {
          cwd: tmp,
          encoding: "utf-8",
          env: { ...process.env, NO_COLOR: "1" },
        }),
      };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? 1, out: e.stdout ?? "" };
    }
  };

  const registryFor = (sources: string[], doc = "docs/features/alpha.md") =>
    JSON.stringify(
      {
        features: {
          alpha: { doc, type: "feature", primary_sources: sources, status: "current" },
        },
      },
      null,
      2,
    );

  it("the per-symbol ack review prints for a renamed file runs, and clears the gate", async () => {
    await scaffold({
      "docs/.registry.json": registryFor(["src/a.ts"]),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "src/a.ts": A_SRC,
    });
    gitInit(tmp);

    execFileSync("git", ["mv", "src/a.ts", "src/b.ts"], { cwd: tmp });
    await scaffold({
      "src/b.ts": A_SRC.replace("return 1;", "return 2;"),
      "docs/.registry.json": registryFor(["src/b.ts"]),
    });

    // The move is judged as a move: the symbol reads `changed`, not `added` — so a
    // per-symbol ack is offered at all.
    const review = run(["review"]);
    const m = review.out.match(/codument ack "?([^"]+?)"? --reason/);
    assert.ok(m, `review must offer a per-symbol ack for a moved symbol:\n${review.out}`);
    assert.equal(m![1], "src/b.ts::foo().");

    // Pasting it works — the half that used to refuse.
    const acked = run(["ack", m![1], "--reason", "internal: same return shape"]);
    assert.equal(acked.code, 0, `the printed ack must run:\n${acked.out}`);

    assert.equal(run(["review", "--strict"]).code, 0, "and it must clear the gate");
  });

  it("a PURE rename wakes nothing at any grain — precise, coarse, or governed", async () => {
    // The rename-aware base read only ever reached the precise branch, so a coarse
    // file (no per-symbol anchors) and a governed registered one (no adapter at all)
    // still read their destination as fresh content at a new path: every primary
    // owner woken, for a change that moved no contract, with the printed file-grain
    // ack refused for the same base-path reason.
    await scaffold({
      "docs/.registry.json": registryFor(["src/a.ts", "app/settings.py", "app/site.css"]),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "src/a.ts": A_SRC,
      "app/settings.py": "_DEBUG = True\n",
      "app/site.css": "body { color: red; }\n",
    });
    gitInit(tmp);

    execFileSync("git", ["mv", "src/a.ts", "src/z.ts"], { cwd: tmp });
    execFileSync("git", ["mv", "app/settings.py", "app/config.py"], { cwd: tmp });
    execFileSync("git", ["mv", "app/site.css", "app/style.css"], { cwd: tmp });
    await scaffold({
      "docs/.registry.json": registryFor(["src/z.ts", "app/config.py", "app/style.css"]),
    });

    const r = run(["review", "--strict"]);
    assert.equal(r.code, 0, `three pure renames must wake nothing:\n${r.out}`);
    assert.doesNotMatch(r.out, /Stale docs/, "no doc is owed prose for a move");
  });

  it("a rename that ALSO edits still fires at coarse grain, and its printed ack works", async () => {
    // The control for the case above: silence must come from the content being
    // identical, never from renames being skipped wholesale.
    await scaffold({
      "docs/.registry.json": registryFor(["app/site.css"]),
      "docs/features/alpha.md": "# alpha\n\nStyles the page.\n",
      "app/site.css": "body { color: red; }\n",
    });
    gitInit(tmp);

    execFileSync("git", ["mv", "app/site.css", "app/style.css"], { cwd: tmp });
    await scaffold({
      "app/style.css": "body { color: blue; }\n",
      "docs/.registry.json": registryFor(["app/style.css"]),
    });

    const r = run(["review", "--strict"]);
    assert.equal(r.code, 1, `a moved-AND-edited file still owes its doc:\n${r.out}`);
    const m = r.out.match(/codument ack "?([^"]+?)"? --reason/);
    assert.ok(m, `the file-grain route must be offered:\n${r.out}`);
    assert.equal(m![1], "app/style.css");

    const acked = run(["ack", m![1], "--reason", "recolour only; no documented contract moved"]);
    assert.equal(acked.code, 0, `the printed file-grain ack must run:\n${acked.out}`);
    assert.equal(run(["review", "--strict"]).code, 0, "and it must clear the gate");
  });
});

// ── File-grain ack: `codument ack <path>` ───────────────────────────────────
//
// The additive/concept/coarse residue a per-symbol ack cannot reach, cleared with a
// real fingerprint-bound decision instead of a `last_reviewed` date bump — while
// never masking a moved owned symbol.

const FG_REGISTRY = {
  features: {
    alpha: {
      doc: "docs/features/alpha.md",
      type: "feature",
      primary_sources: ["src/a.ts"],
      status: "current",
    },
    util: {
      doc: "docs/concepts/util.md",
      type: "concept",
      primary_sources: ["src/u.ts"],
      status: "current",
    },
  },
};

const U_SRC = "export function helper() {\n  return 10;\n}\n";
const staleFeatures = (root: string): string[] =>
  buildReview(root)
    .state.staleDocs.map((d) => d.feature)
    .sort();

describe("codument ack <path> — the file-grain surface", async () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ackfile-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(FG_REGISTRY, null, 2),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "docs/concepts/util.md": "# util\n\nShared helpers for the util layer.\n",
      "src/a.ts": A_SRC,
      "src/u.ts": U_SRC,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("clears an ADDITIVE change's stale-doc verdict, fingerprint-bound and auto-invalidating", async () => {
    // A new exported helper — "added, not changed": no symbol to ack, so today the
    // only clear is a doc/last_reviewed touch. The file ack replaces that.
    await scaffold({ "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\n" });
    assert.deepStrictEqual(staleFeatures(tmp), ["alpha"], "the added helper wakes alpha");

    const r = await capture(() =>
      ackCommand("src/a.ts", { reason: "internal helper; no public contract added", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.match(r.out, /acknowledged file src\/a\.ts/);
    assert.doesNotMatch(r.out, /NOT cleared/, "an added symbol is not a moved symbol — no warning");
    // The API growth is still made visible (info-only) — a conscious vouch, not a silent sweep.
    assert.match(r.out, /cleared 1 added\/removed export\(s\)/);
    assert.match(r.out, /bar \(added\)/);

    const acks = readAcks(tmp);
    assert.equal(acks.length, 1);
    assert.equal(acks[0].anchorId, "src/a.ts", "a bare path — a file-grain ack");
    assert.deepStrictEqual(staleFeatures(tmp), [], "the file ack clears the additive staleness");

    // Auto-invalidation: a further edit moves the file content → the ack no longer covers.
    await scaffold({
      "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\nexport const K = 3;\n",
    });
    assert.deepStrictEqual(staleFeatures(tmp), ["alpha"], "a later change re-fires the gate");
  });

  it("clears a CONCEPT umbrella's file-grain staleness (and does not false-warn on its unowned move)", async () => {
    // src/u.ts is owned only by the `util` concept (file-grain). Moving its symbol
    // wakes the concept with no per-symbol anchor to ack.
    await scaffold({ "src/u.ts": U_SRC.replace("return 10;", "return 11;") });
    assert.deepStrictEqual(staleFeatures(tmp), ["util"], "the concept woke file-grain");

    const r = await capture(() =>
      ackCommand("src/u.ts", { reason: "reordered internals; util contract unchanged", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    // The moved symbol is unowned (concept-only) → fully cleared by the file ack →
    // no misleading "moved symbol NOT cleared" warning.
    assert.doesNotMatch(r.out, /NOT cleared/);
    assert.deepStrictEqual(staleFeatures(tmp), [], "the file ack clears the concept staleness");
  });

  it("NEVER masks a moved owned symbol: records + warns, and the feature stays flagged until resolved", async () => {
    // foo() moves (a real contract-changing anchor) AND a helper is added.
    await scaffold({
      "src/a.ts":
        A_SRC.replace("return 1;", "return 2;") + "export function bar() {\n  return 9;\n}\n",
    });
    assert.deepStrictEqual(staleFeatures(tmp), ["alpha"]);

    // File ack: records, but names the still-flagged moved owned symbol.
    const r = await capture(() => ackCommand("src/a.ts", { reason: "additive helper only", root: tmp }));
    assert.equal(r.code, undefined, r.err);
    assert.match(r.out, /1 moved symbol\(s\) in this file are NOT cleared by a file ack/);
    assert.match(r.out, /src\/a\.ts::foo/);
    assert.deepStrictEqual(staleFeatures(tmp), ["alpha"], "the moved foo() keeps alpha flagged");

    // Resolve the move with a symbol ack — now the file ack's additive residue clears.
    const r2 = await capture(() =>
      ackCommand("src/a.ts::foo", { reason: "same return shape", root: tmp }),
    );
    assert.equal(r2.code, undefined, r2.err);
    assert.deepStrictEqual(
      staleFeatures(tmp),
      [],
      "moved symbol acked + additive residue file-acked → clean",
    );
  });

  it("refuses to ack a file that does not parse (fail-loud stance preserved)", async () => {
    await scaffold({ "src/a.ts": "export function foo( {\n  return 1;\n" }); // syntax error
    const r = await capture(() => ackCommand("src/a.ts", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /does not parse/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("refuses when there is no content change (nothing to ack)", async () => {
    const r = await capture(() => ackCommand("src/a.ts", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /unchanged.*nothing to ack/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("refuses an added (untracked) file — it needs doc attention, not a file ack", async () => {
    await scaffold({ "src/new.ts": "export const z = 1;\n" });
    const r = await capture(() => ackCommand("src/new.ts", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /was added, not changed/);
  });

  it("refuses a DELETED file — no acknowledgment clears a deletion (a removal owes doc attention)", async () => {
    await rm(join(tmp, "src", "a.ts"));
    const r = await capture(() => ackCommand("src/a.ts", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /was deleted, not changed/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("still requires a reason for the bare-path form", async () => {
    const r = await capture(() => ackCommand("src/a.ts", { root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /--reason is required/);
  });

  it("review's resolution summary shows a file-ack AS a file-ack, never laundered as a doc update", async () => {
    await scaffold({ "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\n" });
    execFileSync(
      "node",
      [CLI, "ack", "src/a.ts", "--reason", "internal helper; no contract added"],
      {
        cwd: tmp,
        encoding: "utf-8",
      },
    );
    const out = execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" });
    assert.match(out, /1 file-acked \(additive\)/, "over-acking stays visible as a file ack");
    assert.doesNotMatch(out, /1 resolved by doc update/, "not counted as a doc update");
  });
});

describe("a per-symbol ack never clears the concept umbrella (ADR-012, end-to-end)", () => {
  // src/a.ts is owned by feature `alpha` AND narrated by concept umbrella `lib`.
  const CONCEPT_REGISTRY = {
    features: {
      alpha: {
        doc: "docs/features/alpha.md",
        type: "feature",
        primary_sources: ["src/a.ts"],
        status: "current",
      },
      lib: {
        doc: "docs/concepts/lib.md",
        type: "concept",
        primary_sources: ["src/a.ts"],
        status: "current",
      },
    },
  };

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ack-concept-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(CONCEPT_REGISTRY, null, 2),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "docs/concepts/lib.md": "# lib\n\nNarrates src/a.ts file-by-file.\n",
      "src/a.ts": A_SRC,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("symbol ack clears the feature; the umbrella stays until a file ack (or doc update) clears it", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    // one moved symbol wakes both owners
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["alpha", "lib"],
    );

    // the per-symbol ack adjudicates alpha's contract ONLY
    const r = await capture(() =>
      ackCommand("src/a.ts::foo", { reason: "internal: same return shape", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["lib"],
      "the concept umbrella is NOT cleared by a per-symbol ack",
    );

    // the file-grain judgment is what clears the umbrella's residue
    const rf = await capture(() =>
      ackCommand("src/a.ts", {
        reason: "file narration unchanged: helper-internal edit",
        root: tmp,
      }),
    );
    assert.equal(rf.code, undefined, rf.err);
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, []);
  });
});

describe("codument ack --list --json — the machine audit surface", async () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-acklist-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(REGISTRY, null, 2),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "src/a.ts": A_SRC,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const listJson = async (): Promise<{ version: number; acks: Record<string, unknown>[] }> => {
    const r = await capture(() => ackCommand(undefined, { list: true, json: true, root: tmp }));
    assert.equal(r.code, undefined, r.err);
    return JSON.parse(r.out);
  };

  it("emits a versioned contract with the anchor, transition, signer, reason and validity", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "internal: same shape", root: tmp }));

    const payload = await listJson();
    assert.equal(payload.version, 1);
    assert.equal(payload.acks.length, 1);
    const a = payload.acks[0];
    assert.equal(a.anchorId, "src/a.ts::foo().");
    assert.equal(a.path, "src/a.ts");
    assert.equal(a.symbol, "foo().");
    assert.equal(a.grain, "symbol");
    assert.equal(a.reason, "internal: same shape");
    assert.equal(a.signer, "Test <test@example.com>");
    assert.equal(a.validity, "covering");
    assert.ok(typeof a.from === "string" && typeof a.to === "string");
    assert.ok(typeof a.handle === "string" && (a.handle as string).length > 0);
  });

  it("an ack that moved again shows validity: invalidated (in JSON and in the human list)", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "refactor", root: tmp }));
    assert.equal((await listJson()).acks[0].validity, "covering");

    // The symbol moves past what the ack vouched for → auto-invalidation, made visible.
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });
    assert.equal((await listJson()).acks[0].validity, "invalidated");

    const human = await capture(() => ackCommand(undefined, { list: true, root: tmp }));
    assert.match(human.out, /auto-invalidated/);
  });

  it("validity is base-independent: a covering ack stays covering after the change is committed", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "refactor", root: tmp }));
    assert.equal((await listJson()).acks[0].validity, "covering");

    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "land the refactor + ack"], { cwd: tmp, stdio: "ignore" });
    assert.equal(
      (await listJson()).acks[0].validity,
      "covering",
      "a committed acked change still matches the vouch — not read as moot/invalidated",
    );
  });

  it("a file-grain ack round-trips as grain: file with a null symbol, and invalidates on a later edit", async () => {
    await scaffold({ "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\n" });
    await capture(() => ackCommand("src/a.ts", { reason: "additive helper only", root: tmp }));

    const a = (await listJson()).acks[0];
    assert.equal(a.grain, "file");
    assert.equal(a.symbol, null);
    assert.equal(a.path, "src/a.ts");
    assert.equal(a.validity, "covering");

    await scaffold({
      "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\nexport const K = 3;\n",
    });
    assert.equal((await listJson()).acks[0].validity, "invalidated");
  });

  it("a symbol ack over a now-unparseable file reads indeterminate, never a false verdict", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "refactor", root: tmp }));
    await scaffold({ "src/a.ts": "export function foo( {\n  return 2;\n" }); // parse error
    assert.equal((await listJson()).acks[0].validity, "indeterminate");
  });

  it("empty list is a valid, versioned, empty contract (never a crash)", async () => {
    const payload = await listJson();
    assert.equal(payload.version, 1);
    assert.deepEqual(payload.acks, []);
  });

  it("validity agrees with the gate for a duplicate-descriptor anchor (declaration merging, last-wins)", async () => {
    // Two `export interface Foo` merge into one descriptor `Foo#`, so the adapter
    // emits TWO anchors with the same id. diffAnchorSets (and so the gate) records
    // the ack's `to` from the LAST one via a Map; ackValidity must resolve the same
    // last-wins anchor, not find-first, or a still-covering ack reads invalidated on
    // an unchanged tree — contradicting the gate's own ackCovers verdict.
    const MERGED = "export interface Foo {\n  a: number;\n}\nexport interface Foo {\n  b: number;\n}\n";
    await scaffold({ "src/x.ts": MERGED });

    const anchors = adapterFor("src/x.ts").anchors("src/x.ts", MERGED);
    const dup = anchors.filter((a) => a.id === "src/x.ts::Foo#");
    assert.equal(dup.length, 2, "declaration merging emits two anchors with one descriptor");
    const lastWins = new Map(anchors.map((a) => [a.id, a])).get("src/x.ts::Foo#");
    assert.notEqual(dup[0].fingerprint, dup[1].fingerprint, "the two share an id but differ in fp");

    // Record the ack exactly as the gate would: bound to the last-wins fingerprint.
    writeAck(tmp, {
      anchorId: "src/x.ts::Foo#",
      fromHash: "base-fingerprint",
      toHash: lastWins!.fingerprint,
      reason: "merged-descriptor refactor",
      signer: "Test <test@example.com>",
    });

    const ack = (await listJson()).acks.find((a) => a.anchorId === "src/x.ts::Foo#");
    assert.ok(ack, "the ack is listed");
    assert.equal(
      ack.validity,
      "covering",
      "resolves the same last-wins anchor the gate bound → agrees (a find-first classifier would read invalidated)",
    );
  });
});

// Auto-invalidation (ADR 006) is the trust model working: an ack vouches for one
// fingerprint transition and stops covering the moment the anchor moves past it. What
// it produced in the field was dead weight nothing swept — 52 of 342 acks invalidated,
// each printing its own `--remove` hint that no step in the loop ever ran.
describe("codument ack --prune — sweeping what auto-invalidation left behind", async () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ackprune-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(
        {
          features: {
            alpha: { ...REGISTRY.features.alpha, primary_sources: ["src/a.ts", "src/b.ts"] },
          },
        },
        null,
        2,
      ),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "src/a.ts": A_SRC,
      "src/b.ts": B_SRC,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const prune = () => capture(() => ackCommand(undefined, { prune: true, root: tmp }));
  const handles = (): string[] => readAcks(tmp).map((a) => ackFileName(a).replace(/\.json$/, ""));

  it("removes the invalidated acks and leaves every covering one standing", async () => {
    // Two acks on two files; only the first file moves again, so only its ack dies.
    await scaffold({
      "src/a.ts": A_SRC.replace("return 1;", "return 2;"),
      "src/b.ts": `${B_SRC}export const K = 1;\n`,
    });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "internal", root: tmp }));
    await capture(() => ackCommand("src/b.ts", { reason: "additive only", root: tmp }));
    assert.equal(handles().length, 2);

    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });
    const r = await prune();
    assert.equal(r.code, undefined, r.err);
    assert.match(r.out, /pruned 1 auto-invalidated acknowledgment\(s\); 1 still recorded/);

    const left = readAcks(tmp);
    assert.equal(left.length, 1);
    assert.equal(left[0].anchorId, "src/b.ts", "the covering ack survives");
  });

  it("says so and removes nothing when every ack still covers", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "internal", root: tmp }));

    const r = await prune();
    assert.equal(r.code, undefined, r.err);
    assert.match(r.out, /Nothing to prune/);
    assert.equal(readAcks(tmp).length, 1);
  });

  it("is idempotent — a second pass finds nothing left to sweep", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "internal", root: tmp }));
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });

    assert.match((await prune()).out, /pruned 1 /);
    const second = await prune();
    assert.equal(second.code, undefined, second.err);
    assert.match(second.out, /No acknowledgments recorded/);
  });

  it("never touches an INDETERMINATE ack — an unreadable file is not a dead judgment", async () => {
    // The file stops parsing, so validity cannot be computed. Deleting the ack here
    // would destroy a recorded judgment on the strength of a parse error the user
    // still has to fix — and the ack may well be covering once it does.
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "internal", root: tmp }));
    await scaffold({ "src/a.ts": "export function foo( {\n  return 2;\n" });

    const r = await prune();
    assert.match(r.out, /Nothing to prune/);
    assert.equal(readAcks(tmp).length, 1, "the judgment survives the parse error");
  });

  it("every sweep is auditable on the same path a hand removal uses", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "internal", root: tmp }));
    const dead = handles()[0];
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });
    await prune();

    const removals = readAllEvents(tmp).filter((e) => e.type === "ack-remove");
    assert.equal(removals.length, 1);
    const data = (removals[0] as { data: { handle: string; anchorId: string | null } }).data;
    assert.equal(data.handle, dead);
    assert.equal(data.anchorId, "src/a.ts::foo().");
  });

  it("the list ends with the one command that clears the pile, not a hint per ack", async () => {
    await scaffold({
      "src/a.ts": A_SRC.replace("return 1;", "return 2;"),
      "src/b.ts": `${B_SRC}export const K = 1;\n`,
    });
    await capture(() => ackCommand("src/a.ts::foo", { reason: "internal", root: tmp }));
    await capture(() => ackCommand("src/b.ts", { reason: "additive only", root: tmp }));
    await scaffold({
      "src/a.ts": A_SRC.replace("return 1;", "return 999;"),
      "src/b.ts": `${B_SRC}export const K = 2;\n`,
    });

    const list = stripAnsi((await capture(() => ackCommand(undefined, { list: true, root: tmp }))).out);
    assert.match(list, /2 of these are auto-invalidated and clear nothing — `codument ack --prune`/);
  });
});

describe("getGitAuthor", async () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-author-"));
    await scaffold({ "src/a.ts": A_SRC });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns the configured Name <email> identity", () => {
    assert.equal(getGitAuthor(tmp), "Test <test@example.com>");
  });

  it("returns null outside a git repo", async () => {
    const bare = await mkdtemp(join(tmpdir(), "codument-nogit-"));
    try {
      assert.equal(getGitAuthor(bare), null);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("shellArg — a printed command has to survive the shell it is pasted into", () => {
  it("leaves a token a shell would not touch alone", () => {
    assert.equal(shellArg("src/a.ts"), "src/a.ts");
    assert.equal(shellArg("src/a.ts::foo."), "src/a.ts::foo.");
    assert.equal(shellArg("app/Button.tsx::default."), "app/Button.tsx::default.");
  });

  it("quotes the descriptors a shell would choke on", () => {
    // `foo().` is a syntax error in bash and `<module>` is a redirection — both are
    // anchors codument prints in the command it asks the reader to run.
    assert.equal(shellArg("src/a.ts::foo()."), '"src/a.ts::foo()."');
    assert.equal(shellArg("app/_layout.tsx::<module>"), '"app/_layout.tsx::<module>"');
    assert.equal(shellArg("src/my file.ts"), '"src/my file.ts"');
  });

  it("escapes what double quotes still interpret", () => {
    assert.equal(shellArg('a"b'), '"a\\"b"');
    assert.equal(shellArg("a$b"), '"a\\$b"');
    assert.equal(shellArg("a`b"), '"a\\`b"');
    assert.equal(shellArg("a\\b"), '"a\\\\b"');
  });
});

describe("signature/body split — the ack acceptance table", async () => {
  // base: a zero-arg exported function; its doc narrates the contract.
  const SIG_REG = {
    features: {
      alpha: {
        doc: "docs/features/alpha.md",
        type: "feature",
        primary_sources: ["src/a.ts"],
        status: "current",
      },
    },
  };
  const BASE = "export function foo() {\n  return 1;\n}\n";
  const SIG_MOVED = "export function foo(x: number) {\n  return x;\n}\n"; // param added → signature
  const BODY_MOVED = "export function foo() {\n  return 2;\n}\n"; // body only

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-sig-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(SIG_REG, null, 2),
      "docs/features/alpha.md": "# alpha\n\nThe foo() helper returns a number.\n",
      "src/a.ts": BASE,
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("a body-only move is ackable and clears the verdict (the cheap path is preserved)", async () => {
    await scaffold({ "src/a.ts": BODY_MOVED });
    const finding = buildReview(tmp).drift.find((d) => d.symbol === "foo");
    assert.equal(finding?.signatureChanged, false, "body-only move");
    const r = await capture(() =>
      ackCommand("src/a.ts::foo", { reason: "same return shape", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, []);
  });

  // Plan 42 / the 2026-08-09 field report, C3 and C4. The line that would have worked
  // was `codument ack <path>::<symbol>` — a shape to fill in, printed dim and last,
  // below the warning and below the "Re-run" advice. The agent read past it in one
  // step, rewrote a doc instead, and only obeyed it in the next.
  it("names the exact per-symbol command, and it clears what it names", async () => {
    await scaffold({ "src/a.ts": BODY_MOVED });
    const r = await capture(() =>
      ackCommand("src/a.ts", { reason: "file-level: trust me", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);

    assert.match(
      r.out,
      /codument ack "src\/a\.ts::foo\(\)\." --reason/,
      "the anchor is filled in, not left as a placeholder",
    );
    assert.doesNotMatch(r.out, /<path>::<symbol>/, "a shape to assemble is not a command");
    // And it has to survive the shell it will be pasted into: `foo().` bare is a
    // syntax error in bash, and `<module>` is a redirection. Every per-symbol ack
    // command this tool printed had to be repaired by the reader before it would run.
    assert.match(r.out, /codument ack "src\/a\.ts::foo\(\)\."/, "shell-safe as printed");
    // The resolution sits inside the finding it resolves, above the closing advice.
    const warn = r.out.indexOf("NOT cleared by a file ack");
    const cmd = r.out.indexOf('codument ack "src/a.ts::foo()."');
    assert.ok(warn >= 0 && cmd > warn, "the command belongs with the symbol it resolves");

    // The whole point: run exactly what was printed and the finding clears.
    const printed = /codument ack "?([^"]+?)"? --reason/.exec(r.out);
    assert.ok(printed, "a runnable command was printed");
    const second = await capture(() =>
      ackCommand(printed[1], { reason: "same return shape", root: tmp }),
    );
    assert.equal(second.code, undefined, second.err);
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, []);
  });

  it("does not read as a failure of the ack that just succeeded", async () => {
    await scaffold({ "src/a.ts": BODY_MOVED });
    const r = await capture(() =>
      ackCommand("src/a.ts", { reason: "file-level: trust me", root: tmp }),
    );
    assert.match(
      r.out,
      /the ack above stands/,
      "the file ack did what it was asked; the remaining symbols were never in its reach",
    );
    assert.equal(readAcks(tmp).length, 1, "and it really was written");
  });

  it("a signature move is classified, stays stale, and a per-symbol ack is refused", async () => {
    await scaffold({ "src/a.ts": SIG_MOVED });
    const finding = buildReview(tmp).drift.find((d) => d.symbol === "foo");
    assert.ok(finding?.signatureChanged, "classified as a signature move");
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["alpha"],
    );

    const r = await capture(() => ackCommand("src/a.ts::foo", { reason: "trust me", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /signature changed/);
    assert.equal(readAcks(tmp).length, 0, "no ack was written");
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["alpha"],
    );
  });

  it("a file-grain ack does NOT clear a signature move — the verdict persists", async () => {
    await scaffold({ "src/a.ts": SIG_MOVED });
    const r = await capture(() => ackCommand("src/a.ts", { reason: "file-level: trust me", root: tmp }));
    assert.equal(r.code, undefined, r.err); // the file ack is recorded...
    // ...but the sig-moved symbol still wakes: a changed symbol is never file-ack-cleared.
    assert.match(r.out, /NOT cleared by a file ack/);
    assert.match(r.out, /\(signature changed\)/, "the moved symbol is tagged as a signature move");
    // and the file-ack guidance routes a signature move to the doc, never to an ack.
    assert.match(r.out, /contract changed → update docs\/features\/alpha\.md/);
    assert.match(r.out, /no ack of any grain clears a signature move/);
    assert.doesNotMatch(r.out, /codument ack src\/a\.ts::foo/, "no per-symbol ack is suggested");
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["alpha"],
    );
  });

  it("updating the owning doc clears a signature move", async () => {
    await scaffold({
      "src/a.ts": SIG_MOVED,
      "docs/features/alpha.md": "# alpha\n\nThe foo(x) helper returns its argument.\n",
    });
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, []);
  });

  it("review's guidance for a signature move names the doc update, never an ack", async () => {
    await scaffold({ "src/a.ts": SIG_MOVED });
    const out = stripAnsi(execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" }));
    assert.match(out, /\[signature changed\]/);
    assert.match(out, /signature move/);
    assert.doesNotMatch(
      out,
      /codument ack src\/a\.ts::foo/,
      "never a per-symbol ack for a sig move",
    );
  });
});

// Plan 43 step 3: a tree that one registry line governs is answered for by one
// signature. The field's shape — six language packs, 120 files, one judgment — and
// the properties that keep the width honest: it decays on the next move, a file
// appearing under the pattern refuses it, and only a DECLARED tree is ackable.
describe("codument ack <pattern> — one signature for a governed tree (plan 43)", () => {
  const TREE = "i18n/locales/**/*.json";
  const TREE_REGISTRY = {
    features: {
      i18n: {
        doc: "docs/concepts/i18n.md",
        type: "concept",
        primary_sources: [TREE],
        status: "current",
      },
    },
  };
  const locales = (n: number, value: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      out[`i18n/locales/l${i}/common.json`] = `${JSON.stringify({ greeting: value })}\n`;
    }
    return out;
  };
  const stale = (): string[] => buildReview(tmp).state.staleDocs.map((d) => d.feature);

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-tree-ack-"));
    await scaffold({
      "docs/.registry.json": JSON.stringify(TREE_REGISTRY, null, 2),
      "docs/concepts/i18n.md": "# i18n\n\nEvery user-visible string ships once per locale.\n",
      ...locales(4, "hei"),
    });
    gitInit(tmp);
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("the field's shape: 120 files move, one acknowledgment answers, and it decays on the next move", async () => {
    // 116 more packs on top of the 4 committed at baseline, all committed, then all
    // corrected in one pass — the 27-file correction that cost 27 signatures.
    await scaffold(locales(120, "hei"));
    execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "six packs"], { cwd: tmp, stdio: "ignore" });
    await scaffold(locales(120, "moi"));
    assert.deepStrictEqual(stale(), ["i18n"], "120 files inside a governed tree wake it");

    const r = await capture(() =>
      ackCommand(TREE, { reason: "wording pass; no new keys and no locale added", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.match(r.out, /acknowledged tree i18n\/locales\/\*\*\/\*\.json/);
    assert.match(r.out, /120 files/, "the width is disclosed as it writes");

    const acks = readAcks(tmp);
    assert.equal(acks.length, 1, "one signature, not 120");
    assert.equal(acks[0].covered?.length, 120, "and the record says what it vouched for");
    assert.deepStrictEqual(stale(), [], "the tree's wake is cleared");

    // ...and it is not a ride-forever exemption: one file moving again decays it.
    await scaffold({ "i18n/locales/l7/common.json": `${JSON.stringify({ greeting: "terve" })}\n` });
    assert.deepStrictEqual(stale(), ["i18n"], "one file moved → the whole vouch is spent");
  });

  it("a file appearing under the tree AFTER the ack decays it — a new locale is not residue", async () => {
    // The half a set comparison alone would miss: the vouched files still hash to
    // what was recorded, so only the arrival itself can spend the ack. ADR 012 lets a
    // file ack sweep up additive residue inside a file it vouched for; a new file
    // under a governed tree is a new governed unit, and adding a language is the
    // change in a locale tree most worth seeing.
    await scaffold(locales(4, "moi"));
    await capture(() => ackCommand(TREE, { reason: "wording pass", root: tmp }));
    assert.deepStrictEqual(stale(), []);

    await scaffold({ "i18n/locales/l9/common.json": `${JSON.stringify({ greeting: "hallo" })}\n` });
    assert.deepStrictEqual(stale(), ["i18n"], "a new pack wakes the doc despite the ack");
    assert.deepStrictEqual(
      buildReview(tmp).coveringAcks,
      [],
      "and the vouch stands for nothing — a card still calling the tree adjudicated is the false green",
    );
  });

  it("a file APPEARING under the tree is refused, never waved through", async () => {
    await scaffold({
      ...locales(4, "moi"),
      "i18n/locales/l9/common.json": `${JSON.stringify({ greeting: "hallo" })}\n`,
    });
    const r = await capture(() => ackCommand(TREE, { reason: "wording pass", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /added or removed, not changed/);
    assert.match(r.err, /docs\/concepts\/i18n\.md/, "the refusal names the doc that owes the line");
    assert.match(r.err, /i18n\/locales\/l9\/common\.json/, "and which file it was");
    assert.deepStrictEqual(readAcks(tmp), [], "nothing is recorded");
  });

  it("a deletion inside the tree is refused too — a removal owes its doc a line", async () => {
    await scaffold(locales(3, "moi"));
    rmSync(join(tmp, "i18n/locales/l3/common.json"));
    const r = await capture(() => ackCommand(TREE, { reason: "wording pass", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /added or removed, not changed/);
    assert.deepStrictEqual(readAcks(tmp), []);
  });

  it("only a DECLARED tree is ackable — an ad-hoc glob vouches for nothing", async () => {
    await scaffold(locales(4, "moi"));
    const r = await capture(() => ackCommand("i18n/**", { reason: "wording pass", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /no registry entry declares i18n\/\*\*/);
    assert.match(r.err, /Governed trees: i18n\/locales\/\*\*\/\*\.json/, "and names the real one");
    assert.deepStrictEqual(readAcks(tmp), [], "an unregistered glob records nothing");
    assert.deepStrictEqual(stale(), ["i18n"], "and clears nothing");
  });

  it("a hand-written tree ack over an undeclared pattern is inert at the gate", async () => {
    // The file-on-disk path, not the command path: a merged/forged ack naming a glob
    // nobody registered must not sweep the repo's coarse wakes.
    await scaffold(locales(4, "moi"));
    // Real transitions, so the ONLY thing standing between this record and a swept
    // gate is the registration check.
    const covered = ["l0", "l1", "l2", "l3"].map((l) => {
      const path = `i18n/locales/${l}/common.json`;
      const t = fileContentTransition(tmp, "HEAD", path);
      return { path, from: t.from as string, to: t.to as string };
    });
    writeAck(tmp, {
      anchorId: "i18n/**",
      fromHash: treeSetHash(covered, "from"),
      toHash: treeSetHash(covered, "to"),
      reason: "an undeclared tree",
      signer: "someone",
      covered,
    });
    assert.deepStrictEqual(stale(), ["i18n"], "an undeclared tree clears nothing");
    assert.deepStrictEqual(buildReview(tmp).coveringAcks, [], "and adjudicates nothing");
  });

  it("the set is judged whole: one file leaving the change spends the vouch", async () => {
    // Not a moved file — a REVERTED one. Every remaining member still hashes to what
    // was vouched for, so only judging the set whole catches it. Fails closed: the
    // cost is one re-ack, and the alternative is a record that outlives the change it
    // was written about.
    await scaffold(locales(4, "moi"));
    await capture(() => ackCommand(TREE, { reason: "wording pass", root: tmp }));
    assert.deepStrictEqual(stale(), []);

    await scaffold({ "i18n/locales/l0/common.json": `${JSON.stringify({ greeting: "hei" })}\n` });
    assert.deepStrictEqual(stale(), ["i18n"], "3 of the 4 still match, and that is not the set");
  });

  it("review prints the tree as the route — one line, not one per file", async () => {
    await scaffold(locales(4, "moi"));
    const r = await capture(() => review({ root: tmp }));
    const routes = r.out.match(/codument ack \S+ --reason/g) ?? [];
    assert.deepStrictEqual(
      routes,
      ['codument ack "i18n/locales/**/*.json" --reason'],
      "one tree route, and no per-file route beside it",
    );
    assert.match(r.out, /tree-grain, 4 files/, "and it says how wide the vouch would be");
  });

  it("the audit card names the tree once, with what it covered", async () => {
    await scaffold(locales(4, "moi"));
    await capture(() => ackCommand(TREE, { reason: "wording pass", root: tmp }));
    const card = buildReview(tmp).coveringAcks;
    assert.equal(card.length, 1, "one row for one judgment, not four");
    assert.equal(card[0].grain, "tree");
    assert.equal(card[0].anchorId, TREE);
    assert.equal(card[0].covers, 4);
  });

  it("`ack --list` states the width, and the record decays with the tree", async () => {
    await scaffold(locales(4, "moi"));
    await capture(() => ackCommand(TREE, { reason: "wording pass", root: tmp }));
    const listed = await capture(() => ackCommand(undefined, { list: true, root: tmp }));
    assert.match(listed.out, /i18n\/locales\/\*\*\/\*\.json \(tree, 4 files\)/);
    assert.doesNotMatch(listed.out, /auto-invalidated/);

    await scaffold({ "i18n/locales/l1/common.json": `${JSON.stringify({ greeting: "terve" })}\n` });
    const after = await capture(() => ackCommand(undefined, { list: true, root: tmp }));
    assert.match(after.out, /auto-invalidated/, "one member moving invalidates the whole record");
  });
});

// The three grains partition the anchor-id space: symbol, file, tree. They are told
// apart by SHAPE alone and every consumer branches on these predicates, so an overlap
// is not a tidiness point — whichever branch happened to run first would decide what a
// record means.
describe("ack grains are mutually exclusive (plan 43)", () => {
  const ids = {
    symbol: { anchorId: "src/a.ts::foo().", covered: undefined },
    file: { anchorId: "src/a.ts", covered: undefined },
    tree: {
      anchorId: "i18n/locales/**/*.json",
      covered: [{ path: "i18n/locales/en.json", from: "a", to: "b" }],
    },
    dir: {
      anchorId: "i18n/locales/",
      covered: [{ path: "i18n/locales/en.json", from: "a", to: "b" }],
    },
  };
  const ack = (k: keyof typeof ids) => ({
    fromHash: "a",
    toHash: "b",
    reason: "r",
    signer: "s",
    ...ids[k],
  });

  it("a pattern is a tree and never a file; a path is a file and never a tree", () => {
    assert.equal(isTreeGrainAck(ack("tree")), true);
    assert.equal(isFileGrainAck(ack("tree")), false);
    assert.equal(isTreeGrainAck(ack("dir")), true, "a trailing-slash directory is a tree");
    assert.equal(isFileGrainAck(ack("file")), true);
    assert.equal(isTreeGrainAck(ack("file")), false);
    assert.equal(isFileGrainAck(ack("symbol")), false);
    assert.equal(isTreeGrainAck(ack("symbol")), false);
  });

  it("a tree ack without its set is malformed, and a set on a file ack is too", () => {
    assert.equal(parseAck({ ...ack("tree"), covered: undefined }), null);
    assert.equal(parseAck({ ...ack("tree"), covered: [] }), null);
    assert.equal(parseAck({ ...ack("file"), covered: ids.tree.covered }), null);
    assert.equal(parseAck({ ...ack("tree"), covered: [{ path: "x" }] }), null);
    assert.notEqual(parseAck(ack("tree")), null);
    assert.notEqual(parseAck(ack("file")), null);
  });

  it("a symbol whose descriptor carries a glob character is still a symbol ack", () => {
    // `export * from "./x"` anchors to a descriptor with a `*` in it. Reading the id
    // as a glob would condemn a recorded judgment as malformed and drop it silently.
    const star = { ...ack("symbol"), anchorId: "src/index.ts::*." };
    assert.equal(isTreeGrainAck(star), false);
    assert.equal(isFileGrainAck(star), false);
    assert.notEqual(parseAck(star), null, "and it survives a read");
  });
});
