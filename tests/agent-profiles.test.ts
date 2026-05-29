import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectAgentIds,
  parseAgentIds,
  resolveAgentIds,
  AGENT_PROFILES,
  DELIVERY_SKILLS,
} from "../src/lib/agent-profiles.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("agent profiles", () => {
  it("parses comma-separated agent ids", () => {
    assert.deepStrictEqual(parseAgentIds("codex,claude"), ["codex", "claude"]);
  });

  it("deduplicates parsed agent ids", () => {
    assert.deepStrictEqual(parseAgentIds(["codex", "codex,claude"]), [
      "codex",
      "claude",
    ]);
  });

  it("rejects unknown agent ids", () => {
    assert.throws(() => parseAgentIds("cursor"), /Unknown agent profile/);
  });

  it("detects existing agent files", async () => {
    await writeFile(join(tmp, "AGENTS.md"), "# Agents\n");
    await mkdir(join(tmp, ".claude"), { recursive: true });

    assert.deepStrictEqual(detectAgentIds(tmp), ["codex", "claude"]);
  });

  it("defaults to codex when no agent files exist", () => {
    assert.deepStrictEqual(resolveAgentIds(tmp), ["codex"]);
  });

  it("defines concrete output locations per profile", () => {
    assert.equal(AGENT_PROFILES.codex.skillsDir, ".agents/skills");
    assert.equal(AGENT_PROFILES.claude.skillsDir, ".claude/skills");
    assert.equal(AGENT_PROFILES.claude.capabilities.hooks, true);
    assert.equal(AGENT_PROFILES.codex.capabilities.hooks, false);
  });

  it("includes the core delivery skills", () => {
    assert.deepStrictEqual([...DELIVERY_SKILLS], [
      "grill-with-docs",
      "plan-with-docs",
      "tdd",
      "work-step",
      "review-work",
      "commit-work",
      "update-docs",
    ]);
  });
});
