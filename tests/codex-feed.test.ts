import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pumpCodexFeed, inspectCodexCapture, normalizeCodexUsage } from "../src/lib/codex-feed.js";
import { appendEvent, readAllEvents, withEventLock } from "../src/lib/events.js";
import { pumpFeed, backfillFeed, resetFeed } from "../src/lib/claude-feed.js";
import { summarizeTokens } from "../src/lib/token-report.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codument-codex-feed-"));
  const root = join(dir, "repo");
  const home = join(dir, "home");
  const logs = join(home, ".codex", "sessions", "2026", "09", "10");
  mkdirSync(root); mkdirSync(logs, { recursive: true });
  return { root, home, logs, file: join(logs, "rollout.jsonl") };
}
const meta = (cwd: string, id = "session-a", extra = {}) => ({ type: "session_meta", payload: { cwd, id, ...extra } });
const model = { type: "turn_context", payload: { model: "unpriced-codex-model" } };
const usage = (input = 100, cached = 30, output = 20) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output });
const count = (input = 100, cached = 30, output = 20) => ({ timestamp: "2026-09-10T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage(input, cached, output), last_token_usage: usage(input, cached, output) } } });
function write(file: string, records: unknown[]) { writeFileSync(file, records.map(row => JSON.stringify(row)).join("\n") + "\n"); }
const totals = (root: string) => summarizeTokens(readAllEvents(root)).totals.usage;

describe("repository-scoped Codex capture", () => {
  it("requires cache counts and rejects invalid optional subdivisions instead of inferring fresh usage", () => {
    assert.equal(normalizeCodexUsage({ input_tokens: 10, output_tokens: 0 }), null);
    assert.equal(normalizeCodexUsage({ ...usage(), cached_input_tokens: null }), null);
    assert.equal(normalizeCodexUsage({ ...usage(), cache_write_input_tokens: null }), null);
    assert.equal(normalizeCodexUsage({ ...usage(), reasoning_output_tokens: 21 }), null);
    assert.deepEqual(normalizeCodexUsage({ ...usage(), cache_write_input_tokens: 10 }), { input: 60, output: 20, cacheRead: 30, cacheCreate: 10 });
  });
  it("counts cumulative deltas once, with cache and reasoning as subdivisions", () => {
    const { root, home, file } = fixture();
    write(file, [meta(root), model, count(), count(), count(150, 40, 30)]);
    assert.equal(pumpCodexFeed(root, { home }).emitted, 2);
    assert.deepEqual(totals(root), { input: 110, cacheRead: 40, output: 30, cacheCreate: 0 });
    assert.equal(pumpCodexFeed(root, { home }).emitted, 0);
    appendFileSync(file, JSON.stringify(count(180, 50, 40)) + "\n");
    assert.equal(pumpCodexFeed(root, { home }).emitted, 1);
    assert.deepEqual(totals(root), { input: 130, cacheRead: 50, output: 40, cacheCreate: 0 });
    assert.deepEqual(summarizeTokens(readAllEvents(root)).unpriced, ["unpriced-codex-model"]);
    assert.ok(readAllEvents(root).every(event => event.data?.host === "codex" && event.message === undefined));
  });

  it("does not replay copied, truncated, reset or rotated inputs, even after cursor loss", () => {
    const { root, home, file, logs } = fixture();
    const rows = [meta(root), model, count(), count(150, 40, 30)];
    write(file, rows); pumpCodexFeed(root, { home });
    const expected = totals(root);
    write(join(logs, "copy.jsonl"), rows);
    assert.equal(pumpCodexFeed(root, { home }).emitted, 0);
    write(file, rows.slice(0, 3));
    assert.ok(pumpCodexFeed(root, { home }).reasons.includes("source-truncated-or-replaced"));
    write(file, rows);
    assert.equal(pumpCodexFeed(root, { home, reset: true }).emitted, 0);
    writeFileSync(join(root, ".codument", "codex-feed-state.json"), "{broken");
    const bad = pumpCodexFeed(root, { home });
    assert.ok(bad.reasons.includes("invalid-capture-state"));
    assert.deepEqual(totals(root), expected);
    assert.equal(readFileSync(join(root, ".codument", "codex-feed-state.json"), "utf8"), "{broken");
    unlinkSync(join(root, ".codument", "codex-feed-state.json"));
    assert.equal(pumpCodexFeed(root, { home }).emitted, 0);
    assert.deepEqual(totals(root), expected);
  });

  it("requires complete recorded repository and run identity, including explicit JSON files", () => {
    const { root, home, file, logs } = fixture();
    write(file, [meta(join(root, "foreign")), model, count()]);
    write(join(logs, "nested.jsonl"), [{ type: "item.completed", item: { cwd: root } }, count()]);
    assert.equal(pumpCodexFeed(root, { home }).emitted, 0);
    write(file, [meta(root, ""), count()]);
    assert.equal(pumpCodexFeed(root, { home, input: file }).emitted, 0);
    write(file, [{ type: "session_meta", payload: { cwd: root, session_id: "shared-across-threads" } }, count()]);
    assert.equal(pumpCodexFeed(root, { home, input: file }).emitted, 0);
    write(file, [{ type: "thread.started", thread_id: "session-a" }, { type: "turn.started" }, { type: "turn.completed", usage: usage() }]);
    assert.ok(pumpCodexFeed(root, { home, input: file }).reasons.includes("missing-repository-identity"));
    write(file, [meta(root), { type: "thread.started", thread_id: "session-a" }, { type: "turn.started" }, { type: "turn.completed", usage: usage() }]);
    assert.equal(pumpCodexFeed(root, { home, input: file }).emitted, 1);
    assert.deepEqual(totals(root), { input: 70, cacheRead: 30, output: 20, cacheCreate: 0 });
    assert.deepEqual(summarizeTokens(readAllEvents(root)).unpriced, ["(unknown)"]);
  });

  it("does not mix rollout and completed-turn streams for the same run", () => {
    const { root, home, file, logs } = fixture();
    write(file, [meta(root), model, count()]); pumpCodexFeed(root, { home });
    const stream = join(logs, "stream.jsonl");
    write(stream, [meta(root), { type: "thread.started", thread_id: "session-a" }, { type: "turn.started" }, { type: "turn.completed", usage: usage() }]);
    const result = pumpCodexFeed(root, { home, input: stream });
    assert.equal(result.emitted, 0);
    assert.ok(result.reasons.includes("conflicting-usage-stream"));
    assert.deepEqual(totals(root), { input: 70, cacheRead: 30, output: 20, cacheCreate: 0 });
  });

  it("keeps bad counts, missing usage and counter resets visibly partial", () => {
    const { root, home, file } = fixture();
    write(file, [meta(root), model, count(1000, 300, 200), count(1100, 330, 220), count(10, 1, 5), count(1200, 360, 240), count(1300, 1400, 250), { type: "event_msg", payload: { type: "token_count", info: null } }]);
    const result = pumpCodexFeed(root, { home });
    assert.deepEqual(totals(root), { input: 840, cacheRead: 360, output: 240, cacheCreate: 0 });
    for (const reason of ["counter-reset", "invalid-or-missing-usage"]) assert.ok(result.reasons.includes(reason), reason);
    assert.equal(inspectCodexCapture(root, { home }).state, "partial");
  });

  it("refuses inherited cumulative history across copied and newly discovered inputs", () => {
    for (const lineage of [{ parent_thread_id: "parent" }, { forked_from_id: "parent" }, { history_base: { thread_id: "parent", ordinal: 20 } }, { source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }]) {
      const { root, home, file, logs } = fixture();
      const prefix = [meta(root, "child", lineage), meta(root, "child"), model];
      write(file, [...prefix, count(1000, 300, 200)]);
      assert.equal(pumpCodexFeed(root, { home }).emitted, 0);
      appendFileSync(file, JSON.stringify(count(1100, 330, 220)) + "\n");
      write(join(logs, "z-later-copy.jsonl"), [...prefix, count(1000, 300, 200), count(1100, 330, 220), count(1200, 360, 240)]);
      const result = pumpCodexFeed(root, { home });
      assert.equal(result.emitted, 0);
      assert.ok(result.reasons.includes("inherited-history-unavailable"));
      assert.equal(pumpCodexFeed(root, { home, reset: true }).emitted, 0);
      unlinkSync(join(root, ".codument", "codex-feed-state.json"));
      assert.equal(pumpCodexFeed(root, { home }).emitted, 0);
      assert.equal(readAllEvents(root).length, 0);
      assert.equal(inspectCodexCapture(root, { home }).state, "partial");
    }
  });
  it("waits for partial lines and refuses conflicting identity without retaining transcript text", () => {
    const { root, home, file } = fixture();
    write(file, [meta(root), model]);
    const partial = JSON.stringify(count());
    appendFileSync(file, partial.slice(0, 30));
    assert.equal(pumpCodexFeed(root, { home }).emitted, 0);
    appendFileSync(file, partial.slice(30) + "\n");
    assert.equal(pumpCodexFeed(root, { home }).emitted, 1);
    appendFileSync(file, JSON.stringify(meta(join(root, "foreign"))) + "\n" + JSON.stringify(count(200, 50, 40)) + "\n");
    assert.equal(pumpCodexFeed(root, { home }).emitted, 0);
    assert.ok(inspectCodexCapture(root, { home }).reasons.includes("conflicting-session-identity"));
    assert.ok(!readFileSync(join(root, ".codument", "events.jsonl"), "utf8").includes(root));
  });

  it("leaves read-only status empty and refuses a busy writer without touching usage", () => {
    const { root, home, file } = fixture();
    write(file, [meta(root), model, count()]);
    assert.equal(inspectCodexCapture(root, { home }).state, "empty");
    assert.equal(existsSync(join(root, ".codument")), false);
    mkdirSync(join(root, ".codument"));
    writeFileSync(join(root, ".codument", "events.jsonl.lock"), "busy");
    const result = pumpCodexFeed(root, { home });
    assert.equal(result.emitted, 0);
    assert.ok(result.reasons.includes("capture-writer-unavailable"));
    assert.equal(existsSync(join(root, ".codument", "events.jsonl")), false);
    assert.throws(() => withEventLock(root, () => undefined));
  });

  it("reports unsupported versions and malformed usage before ingestion", () => {
    const { root, home, file } = fixture();
    write(file, [{ ...meta(root), version: 99 }]);
    assert.equal(inspectCodexCapture(root, { home }).state, "unsupported");
    write(file, [meta(root), model, { type: "event_msg", payload: { type: "token_count" } }]);
    const status = inspectCodexCapture(root, { home });
    assert.equal(status.state, "partial");
    assert.ok(status.reasons.includes("invalid-or-missing-usage"));
    assert.equal(existsSync(join(root, ".codument")), false);
  });

  it("rejects conflicting replayed JSON prefixes instead of counting a replacement tail", () => {
    const { root, home, file } = fixture();
    const prefix = [meta(root), { type: "thread.started", thread_id: "session-a" }];
    write(file, [...prefix, { type: "turn.started" }, { type: "turn.completed", usage: usage() }]);
    pumpCodexFeed(root, { home, input: file });
    write(file, [...prefix, { type: "turn.started" }, { type: "turn.completed", usage: usage(200, 60, 40) }, { type: "turn.started" }, { type: "turn.completed", usage: usage() }]);
    const result = pumpCodexFeed(root, { home, input: file, reset: true });
    assert.equal(result.emitted, 0);
    assert.ok(result.reasons.includes("conflicting-usage-stream"));
    assert.deepEqual(totals(root), { input: 70, cacheRead: 30, output: 20, cacheCreate: 0 });
  });

  it("selects a legitimate worktree's recorded root without importing its parent repository", () => {
    const { root, home, file, logs } = fixture();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
    git("init");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    const worktree = join(root, "..", "worktree");
    git("worktree", "add", "-b", "fixture-worktree", worktree);
    write(file, [meta(root), model, count()]);
    write(join(logs, "worktree.jsonl"), [meta(worktree, "worktree-session"), model, count(50, 10, 10)]);
    assert.equal(pumpCodexFeed(worktree, { home }).sessions, 1);
    assert.deepEqual(totals(worktree), { input: 40, cacheRead: 10, output: 10, cacheCreate: 0 });
    assert.equal(existsSync(join(root, ".codument")), false);
  });

  it("preserves Claude history from truncated input and refuses rebuilding a malformed ledger", () => {
    const { root, home } = fixture();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", ".registry.json"), '{"features":{}}');
    const logs = join(home, ".claude", "projects", "fixture");
    mkdirSync(logs, { recursive: true });
    const file = join(logs, "session.jsonl");
    const turn = (id: string) => ({ type: "assistant", cwd: root, sessionId: "s", uuid: id, timestamp: "2026-09-10T00:00:00Z", message: { model: "unknown", usage: { input_tokens: 10, output_tokens: 0 } } });
    write(file, [turn("a"), turn("b")]); pumpFeed(root, home);
    write(file, [turn("a")]); backfillFeed(root, home); resetFeed(root, home);
    resetFeed(root, home);
    assert.equal(totals(root).input, 20);
    const ledger = join(root, ".codument", "events.jsonl");
    appendFileSync(ledger, "{broken\n");
    const before = readFileSync(ledger, "utf8");
    assert.throws(() => resetFeed(root, home), /ledger is incomplete/);
    assert.equal(readFileSync(ledger, "utf8"), before);
  });

  it("preserves a valid final ledger record without a newline when capture appends", () => {
    const { root, home, file } = fixture();
    write(file, [meta(root), model, count()]);
    mkdirSync(join(root, ".codument"));
    writeFileSync(join(root, ".codument", "events.jsonl"), JSON.stringify({ type: "tokens", ts: "2026-09-10T00:00:00Z", data: { model: "manual", input: 4, output: 0, cacheRead: 0, cacheCreate: 0 } }));
    assert.equal(pumpCodexFeed(root, { home }).emitted, 1);
    assert.equal(readAllEvents(root).length, 2);
    assert.deepEqual(totals(root), { input: 74, cacheRead: 30, output: 20, cacheCreate: 0 });
  });

  it("captures concurrent CLI pumps once and preserves manual and Codex events through Claude reset", async () => {
    const { root, home, file } = fixture();
    write(file, [meta(root), model, count()]);
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex") };
    const run = promisify(execFile);
    const results = await Promise.all([0, 1, 2].map(() => run(process.execPath, [cli, "feed", "--input", file, "--dir", root, "--json"], { env, encoding: "utf8" })));
    assert.equal(results.reduce((sum, result) => sum + JSON.parse(result.stdout).emitted, 0), 1);
    assert.deepEqual(totals(root), { input: 70, cacheRead: 30, output: 20, cacheCreate: 0 });
    const claudeLogs = join(home, ".claude", "projects", "fixture");
    mkdirSync(claudeLogs, { recursive: true });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", ".registry.json"), '{"features":{}}');
    const claudeFile = join(claudeLogs, "session.jsonl");
    const turn = { type: "assistant", cwd: root, sessionId: "session-a", uuid: "shared-uuid", timestamp: "2026-09-10T00:00:00Z", message: { model: "unknown", usage: { input_tokens: 10, output_tokens: 0 } } };
    write(claudeFile, [turn, turn]);
    assert.equal(pumpFeed(root, home).emitted, 1);
    assert.equal(backfillFeed(root, home).added, 0);
    write(claudeFile, [turn]);
    assert.equal(pumpFeed(root, home).emitted, 0);
    appendEvent(root, { type: "note", message: "keep manual" });
    const before = totals(root);
    resetFeed(root, home); resetFeed(root, home);
    assert.deepEqual(totals(root), before);
    assert.equal(readAllEvents(root).filter(event => event.type === "note").length, 1);
    assert.equal(readAllEvents(root).filter(event => event.data?.host === "codex").length, 1);
    const rendered = execFileSync(process.execPath, [cli, "feed", "--status", "--json", "--dir", root], { env, encoding: "utf8" });
    assert.equal(JSON.parse(rendered).hosts.find((host: { host: string }) => host.host === "codex").capturedEvents, 1);
  });
});
