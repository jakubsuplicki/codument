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

  it("rejects acking an ADDED symbol (it needs doc attention, not an ack)", async () => {
    await scaffold({ "src/a.ts": A_SRC + "export function bar() {\n  return 2;\n}\n" });
    const r = capture(() => ackCommand("src/a.ts::bar", { reason: "x", root: tmp }));
    assert.equal(r.code, 1);
    assert.match(r.err, /was added, not changed/);
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
