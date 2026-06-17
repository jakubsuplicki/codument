import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, readRecentEvents } from "../src/lib/events.js";
import { emitTokens, isTokenEvent } from "../src/lib/emit-producer.js";
import { isTokenEvent as isTokenEventCanonical } from "../src/lib/token-report.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-emit-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const logPath = (root: string) => join(root, ".codument", "events.jsonl");
const rawLines = (root: string) =>
  readFileSync(logPath(root), "utf-8").split("\n").filter(Boolean);

describe("emitTokens", () => {
  it("round-trips a token event through the log", () => {
    emitTokens(
      tmp,
      { input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 4000 },
      { model: "opus-4.8", ts: "2026-06-16T10:00:00.000Z" },
    );
    const events = readRecentEvents(tmp);
    assert.equal(events.length, 1);
    const tok = events[0];
    assert.equal(tok.type, "tokens");
    assert.equal(tok.ts, "2026-06-16T10:00:00.000Z");
    assert.equal((tok.data as Record<string, unknown>).model, "opus-4.8");
    assert.deepEqual(
      {
        input: (tok.data as Record<string, unknown>).input,
        output: (tok.data as Record<string, unknown>).output,
        cacheRead: (tok.data as Record<string, unknown>).cacheRead,
        cacheCreate: (tok.data as Record<string, unknown>).cacheCreate,
      },
      { input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 4000 },
    );
    assert.equal(isTokenEvent(tok), true);
  });

  it("bootstraps the .codument directory and writes a single newline-terminated line", () => {
    assert.equal(existsSync(join(tmp, ".codument")), false);
    emitTokens(tmp, { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 }, { model: "opus-4.8" });
    assert.equal(existsSync(logPath(tmp)), true);
    const raw = readFileSync(logPath(tmp), "utf-8");
    assert.ok(raw.endsWith("\n"));
    assert.equal(raw.split("\n").filter(Boolean).length, 1);
    assert.equal(readRecentEvents(tmp).filter(isTokenEvent).length, 1);
  });

  it("omits feature/step keys entirely when not provided", () => {
    emitTokens(tmp, { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 }, { model: "opus-4.8" });
    const line = rawLines(tmp)[0];
    assert.equal(line.includes('"feature"'), false);
    assert.equal(line.includes('"step"'), false);
    const data = readRecentEvents(tmp)[0].data as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(data, "feature"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "step"), false);
    assert.equal(isTokenEvent(readRecentEvents(tmp)[0]), true);
  });

  it("persists feature and step verbatim", () => {
    emitTokens(
      tmp,
      { input: 10, output: 2, cacheRead: 30, cacheCreate: 4 },
      { model: "opus-4.8", feature: "token-tracking", step: "3-emit-producer", ts: "2026-06-16T10:00:00.000Z" },
    );
    const data = readRecentEvents(tmp)[0].data as Record<string, unknown>;
    assert.equal(data.feature, "token-tracking");
    assert.equal(data.step, "3-emit-producer");
    assert.equal(data.model, "opus-4.8");
    assert.equal(readRecentEvents(tmp)[0].ts, "2026-06-16T10:00:00.000Z");
    assert.deepEqual(
      { input: data.input, output: data.output, cacheRead: data.cacheRead, cacheCreate: data.cacheCreate },
      { input: 10, output: 2, cacheRead: 30, cacheCreate: 4 },
    );
  });

  it("appends without clobbering a mixed log", () => {
    appendEvent(tmp, { type: "review", message: "clean", ts: "2026-06-16T10:00:00.000Z" });
    appendEvent(tmp, { type: "step", message: "1 done", ts: "2026-06-16T10:00:01.000Z" });
    emitTokens(tmp, { input: 5, output: 1, cacheRead: 1, cacheCreate: 1 }, { model: "opus-4.8", ts: "2026-06-16T10:00:02.000Z" });
    const events = readRecentEvents(tmp);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.type), ["review", "step", "tokens"]);
    const toks = events.filter(isTokenEvent);
    assert.equal(toks.length, 1);
    assert.equal(toks[0].data.input, 5);
    assert.equal(isTokenEvent(events[0]), false);
    assert.equal(isTokenEvent(events[1]), false);
  });

  it("writes two independent lines for two emits", () => {
    emitTokens(tmp, { input: 100, output: 1, cacheRead: 1, cacheCreate: 1 }, { model: "opus-4.8", feature: "A" });
    emitTokens(tmp, { input: 200, output: 1, cacheRead: 1, cacheCreate: 1 }, { model: "sonnet-4.6", feature: "B" });
    const toks = readRecentEvents(tmp).filter(isTokenEvent);
    assert.equal(toks.length, 2);
    assert.equal(toks[0].data.feature, "A");
    assert.equal(toks[0].data.model, "opus-4.8");
    assert.equal(toks[0].data.input, 100);
    assert.equal(toks[1].data.feature, "B");
    assert.equal(toks[1].data.model, "sonnet-4.6");
    assert.equal(toks[1].data.input, 200);
  });

  it("normalizes non-finite or negative usage so the emitted event is always guard-valid", () => {
    emitTokens(
      tmp,
      { input: -5, output: NaN, cacheRead: Infinity, cacheCreate: 1000 } as never,
      { model: "opus-4.8" },
    );
    const tok = readRecentEvents(tmp)[0];
    assert.equal(isTokenEvent(tok), true);
    assert.deepEqual(
      {
        input: (tok.data as Record<string, unknown>).input,
        output: (tok.data as Record<string, unknown>).output,
        cacheRead: (tok.data as Record<string, unknown>).cacheRead,
        cacheCreate: (tok.data as Record<string, unknown>).cacheCreate,
      },
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 1000 },
    );
  });

  it("preserves zero buckets (no falsy drop)", () => {
    emitTokens(tmp, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, { model: "opus-4.8" });
    const tok = readRecentEvents(tmp)[0];
    assert.equal(isTokenEvent(tok), true);
    const data = tok.data as Record<string, unknown>;
    for (const b of ["input", "output", "cacheRead", "cacheCreate"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(data, b), true);
      assert.equal(data[b], 0);
      assert.equal(typeof data[b], "number");
    }
  });

  it("stores token counts only — never a derived cost", () => {
    emitTokens(
      tmp,
      { input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 4000 },
      { model: "opus-4.8", feature: "f", step: "s" },
    );
    const line = rawLines(tmp)[0];
    assert.equal(line.includes("cost"), false);
    const data = readRecentEvents(tmp)[0].data as Record<string, unknown>;
    for (const forbidden of ["cost", "total", "usd"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(data, forbidden), false);
    }
    const allowed = new Set(["model", "input", "output", "cacheRead", "cacheCreate", "feature", "step"]);
    for (const key of Object.keys(data)) {
      assert.ok(allowed.has(key), `unexpected key ${key}`);
    }
  });

  it("re-exports the canonical isTokenEvent (single source of truth)", () => {
    assert.equal(isTokenEvent, isTokenEventCanonical);
  });

  it("tolerates a messy log: junk and whitespace lines are skipped, valid ones survive", () => {
    mkdirSync(join(tmp, ".codument"), { recursive: true });
    const handwritten = JSON.stringify({
      type: "tokens",
      ts: "2026-06-16T10:00:00.000Z",
      data: { model: "opus-4.8", input: 9, output: 9, cacheRead: 9, cacheCreate: 9 },
    });
    appendFileSync(
      logPath(tmp),
      `{not json}\n${handwritten}\n\n   \n{"type":"review","ts":"2026-06-16T09:00:00.000Z","message":"old"}\n`,
    );
    let toks: ReturnType<typeof readRecentEvents>;
    assert.doesNotThrow(() => {
      emitTokens(tmp, { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 }, { model: "sonnet-4.6", ts: "2026-06-16T11:00:00.000Z" });
      toks = readRecentEvents(tmp).filter(isTokenEvent);
    });
    assert.equal(toks!.length, 2);
    assert.equal(toks![1].data.model, "sonnet-4.6");
    assert.equal(toks![1].data.input, 1);
    const review = readRecentEvents(tmp).find((e) => e.type === "review")!;
    assert.equal(isTokenEvent(review), false);
  });

  it("defaults ts to a real wall-clock ISO stamp when omitted", () => {
    const before = new Date().toISOString();
    emitTokens(tmp, { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 }, { model: "opus-4.8" });
    const after = new Date().toISOString();
    const ts = readRecentEvents(tmp)[0].ts;
    assert.equal(typeof ts, "string");
    assert.ok(ts.length > 0);
    assert.ok(!Number.isNaN(Date.parse(ts)));
    assert.ok(before <= ts && ts <= after);
  });
});

describe("codument emit tokens (CLI)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const CLI = join(here, "..", "dist", "cli.js");

  it("records token usage into the log from the command line", () => {
    execFileSync(
      "node",
      [
        CLI,
        "emit",
        "tokens",
        "--model",
        "opus-4.8",
        "--input",
        "1000",
        "--cache-read",
        "50000",
        "--feature",
        "auth",
        "--step",
        "3",
      ],
      { cwd: tmp, encoding: "utf-8" },
    );
    const toks = readRecentEvents(tmp).filter(isTokenEvent);
    assert.equal(toks.length, 1);
    assert.equal(toks[0].data.model, "opus-4.8");
    assert.equal(toks[0].data.input, 1000);
    assert.equal(toks[0].data.output, 0);
    assert.equal(toks[0].data.cacheRead, 50000);
    assert.equal(toks[0].data.cacheCreate, 0);
    assert.equal(toks[0].data.feature, "auth");
    assert.equal(toks[0].data.step, "3");
  });

  it("omits attribution when flags are not passed", () => {
    execFileSync(
      "node",
      [CLI, "emit", "tokens", "--model", "sonnet-4.6", "--output", "200"],
      { cwd: tmp, encoding: "utf-8" },
    );
    const data = readRecentEvents(tmp).filter(isTokenEvent)[0].data as Record<string, unknown>;
    assert.equal(data.model, "sonnet-4.6");
    assert.equal(data.output, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "feature"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "step"), false);
  });
});
