import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeEach, afterEach } from "node:test";
import { ackCommand } from "../src/commands/ack.js";
import { buildReview } from "../src/commands/review.js";
import { readAcks, ackFileName } from "../src/lib/acknowledgment.js";
import { getGitAuthor } from "../src/lib/git.js";
import { readAllEvents } from "../src/lib/events.js";

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

function capture(fn: () => void): { out: string; err: string; code: number | undefined } {
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
    fn();
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

describe("codument ack — the reachable agent-judge surface", () => {
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
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs.map((d) => d.feature), ["alpha"]);

    const r = capture(() =>
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
    const r = capture(() =>
      ackCommand("src/a.ts::foo().", { reason: "refactor: contract unchanged", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.equal(readAcks(tmp)[0]?.anchorId, "src/a.ts::foo().");
  });

  it("records an identity-bearing self-ack audit event (not just a count)", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    capture(() => ackCommand("src/a.ts::foo", { reason: "same outputs", root: tmp }));

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
    capture(() =>
      ackCommand("src/a.ts::foo", { reason: "reviewed", signer: "reviewer@x.com", root: tmp }),
    );
    const ack = readAllEvents(tmp).find((e) => e.type === "ack");
    assert.equal((ack!.data as Record<string, unknown>).kind, "independent");
  });

  it("fails loud when there is nothing moved to ack", async () => {
    const r = capture(() => ackCommand("src/a.ts::foo", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /nothing to ack/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("review's guidance for ADDED/REMOVED symbols names the file-grain command — and pasting it works", async () => {
    // foo removed + bar added: two additive-kind findings, zero moved symbols.
    await scaffold({ "src/a.ts": "export function bar() {\n  return 2;\n}\n" });

    const out = stripAnsi(
      execFileSync("node", [CLI, "review"], { cwd: tmp, encoding: "utf-8" }),
    );
    assert.match(out, /additive only/, "kind-aware guidance branch");
    assert.match(out, /codument ack src\/a\.ts --reason/, "suggests the FILE-grain form");
    assert.doesNotMatch(
      out,
      /codument ack src\/a\.ts::/,
      "never suggests a per-symbol ack that ack would reject",
    );

    // Paste the suggested command: it must actually succeed and clear the verdict.
    const r = capture(() =>
      ackCommand("src/a.ts", { reason: "helper swap; narration unchanged", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, []);
  });

  it("rejects acking an ADDED symbol (it needs doc attention, not an ack)", async () => {
    await scaffold({ "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\n" });
    const r = capture(() => ackCommand("src/a.ts::bar", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /was added, not changed/);
    // the rejection is a signpost: it names the file-grain alternative
    assert.match(r.err, /codument ack src\/a\.ts --reason/);
  });

  it("requires a reason", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    const r = capture(() => ackCommand("src/a.ts::foo", { root: tmp }));
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
    const r = capture(() => ackCommand("src/x.ts::thing", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /ambiguous/);
    assert.match(r.err, /src\/x\.ts::thing/); // lists the candidate descriptors
    assert.equal(readAcks(tmp).length, 0);
  });

  it("--list shows recorded acks; --remove retracts (audited) and the flag returns", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    capture(() => ackCommand("src/a.ts::foo", { reason: "refactor only", root: tmp }));

    const listed = capture(() => ackCommand(undefined, { list: true, root: tmp }));
    assert.match(listed.out, /Acknowledgments \(1\)/);
    assert.match(listed.out, /refactor only/);

    const handle = ackFileName(readAcks(tmp)[0]).replace(/\.json$/, "");
    const removed = capture(() => ackCommand(undefined, { remove: handle, root: tmp }));
    assert.equal(removed.code, undefined, removed.err);
    assert.equal(readAcks(tmp).length, 0);
    // the retraction is itself audited, and the verdict returns
    assert.ok(readAllEvents(tmp).some((e) => e.type === "ack-remove"));
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs.map((d) => d.feature), ["alpha"]);
  });

  it("the ack auto-invalidates when the symbol moves again (through the CLI)", async () => {
    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 2;") });
    capture(() => ackCommand("src/a.ts::foo", { reason: "refactor", root: tmp }));
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, [], "covered while the fingerprint matches");

    await scaffold({ "src/a.ts": A_SRC.replace("return 1;", "return 999;") });
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["alpha"],
      "a second move invalidates the recorded ack",
    );
  });
});

describe("ack loop end-to-end through the real CLI (the headline ergonomics)", () => {
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
    const m = review1.match(/codument ack (\S+) --reason/);
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
  buildReview(root).state.staleDocs.map((d) => d.feature).sort();

describe("codument ack <path> — the file-grain surface", () => {
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

    const r = capture(() =>
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

    const r = capture(() =>
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
      "src/a.ts": A_SRC.replace("return 1;", "return 2;") + "export function bar() {\n  return 9;\n}\n",
    });
    assert.deepStrictEqual(staleFeatures(tmp), ["alpha"]);

    // File ack: records, but names the still-flagged moved owned symbol.
    const r = capture(() => ackCommand("src/a.ts", { reason: "additive helper only", root: tmp }));
    assert.equal(r.code, undefined, r.err);
    assert.match(r.out, /1 moved symbol\(s\) here are NOT cleared/);
    assert.match(r.out, /src\/a\.ts::foo/);
    assert.deepStrictEqual(staleFeatures(tmp), ["alpha"], "the moved foo() keeps alpha flagged");

    // Resolve the move with a symbol ack — now the file ack's additive residue clears.
    const r2 = capture(() =>
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
    const r = capture(() => ackCommand("src/a.ts", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /does not parse/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("refuses when there is no content change (nothing to ack)", () => {
    const r = capture(() => ackCommand("src/a.ts", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /unchanged.*nothing to ack/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("refuses an added (untracked) file — it needs doc attention, not a file ack", async () => {
    await scaffold({ "src/new.ts": "export const z = 1;\n" });
    const r = capture(() => ackCommand("src/new.ts", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /was added, not changed/);
  });

  it("refuses a DELETED file — no acknowledgment clears a deletion (a removal owes doc attention)", async () => {
    await rm(join(tmp, "src", "a.ts"));
    const r = capture(() => ackCommand("src/a.ts", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /was deleted, not changed/);
    assert.equal(readAcks(tmp).length, 0);
  });

  it("still requires a reason for the bare-path form", () => {
    const r = capture(() => ackCommand("src/a.ts", { root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /--reason is required/);
  });

  it("review's resolution summary shows a file-ack AS a file-ack, never laundered as a doc update", async () => {
    await scaffold({ "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\n" });
    execFileSync("node", [CLI, "ack", "src/a.ts", "--reason", "internal helper; no contract added"], {
      cwd: tmp,
      encoding: "utf-8",
    });
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
    const r = capture(() =>
      ackCommand("src/a.ts::foo", { reason: "internal: same return shape", root: tmp }),
    );
    assert.equal(r.code, undefined, r.err);
    assert.deepStrictEqual(
      buildReview(tmp).state.staleDocs.map((d) => d.feature),
      ["lib"],
      "the concept umbrella is NOT cleared by a per-symbol ack",
    );

    // the file-grain judgment is what clears the umbrella's residue
    const rf = capture(() =>
      ackCommand("src/a.ts", { reason: "file narration unchanged: helper-internal edit", root: tmp }),
    );
    assert.equal(rf.code, undefined, rf.err);
    assert.deepStrictEqual(buildReview(tmp).state.staleDocs, []);
  });
});

describe("getGitAuthor", () => {
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
