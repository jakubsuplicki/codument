import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectAgentCapture } from "../src/lib/agent-feed.js";
import { readEventLog } from "../src/lib/events.js";
import { summarizeUsageRuns } from "../src/lib/token-report.js";
import { pumpFeed, resolveSessionLogs } from "../src/lib/claude-feed.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codument-capture-"));
  const root = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", ".registry.json"), '{"features":{}}');
  return { root, home };
}

describe("capture availability", () => {
  it("marks missing assistant payload and negative captured counts as partial", () => {
    const { root, home } = fixture();
    const logs = join(home, ".claude", "projects", "fixture");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "session.jsonl"), JSON.stringify({ type: "assistant", cwd: root }) + "\n");
    let capture = inspectAgentCapture(root, home);
    assert.equal(capture.hosts.find(row => row.host === "claude")!.state, "partial");
    assert.ok(capture.hosts.find(row => row.host === "claude")!.reasons.includes("missing-or-invalid-source-usage"));
    mkdirSync(join(root, ".codument"));
    const event = { type: "tokens", ts: "now", data: {
      model: "unknown", input: -10, output: 0, cacheRead: 0, cacheCreate: 0,
    } };
    writeFileSync(join(root, ".codument", "events.jsonl"), JSON.stringify(event) + "\n");
    capture = inspectAgentCapture(root, home);
    assert.equal(capture.hosts.find(row => row.host === "manual")!.state, "partial");
    const summary = summarizeUsageRuns([event], capture);
    assert.equal(summary.runs.length, 0);
    assert.ok(summary.limitations.some(reason => reason.includes("Invalid token records")));
  });
  it("discloses malformed and uninspected source records even when some identity is readable", () => {
    const { root, home } = fixture();
    const logs = join(home, ".claude", "projects", "fixture");
    mkdirSync(logs, { recursive: true });
    const file = join(logs, "session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user", cwd: root }) + "\n{broken\n");
    let host = inspectAgentCapture(root, home).hosts.find(row => row.host === "claude")!;
    assert.equal(host.state, "partial");
    assert.ok(host.reasons.includes("malformed-session-records"));
    writeFileSync(file, JSON.stringify({ type: "user", cwd: root }) + "\n");
    appendFileSync(file, " ".repeat(1_000_001));
    host = inspectAgentCapture(root, home).hosts.find(row => row.host === "claude")!;
    assert.equal(host.state, "partial");
    assert.ok(host.reasons.includes("inspection-limited"));
  });
  it("distinguishes unavailable, readable empty, captured and unsupported inputs", () => {
    const { root, home } = fixture();
    const host = () => inspectAgentCapture(root, home).hosts.find(row => row.host === "claude")!;
    assert.equal(host().state, "unavailable");
    const logs = join(home, ".claude", "projects", "fixture");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "session.jsonl"), JSON.stringify({ type: "user", cwd: root }) + "\n");
    assert.equal(host().state, "empty");
    assert.equal(host().sessions, 1);
    mkdirSync(join(root, ".codument"));
    writeFileSync(join(root, ".codument", "events.jsonl"), JSON.stringify({
      type: "tokens", ts: "2026-09-10T00:00:00Z", data: {
        source: "feed", model: "unknown-model", input: 1, output: 0, cacheRead: 0, cacheCreate: 0,
      },
    }) + "\n");
    assert.equal(host().state, "available");
    assert.equal(host().capturedEvents, 1);
    assert.equal(inspectAgentCapture(root, home).hosts.find(row => row.host === "codex")!.state, "unavailable");
  });

  it("retains valid ledger events while exposing malformed or unreadable input", () => {
    const { root, home } = fixture();
    mkdirSync(join(root, ".codument"));
    const path = join(root, ".codument", "events.jsonl");
    writeFileSync(path, '{"type":"note","ts":"now"}\n{broken\n');
    const ledger = readEventLog(root);
    assert.equal(ledger.state, "partial");
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.skipped, 1);
    assert.equal(inspectAgentCapture(root, home).ledger.state, "partial");
    const other = fixture();
    mkdirSync(join(other.root, ".codument", "events.jsonl"), { recursive: true });
    assert.equal(readEventLog(other.root).state, "unavailable");
  });

  it("never trusts a project directory name or a nested cwd as repository identity", () => {
    const { root, home } = fixture();
    const logs = join(home, ".claude", "projects", "misleading-project");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "foreign.jsonl"), JSON.stringify({
      type: "assistant", cwd: join(root, "foreign"), timestamp: "2026-09-10T00:00:00Z",
      message: { model: "unknown", usage: { input_tokens: 100 }, content: [{ cwd: root }] },
    }) + "\n");
    writeFileSync(join(logs, "nested.jsonl"), JSON.stringify({
      type: "assistant", timestamp: "2026-09-10T00:00:00Z",
      message: { model: "unknown", usage: { input_tokens: 100 }, content: [{ cwd: root }] },
    }) + "\n");
    assert.equal(inspectAgentCapture(root, home).hosts.find(row => row.host === "claude")!.sessions, 0);
    assert.equal(pumpFeed(root, home).emitted, 0);
    const slug = join(home, ".claude", "projects", "-repo-x");
    mkdirSync(slug);
    writeFileSync(join(slug, "foreign.jsonl"), '{"type":"user","cwd":"/elsewhere"}\n');
    assert.deepEqual(resolveSessionLogs("/repo/x", home), []);
  });
});

describe("portable usage summaries", () => {
  it("discloses unexportable identifiers and counts instead of exporting paths or invalid numbers", () => {
    const { root, home } = fixture();
    const capture = inspectAgentCapture(root, home);
    const summary = summarizeUsageRuns([
      { type: "tokens", ts: "now", data: { model: join(root, "private-model"), input: 3, output: 0, cacheRead: 0, cacheCreate: 0 } },
      { type: "tokens", ts: "now", data: { model: "huge", input: 1e308, output: 0, cacheRead: 0, cacheCreate: 0 } },
    ], capture);
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.runs[0].model, "(unknown)");
    assert.equal(summary.runs[0].id, null);
    assert.ok(!JSON.stringify(summary).includes(root));
    assert.ok(summary.limitations.some(reason => reason.includes("integer")));
    assert.ok(summary.limitations.some(reason => reason.includes("identifier")));
  });
  it("exports only counts, host/model and opaque run identity, with no live-ledger effect", () => {
    const { root, home } = fixture();
    const secret = "PRIVATE_TRANSCRIPT_CONTENT";
    const events = [{ type: "tokens", ts: "2026-09-10T00:00:00Z", message: secret, data: {
      source: "feed", session: secret, cwd: root, feature: secret, model: "unpriced-model",
      input: 10, output: 20, cacheRead: 30, cacheCreate: 40,
    } }];
    const capture = inspectAgentCapture(root, home);
    const summary = summarizeUsageRuns(events, capture);
    assert.equal(summary.kind, "codument-usage-summary");
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.runs[0].host, "claude");
    assert.match(summary.runs[0].id!, /^[a-f0-9]{64}$/);
    assert.deepEqual(summary.runs[0].usage, { input: 10, output: 20, cacheRead: 30, cacheCreate: 40 });
    const text = JSON.stringify(summary);
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(root));
    assert.ok(!text.includes('"cost"'));
    assert.deepEqual(summarizeUsageRuns(events, capture), summary);
    mkdirSync(join(root, ".codument"));
    const path = join(root, ".codument", "events.jsonl");
    writeFileSync(path, text + "\n");
    assert.equal(readEventLog(root).events.length, 0, "a summary is not a token event or import");
    assert.equal(readFileSync(path, "utf8"), text + "\n");
  });

  it("CLI status is read-only and explicit export never overwrites a file or ledger", () => {
    const { root, home } = fixture();
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    const status = JSON.parse(run("feed", "--status", "--json", "--dir", root));
    assert.equal(status.ledger.state, "empty");
    assert.ok(!existsSync(join(root, ".codument")));
    const output = join(root, "usage.json");
    const result = JSON.parse(run("cost", "--json", "--export", output));
    assert.ok(result.capture);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).kind, "codument-usage-summary");
    assert.ok(!existsSync(join(root, ".codument")));
    const original = readFileSync(output, "utf8");
    assert.throws(() => run("cost", "--json", "--export", output));
    assert.equal(readFileSync(output, "utf8"), original);
    const local = join(root, ".codument");
    mkdirSync(local);
    assert.throws(() => run("cost", "--json", "--export", join(local, "events.jsonl")));
    const alias = join(root, "ledger-alias");
    symlinkSync(local, alias, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => run("cost", "--json", "--export", join(alias, "events.jsonl")));
    assert.ok(!existsSync(join(local, "events.jsonl")));
  });
});
