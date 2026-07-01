import { existsSync } from "node:fs";
import { join } from "node:path";

export type AgentProfileId = "claude" | "codex";

export interface AgentCapabilities {
  instructions: boolean;
  skills: boolean;
  rules: boolean;
  hooks: boolean;
  subagents: boolean;
}

export interface AgentProfile {
  id: AgentProfileId;
  displayName: string;
  instructionFiles: string[];
  skillsDir: string;
  agentsDir?: string;
  rulesDir?: string;
  settingsFile?: string;
  capabilities: AgentCapabilities;
}

export const DELIVERY_SKILLS = [
  "establish-charter",
  "grill-with-docs",
  "plan-with-docs",
  "tdd",
  "work-step",
  "review-work",
  "commit-work",
  "update-docs",
] as const;

/**
 * Always-on domain-expertise skills shipped to every consumer repo alongside the
 * delivery loop. Each is task-scoped via its description (with a sibling exclusion
 * clause), so firing is gated by the description, not by installation.
 */
export const DOMAIN_SKILLS = [
  "senior-backend",
  "senior-architect",
  "senior-frontend",
  "frontend-design",
  "motion-craft",
  "code-reviewer",
  "review-codebase",
] as const;

/** Every skill codument installs into a repo: the delivery loop plus domain skills. */
export const ALL_SKILLS = [...DELIVERY_SKILLS, ...DOMAIN_SKILLS] as const;

/**
 * Agent definitions (subagent system prompts) installed into a subagent-capable
 * profile's `agentsDir`. The single source of truth so `init` and `update` cannot
 * drift apart. `adversarial-reviewer` is the independent reviewer the
 * adversarial-review gate spawns and `adversarial-planner` is its plan-time twin
 * (the plan adversary); the others back the bootstrap/scan/review skills.
 */
export const AGENT_DEFINITIONS = [
  "doc-writer.md",
  "doc-scanner.md",
  "code-reviewer.md",
  "adversarial-reviewer.md",
  "adversarial-planner.md",
] as const;

/**
 * The single seam for which skills install into a profile. No stack gating today
 * (every skill ships to every repo); kept as a function so future per-profile or
 * per-stack gating has one place to live.
 */
export function resolveSkills(): readonly string[] {
  return ALL_SKILLS;
}

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfile> = {
  codex: {
    id: "codex",
    displayName: "Codex / generic agents",
    instructionFiles: ["AGENTS.md"],
    skillsDir: ".agents/skills",
    capabilities: {
      instructions: true,
      skills: true,
      rules: false,
      hooks: false,
      subagents: false,
    },
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    instructionFiles: ["AGENTS.md", "CLAUDE.md"],
    skillsDir: ".claude/skills",
    agentsDir: ".claude/agents",
    rulesDir: ".claude/rules",
    settingsFile: ".claude/settings.json",
    capabilities: {
      instructions: true,
      skills: true,
      rules: true,
      hooks: true,
      subagents: true,
    },
  },
};

export function parseAgentIds(input?: string | string[]): AgentProfileId[] {
  const values = Array.isArray(input) ? input : input ? [input] : [];
  const ids = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (ids.length === 0) return [];

  const resolved: AgentProfileId[] = [];
  for (const id of ids) {
    if (id !== "claude" && id !== "codex") {
      throw new Error(
        `Unknown agent profile "${id}". Supported profiles: claude, codex.`,
      );
    }
    if (!resolved.includes(id)) resolved.push(id);
  }
  return resolved;
}

export function detectAgentIds(root: string): AgentProfileId[] {
  const detected: AgentProfileId[] = [];
  if (
    existsSync(join(root, ".agents")) ||
    existsSync(join(root, "AGENTS.md"))
  ) {
    detected.push("codex");
  }
  if (
    existsSync(join(root, ".claude")) ||
    existsSync(join(root, "CLAUDE.md"))
  ) {
    detected.push("claude");
  }
  return detected;
}

export function resolveAgentIds(
  root: string,
  input?: string | string[],
): AgentProfileId[] {
  const parsed = parseAgentIds(input);
  if (parsed.length > 0) return parsed;

  const detected = detectAgentIds(root);
  return detected.length > 0 ? detected : ["claude"];
}

export function getAgentProfiles(ids: AgentProfileId[]): AgentProfile[] {
  return ids.map((id) => AGENT_PROFILES[id]);
}
