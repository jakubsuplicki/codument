export {
  allSources,
  isMatureEntry,
  normalizeRegistry,
  PLANNED_STATUSES,
  readRegistry,
  readRegistrySync,
  updateRegistryEntry,
  writeRegistry,
} from "./lib/registry.js";
export {
  AGENT_PROFILES,
  DELIVERY_SKILLS,
  DOMAIN_SKILLS,
  ALL_SKILLS,
  resolveSkills,
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
  OwnershipLint,
  RiskTouch,
  StaleDoc,
} from "./lib/change-state.js";
export { isGitRepo, getWorkingTreeChanges } from "./lib/git.js";
export {
  algoStamp,
  byteNormalize,
  changedPathsBetween,
  worktreeChangesSince,
  readBlobAtRef,
  refReachable,
  resolveBase,
  EMPTY_TREE_SHA,
  ALGO_VERSION,
  GateError,
} from "./lib/two-ref.js";
export type {
  ChangedPath,
  ChangeStatus,
  ResolvedBase,
  GateErrorKind,
} from "./lib/two-ref.js";
export {
  coarseAdapter,
  adapterFor,
  changedAnchors,
  changedAnchorsAgainstWorktree,
  gatherAnchorChanges,
  isPreciseFile,
  fileContentChange,
  contentChangedFiles,
  classifySource,
  LANGUAGE_MATRIX,
  preciseAdapterIds,
  renderLanguageMatrixTable,
  warmAdaptersForPaths,
  warmAdaptersForRepo,
  warmAllAdapters,
} from "./lib/fingerprint.js";
export type {
  Anchor,
  LanguageAdapter,
  LanguageMatrixRow,
  AnchorChange,
  AnchorChangeKind,
  FileChange,
  GatheredAnchors,
} from "./lib/fingerprint.js";
export { tsAdapter, MODULE_ANCHOR_NAME, classifyTsFile } from "./lib/ts-adapter.js";
export type { TsAnchorKind, TsFileMode, TsClassification } from "./lib/ts-adapter.js";
export { pyAdapter, classifyPyFile, warmPythonAdapter } from "./lib/py-adapter.js";
export type { PyAnchorKind, PyFileMode, PyClassification } from "./lib/py-adapter.js";
export { goAdapter, classifyGoFile, warmGoAdapter } from "./lib/go-adapter.js";
export type { GoAnchorKind, GoFileMode, GoClassification } from "./lib/go-adapter.js";
export { csharpAdapter, classifyCSharpFile, warmCSharpAdapter } from "./lib/csharp-adapter.js";
export type { CSharpAnchorKind, CSharpFileMode, CSharpClassification } from "./lib/csharp-adapter.js";
export { rustAdapter, classifyRustFile, warmRustAdapter } from "./lib/rust-adapter.js";
export type { RustAnchorKind, RustFileMode, RustClassification } from "./lib/rust-adapter.js";
export { jvmAdapter, classifyJvmFile, warmJvmAdapter } from "./lib/jvm-adapter.js";
export type { JvmAnchorKind, JvmFileMode, JvmClassification } from "./lib/jvm-adapter.js";
export { sfcAdapter, classifySfcFile } from "./lib/sfc-adapter.js";
export type { SfcFileMode, SfcClassification } from "./lib/sfc-adapter.js";
export { resolveOwner, splitAnchorId } from "./lib/ownership.js";
export type { OwnershipResolution } from "./lib/ownership.js";
export { auditRange } from "./lib/history-audit.js";
export type { HistoryAudit, AuditEntry, AuditSymbolMove } from "./lib/history-audit.js";
export {
  buildContextPack,
  gatherContextPack,
  applyBudget,
  ownersOfFile,
  selectedFromPlanRows,
  estimateTokens,
} from "./lib/context-pack.js";
export type {
  ContextPack,
  ContextEntry,
  ContextSelector,
  ContextResolution,
  ContextPackInput,
  BudgetResult,
} from "./lib/context-pack.js";
export {
  ackCovers,
  ackFileName,
  isIndependent,
  parseAck,
  readAcks,
  writeAck,
  ACKS_DIR,
} from "./lib/acknowledgment.js";
export type { Acknowledgment } from "./lib/acknowledgment.js";
export {
  classifyComovement,
  normalizeProse,
  symbolMentionLines,
} from "./lib/co-movement.js";
export type { ComovementStatus } from "./lib/co-movement.js";
export { computeDrift } from "./lib/drift.js";
export type { DriftFinding, DriftResult } from "./lib/drift.js";
export {
  harvestImports,
  importedFiles,
  resolveSpecifier,
} from "./lib/import-graph.js";
export type { ImportBinding } from "./lib/import-graph.js";
export { appendEvent, readRecentEvents } from "./lib/events.js";
export type { CodumentEvent } from "./lib/events.js";
export { MODEL_RATES, costOf, mergeRates, loadRates } from "./lib/token-cost.js";
export type {
  TokenUsage,
  ModelRate,
  CostBreakdown,
  RateTable,
} from "./lib/token-cost.js";
export { summarizeTokens, isTokenEvent } from "./lib/token-report.js";
export type {
  TokenEventData,
  TokenRollup,
  TokenSummary,
} from "./lib/token-report.js";
export {
  resolveSessionLog,
  featureForFile,
  recordToEvents,
  pumpFeed,
  claudeProjectsDir,
  normalizeModelId,
} from "./lib/claude-feed.js";
export type { FeedContext, RecordResult, PumpResult } from "./lib/claude-feed.js";
export { emitTokens } from "./lib/emit-producer.js";
export type { EmitTokensMeta } from "./lib/emit-producer.js";
export {
  parseDeliveryPlan,
  activeStep,
  extractStatus,
  isApproved,
  todoStatus,
  loadPlan,
  findActivePlans,
  emitActiveStep,
} from "./lib/plan-steps.js";
export type {
  PlanStep,
  ActivePlan,
  TodoStatus,
  StepEmitResult,
} from "./lib/plan-steps.js";
export { renderReviewReportHtml } from "./lib/report-html.js";
export type { ReportData, DemoExplainer } from "./lib/report-html.js";
export type {
  AnalysisResult,
  AnalyzeInput,
  BloatThresholds,
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
