import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordToEvents,
  featureForFile,
  resolveSessionLog,
  pumpFeed,
  normalizeModelId,
  type FeedContext,
} from "../src/lib/claude-feed.js";
import { costOf } from "../src/lib/token-cost.js";
import { readRecentEvents } from "../src/lib/events.js";
import type { Registry } from "../src/lib/registry.js";

const REGISTRY: Registry = {
  features: {
    auth: {
      doc: "docs/features/auth.md",
      type: "feature",
      primary_sources: ["src/auth/login.ts"],
      related_sources: ["src/shared/util.ts"],
      docs: [],
      depends_on: [],
      risk: [],
      last_updated: "2026-06-16",
      status: "current",
    },
    billing: {
      doc: "docs/features/billing.md",
      type: "feature",
      primary_sources: ["src/shared/util.ts", "src/billing/charge.ts"],
      related_sources: [],
      docs: [],
      depends_on: [],
      risk: [],
      last_updated: "2026-06-16",
      status: "current",
    },
  },
};

const ROOT = "/repo";
const ctx = (prevFeature: string | null = null): FeedContext => ({
  root: ROOT,
  registry: REGISTRY,
  prevFeature,
});

const TS = "2026-06-16T10:00:00.000Z";
const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  name,
  input,
});
const assistant = (
  usage: Record<string, unknown> | undefined,
  content: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  type: "assistant",
  timestamp: TS,
  uuid: "u1",
  sessionId: "s1",
  message: { role: "assistant", model: "claude-opus-4-8", usage, content },
  ...extra,
});

describe("normalizeModelId", () => {
  it("canonicalizes Claude transcript ids to rate-table keys (and prices them)", () => {
    assert.equal(normalizeModelId("claude-opus-4-8"), "opus-4.8");
    assert.equal(normalizeModelId("claude-sonnet-4-6"), "sonnet-4.6");
    assert.equal(normalizeModelId("claude-haiku-4-5"), "haiku-4.5");
    // trailing date suffix is stripped
    assert.equal(normalizeModelId("claude-opus-4-8-20260101"), "opus-4.8");
    // the canonical id now matches the rate table → priced, not unpriced
    assert.equal(costOf({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 }, normalizeModelId("claude-opus-4-8")).unpriced, false);
  });
  it("strips a context-variant suffix like [1m] so the 1M model still prices", () => {
    assert.equal(normalizeModelId("claude-opus-4-8[1m]"), "opus-4.8");
    assert.equal(normalizeModelId("claude-sonnet-4-6[1m]"), "sonnet-4.6");
    assert.equal(
      costOf({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 }, normalizeModelId("claude-opus-4-8[1m]")).unpriced,
      false,
    );
  });
  it("canonicalizes single-segment families (Fable/Mythos) and prices them", () => {
    assert.equal(normalizeModelId("claude-fable-5"), "fable-5");
    assert.equal(normalizeModelId("claude-mythos-5"), "mythos-5");
    assert.equal(normalizeModelId("claude-fable-5-20260101"), "fable-5");
    assert.equal(
      costOf({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreate: 0 }, normalizeModelId("claude-fable-5")).unpriced,
      false,
    );
  });
  it("leaves unrecognized ids untouched (exact-match/typo-safety preserved)", () => {
    assert.equal(normalizeModelId("opus-4.8"), "opus-4.8"); // already canonical
    assert.equal(normalizeModelId("gpt-9-ultra"), "gpt-9-ultra");
    assert.equal(normalizeModelId("claude-opus-typo"), "claude-opus-typo");
  });
});

describe("featureForFile", () => {
  it("prefers a primary owner over a related one, deterministically", () => {
    // src/shared/util.ts is primary in billing but related in auth → billing.
    assert.equal(featureForFile("src/shared/util.ts", REGISTRY), "billing");
    assert.equal(featureForFile("src/auth/login.ts", REGISTRY), "auth");
  });
  it("returns null for an unmapped file", () => {
    assert.equal(featureForFile("src/nope.ts", REGISTRY), null);
  });
});

describe("recordToEvents", () => {
  it("emits a token event with mapped usage + attributed feature", () => {
    const { events, feature } = recordToEvents(
      assistant(
        {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 300,
        },
        [toolUse("Edit", { file_path: "/repo/src/auth/login.ts" })],
      ),
      ctx(),
    );
    const tok = events.find((e) => e.type === "tokens");
    assert.ok(tok, "a tokens event is emitted");
    assert.deepEqual(tok!.data, {
      model: "opus-4.8", // canonicalized from the transcript's claude-opus-4-8
      input: 100,
      output: 20,
      cacheRead: 5000,
      cacheCreate: 300,
      feature: "auth",
      session: "s1",
      uuid: "u1",
    });
    assert.equal(feature, "auth");
    const edit = events.find((e) => e.type === "edit");
    assert.ok(edit, "an edit activity event is emitted");
    assert.equal(edit!.message, "auth → login.ts");
  });

  it("attributes a thinking/reading-only turn to the carried-forward feature", () => {
    const { events, feature } = recordToEvents(
      assistant({ input_tokens: 8000, output_tokens: 400, cache_read_input_tokens: 9000 }, []),
      ctx("billing"),
    );
    assert.equal(feature, "billing");
    const tok = events.find((e) => e.type === "tokens");
    assert.equal((tok!.data as Record<string, unknown>).feature, "billing");
    assert.ok(!events.some((e) => e.type !== "tokens"), "no activity events for a pure-reasoning turn");
  });

  it("lets an edit win attribution over a read in the same turn", () => {
    const { feature } = recordToEvents(
      assistant({ input_tokens: 1, output_tokens: 1 }, [
        toolUse("Read", { file_path: "/repo/src/billing/charge.ts" }),
        toolUse("Edit", { file_path: "/repo/src/auth/login.ts" }),
      ]),
      ctx(),
    );
    assert.equal(feature, "auth");
  });

  it("emits read/bash activity and skips UI-noise tools", () => {
    const { events } = recordToEvents(
      assistant({ input_tokens: 1, output_tokens: 1 }, [
        toolUse("Read", { file_path: "/repo/src/billing/charge.ts" }),
        toolUse("Bash", { command: "npm test", description: "run the suite" }),
        toolUse("TodoWrite", { todos: [] }),
        toolUse("AskUserQuestion", { questions: [] }),
      ]),
      ctx(),
    );
    const kinds = events.map((e) => e.type).sort();
    assert.deepEqual(kinds, ["bash", "read", "tokens"]);
    assert.equal(events.find((e) => e.type === "bash")!.message, "run the suite");
    assert.equal(events.find((e) => e.type === "read")!.message, "billing → charge.ts");
  });

  it("ignores non-assistant records and preserves the carried feature", () => {
    const { events, feature } = recordToEvents(
      { type: "user", message: { content: "hi" } },
      ctx("auth"),
    );
    assert.deepEqual(events, []);
    assert.equal(feature, "auth");
  });

  it("never throws on malformed records", () => {
    for (const bad of [null, {}, { type: "assistant" }, { type: "assistant", message: 5 }, { type: "assistant", message: {}, timestamp: TS }]) {
      assert.doesNotThrow(() => recordToEvents(bad, ctx()));
    }
  });
});

describe("resolveSessionLog", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "codument-home-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("finds the session whose cwd matches the project root", async () => {
    const dir = join(home, ".claude", "projects", "-repo-a");
    await mkdir(dir, { recursive: true });
    const log = join(dir, "sess.jsonl");
    await writeFile(log, JSON.stringify({ type: "assistant", cwd: "/repo/a" }) + "\n");
    assert.equal(resolveSessionLog("/repo/a", home), log);
    assert.equal(resolveSessionLog("/repo/zzz", home), null);
  });

  it("returns null when there is no projects dir", () => {
    assert.equal(resolveSessionLog("/repo/a", join(home, "nope")), null);
  });
});

describe("pumpFeed (idempotent tailer)", () => {
  let root: string;
  let home: string;
  let log: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-proj-"));
    home = await mkdtemp(join(tmpdir(), "codument-home-"));
    const dir = join(home, ".claude", "projects", "proj");
    await mkdir(dir, { recursive: true });
    log = join(dir, "sess.jsonl");
    const rec = (uuid: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: TS,
        uuid,
        sessionId: "s1",
        cwd: root,
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [],
        },
      });
    await writeFile(log, rec("a") + "\n" + rec("b") + "\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("emits once, resumes without double-emitting, and picks up appended lines", async () => {
    const first = pumpFeed(root, home);
    assert.equal(first.session, log);
    assert.equal(first.emitted, 2);
    assert.equal(readRecentEvents(root, 50).length, 2);

    // No new lines → nothing re-emitted (offset persisted).
    assert.equal(pumpFeed(root, home).emitted, 0);
    assert.equal(readRecentEvents(root, 50).length, 2);

    // Append a new turn → only that one is emitted.
    await appendFile(
      log,
      JSON.stringify({
        type: "assistant",
        timestamp: TS,
        uuid: "c",
        cwd: root,
        message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
      }) + "\n",
    );
    assert.equal(pumpFeed(root, home).emitted, 1);
    assert.equal(readRecentEvents(root, 50).length, 3);
  });

  it("does not consume a half-written trailing line", async () => {
    const rec = (uuid: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: TS,
        uuid,
        cwd: root,
        message: { role: "assistant", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
      });
    const complete = rec("x");
    const next = rec("y");
    const half = next.slice(0, 25); // partial, no trailing newline
    const rest = next.slice(25);
    await writeFile(log, complete + "\n" + half);

    pumpFeed(root, home);
    assert.equal(readRecentEvents(root, 50).length, 1); // only the complete line

    await appendFile(log, rest + "\n"); // finish the second line
    pumpFeed(root, home);
    assert.equal(readRecentEvents(root, 50).length, 2);
  });
});
