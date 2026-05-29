export {
  hasLegacyMappings,
  normalizeRegistry,
  readRegistry,
  readRegistrySync,
  updateRegistryEntry,
  writeRegistry,
} from "./lib/registry.js";
export {
  AGENT_PROFILES,
  DELIVERY_SKILLS,
  detectAgentIds,
  getAgentProfiles,
  parseAgentIds,
  resolveAgentIds,
} from "./lib/agent-profiles.js";
export type { Registry, RegistryEntry } from "./lib/registry.js";
export type {
  AgentCapabilities,
  AgentProfile,
  AgentProfileId,
} from "./lib/agent-profiles.js";
