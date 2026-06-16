export {
  allSources,
  hasLegacyMappings,
  isLegacyEntry,
  isMatureEntry,
  migrateRegistry,
  normalizeRegistry,
  PLANNED_STATUSES,
  readRegistry,
  readRegistrySync,
  registryNeedsMigration,
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
export {
  analyze,
  discoverSourceFiles,
  makeIgnoredPredicate,
  isExcluded,
  isSourceFile,
  rollupScore,
  DEFAULT_EXCLUSION_SPEC,
  DEFAULT_BLOAT_THRESHOLDS,
} from "./lib/analyze.js";
export { renderCoverageBadge } from "./lib/badge.js";
export {
  computeChangeState,
  detectApprovedPlanScope,
} from "./lib/change-state.js";
export type {
  ApprovedPlan,
  ChangeState,
  ChangeStateInput,
  DependentFeature,
  FeatureGroup,
  HighFanoutChange,
  RiskTouch,
  StaleDoc,
} from "./lib/change-state.js";
export { isGitRepo, getWorkingTreeChanges } from "./lib/git.js";
export { appendEvent, readRecentEvents } from "./lib/events.js";
export type { CodumentEvent } from "./lib/events.js";
export { renderReviewReportHtml } from "./lib/report-html.js";
export type { ReportData, DemoExplainer } from "./lib/report-html.js";
export type {
  AnalysisResult,
  AnalyzeInput,
  BloatThresholds,
  ChangedFile,
  CoverageRatio,
  CoverageRatioId,
  CoverageReport,
  ExclusionSpec,
  LintFinding,
  LintFindingId,
} from "./lib/analyze.js";
export type {
  AgentCapabilities,
  AgentProfile,
  AgentProfileId,
} from "./lib/agent-profiles.js";
