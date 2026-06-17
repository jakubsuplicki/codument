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
  "grill-with-docs",
  "plan-with-docs",
  "tdd",
  "work-step",
  "review-work",
  "commit-work",
  "update-docs",
] as const;

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
