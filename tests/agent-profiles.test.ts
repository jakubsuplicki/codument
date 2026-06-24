import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  detectAgentIds,
  parseAgentIds,
  resolveAgentIds,
  AGENT_PROFILES,
  DELIVERY_SKILLS,
  DOMAIN_SKILLS,
  ALL_SKILLS,
  resolveSkills,
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

  it("defaults to claude when no agent files exist", () => {
    assert.deepStrictEqual(resolveAgentIds(tmp), ["claude"]);
  });

  it("defines concrete output locations per profile", () => {
    assert.equal(AGENT_PROFILES.codex.skillsDir, ".agents/skills");
    assert.equal(AGENT_PROFILES.claude.skillsDir, ".claude/skills");
    assert.equal(AGENT_PROFILES.claude.capabilities.hooks, true);
    assert.equal(AGENT_PROFILES.codex.capabilities.hooks, false);
  });

  it("includes the core delivery skills", () => {
    assert.deepStrictEqual([...DELIVERY_SKILLS], [
      "establish-charter",
      "grill-with-docs",
      "plan-with-docs",
      "tdd",
      "work-step",
      "review-work",
      "commit-work",
      "update-docs",
    ]);
  });

  it("leads the delivery skills with the charter gate", () => {
    assert.equal(DELIVERY_SKILLS[0], "establish-charter");
  });

  it("clarifies when to grill versus plan", async () => {
    const grillSkill = await readFile(
      join(process.cwd(), "skills", "grill-with-docs", "SKILL.md"),
      "utf-8",
    );
    const planSkill = await readFile(
      join(process.cwd(), "skills", "plan-with-docs", "SKILL.md"),
      "utf-8",
    );

    assert.match(grillSkill, /Boundary With Plan With Docs/);
    assert.match(
      grillSkill,
      /Do not write a delivery plan while the key boundary is still unsettled/,
    );
    assert.match(planSkill, /Boundary With Grill With Docs/);
    assert.match(
      planSkill,
      /Do not use `plan-with-docs` yet if any meaningful decision is still open/,
    );
  });

  it("ships the seven domain skills", () => {
    assert.deepStrictEqual([...DOMAIN_SKILLS], [
      "senior-backend",
      "senior-architect",
      "senior-frontend",
      "frontend-design",
      "motion-craft",
      "code-reviewer",
      "review-codebase",
    ]);
  });

  it("resolves delivery + domain skills with no duplicates", () => {
    const resolved = resolveSkills();
    assert.deepStrictEqual([...resolved], [...ALL_SKILLS]);
    assert.equal(resolved.length, DELIVERY_SKILLS.length + DOMAIN_SKILLS.length);
    assert.equal(new Set(resolved).size, resolved.length);
  });

  it("every resolved skill has a source SKILL.md; Bucket-B skills carry references", () => {
    for (const name of resolveSkills()) {
      assert.ok(
        existsSync(join(process.cwd(), "skills", name, "SKILL.md")),
        `missing source SKILL.md for ${name}`,
      );
    }
    for (const name of ["motion-craft", "senior-frontend"]) {
      assert.ok(
        existsSync(join(process.cwd(), "skills", name, "references")),
        `${name} should have a references/ directory`,
      );
    }
  });
});
