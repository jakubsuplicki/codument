import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseWorkflowCommandTiming, readAllEvents, WORKFLOW_TIMING_COMMANDS } from "../src/lib/events.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
let root: string;
const put = (path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
const observed = () => readAllEvents(root).filter((event) => event.type === "workflow-command");
const result = (execution: ReturnType<typeof cli>) => ({ status: execution.status, stdout: execution.stdout, stderr: execution.stderr });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "codument-workflow-timing-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow command timing schema", () => {
  const data = { version: 1, command: "verify", durationMs: 1.5, exitCode: 0 };
  it("accepts only normalized workflow action names and exact safe facts", () => {
    for (const command of WORKFLOW_TIMING_COMMANDS)
      assert.deepEqual(parseWorkflowCommandTiming({ type: "workflow-command", data: { ...data, command } }), { ...data, command });
    for (const event of [
      null, {}, { type: "other", data }, { type: "workflow-command", data: [] },
      ...["watch", "feed", "cost", "benchmark", "work", "map", "verify --root private"].map((command) => ({ type: "workflow-command", data: { ...data, command } })),
      ...[-1, NaN, Infinity, "1"].map((durationMs) => ({ type: "workflow-command", data: { ...data, durationMs } })),
      ...[-1, 0.5, Infinity, "1"].map((exitCode) => ({ type: "workflow-command", data: { ...data, exitCode } })),
      { type: "workflow-command", data: { ...data, version: 2 } },
      { type: "workflow-command", data: { ...data, args: ["private source"] } },
    ]) assert.equal(parseWorkflowCommandTiming(event), null);
  });
});

describe("opt-in CLI action observation", () => {
  it("leaves normal output unchanged and supports the global flag before and after nested commands", () => {
    const baseline = cli("work", "status", "--json");
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.deepEqual(observed(), []);
    assert.deepEqual(result(cli("--observe-timing", "work", "status", "--json")), result(baseline));
    assert.deepEqual(result(cli("work", "status", "--json", "--observe-timing")), result(baseline));
    const timings = observed().map(parseWorkflowCommandTiming);
    assert.equal(timings.length, 2);
    for (const timing of timings) {
      assert.equal(timing?.command, "work status");
      assert.equal(timing?.exitCode, 0);
      assert.ok(timing && timing.durationMs >= 0);
      assert.deepEqual(Object.keys(timing!).sort(), ["command", "durationMs", "exitCode", "version"]);
    }
  });

  it("captures nonzero command results and caught action failures without changing their diagnostics", () => {
    const refused = cli("steps", "--json");
    assert.equal(refused.status, 1);
    assert.deepEqual(result(cli("steps", "--json", "--observe-timing")), result(refused));
    put("docs/.registry.json", "{ broken registry");
    const caught = cli("context", "--file", "private-source.ts", "--owner");
    assert.equal(caught.status, 1);
    assert.deepEqual(result(cli("--observe-timing", "context", "--file", "private-source.ts", "--owner")), result(caught));
    assert.deepEqual(observed().map((event) => [parseWorkflowCommandTiming(event)?.command, parseWorkflowCommandTiming(event)?.exitCode]), [["steps", 1], ["context", 1]]);
    assert.doesNotMatch(readFileSync(join(root, ".codument/events.jsonl"), "utf8"), /private-source|broken registry|--file/);
  });

  it("does not observe long-running or accounting commands and parser-only help", () => {
    assert.equal(cli("--observe-timing", "cost", "--json").status, 0);
    assert.equal(cli("--observe-timing", "watch", "--help").status, 0);
    assert.equal(cli("--observe-timing", "feed", "--help").status, 0);
    assert.equal(cli("--observe-timing", "benchmark", "--help").status, 0);
    assert.equal(cli("--observe-timing", "verify", "--help").status, 0);
    assert.deepEqual(observed(), []);
  });

  it("ignores a busy or unusable local ledger on both green and red actions", () => {
    const green = cli("work", "status", "--json");
    const red = cli("steps", "--json");
    put(".codument/events.jsonl.lock", "other writer");
    assert.deepEqual(result(cli("--observe-timing", "work", "status", "--json")), result(green));
    assert.deepEqual(result(cli("--observe-timing", "steps", "--json")), result(red));
    assert.equal(readFileSync(join(root, ".codument/events.jsonl.lock"), "utf8"), "other writer");
    assert.deepEqual(observed(), []);
    rmSync(join(root, ".codument/events.jsonl.lock"));
    mkdirSync(join(root, ".codument/events.jsonl"));
    assert.deepEqual(result(cli("work", "status", "--json", "--observe-timing")), result(green));
    assert.deepEqual(result(cli("steps", "--json", "--observe-timing")), result(red));
  });
});
