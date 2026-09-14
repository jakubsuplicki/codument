import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import pc from "picocolors";
import {
  type ChangeSet,
  type ChangeSetBinding,
  changeSetBinding,
  parseChangeSetBinding,
  parseVerificationReceipt,
  readChangeSetFile,
  resolveChangeSet,
  sameChangeSetBinding,
  type VerificationReceipt,
  verificationReceiptCovers,
} from "../lib/change-set.js";
import { atomicWriteFileSync } from "../lib/events.js";
import { warmAdaptersForRepo } from "../lib/fingerprint.js";
import { assertRootIsRepoToplevel, getGitPath, getHeadSha, isGateableRoot } from "../lib/git.js";
import {
  findCoveringReviews,
  gatherReviewedFiles,
  gatherReviewFingerprint,
  mergeCoveringFindings,
  parseReviewArtifact,
  writeReview,
} from "../lib/review-artifact.js";
import { gatherReviewBundle, type ReviewBundle } from "../lib/review-bundle.js";
import {
  confirmCondition,
  confirmFindings,
  DEFAULT_TEST_SEARCH_DIRS,
  makeTestRunner,
  resolveTestCommand,
  resolveTestPath,
  resolveTestTimeout,
  runnerUnavailable,
} from "../lib/review-confirm.js";
import {
  countResolvedMovedSymbols,
  evaluateReviewGate,
  type ReviewGateResult,
} from "../lib/review-gate.js";
import { MODULE_ANCHOR_NAME } from "../lib/ts-adapter.js";
import { EMPTY_TREE_SHA } from "../lib/two-ref.js";
import { version } from "../lib/version.js";
import {
  buildReview,
  computeRealChange,
  currentOracle,
  exclusionForBoundary,
  printHuman,
  type ReviewReport,
  registryForBoundary,
  planForBoundary,
} from "./review.js";

export interface VerifyOptions {
  plan?: string;
  planId?: string;
  root?: string;
  details?: boolean;
  json?: boolean;
  paths?: string[];
  prepareReview?: boolean;
  record?: string;
  testCommand?: string[];
  testTimeout?: string;
  requireIndependentAck?: boolean;
}

interface VerificationFailures {
  unselectedStagedPaths: string[];
  staleDocs: string[];
  unmappedSources: string[];
  registryPointers: string[];
  docPointers: string[];
  blockingFindings: Array<{ citation: string; detail: string; failingTest: string | null }>;
}

interface ReviewAssessment {
  gate: ReviewGateResult;
  confirmUnavailable: string | null;
}

const WORKSHEET_PATH = ".codument/review-worksheet.json";
const RECEIPT_GIT_PATH = "codument/verify-receipt.json";
const RECEIPT_DISPLAY_PATH = ".git/codument/verify-receipt.json";

function strictFailures(report: ReviewReport, boundary: ChangeSet): VerificationFailures {
  const unique = (paths: string[]) => [...new Set(paths)].sort();
  return {
    unselectedStagedPaths: boundary.unselectedStagedPaths,
    staleDocs: unique(report.state.staleDocs.map((item) => item.doc)),
    unmappedSources: unique(report.state.unmapped),
    registryPointers: unique(report.state.registryPointers.map((item) => item.file)),
    docPointers: unique(report.state.docPointers.map((item) => item.doc)),
    blockingFindings: [],
  };
}

function hasStaticFailure(failures: VerificationFailures): boolean {
  return (
    failures.unselectedStagedPaths.length > 0 ||
    failures.staleDocs.length > 0 ||
    failures.unmappedSources.length > 0 ||
    failures.registryPointers.length > 0 ||
    failures.docPointers.length > 0
  );
}

function bundleFor(
  root: string,
  base: string,
  boundary: ChangeSet,
  report: ReviewReport,
): ReviewBundle {
  return gatherReviewBundle(
    root,
    base,
    report.state,
    registryForBoundary(root, boundary),
    report.plan,
    null,
    boundary,
    (path) => readChangeSetFile(root, boundary, path),
    report.testImpact,
    report.changedPaths,
    report.ignoredPaths,
  );
}

function recordReview(
  root: string,
  path: string,
  base: string,
  boundary: ChangeSet,
  report: ReviewReport,
  realChangeSet: string[],
  bundle: ReviewBundle,
): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvePath(root, path), "utf8"));
  } catch (error) {
    throw new Error(`could not read review worksheet: ${(error as Error).message}`);
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const reviewContext =
    typeof input.reviewContext === "object" && input.reviewContext !== null
      ? (input.reviewContext as Record<string, unknown>)
      : null;
  if (input.version !== 1) {
    throw new Error(
      "the review worksheet version is unsupported; regenerate it with `codument verify`",
    );
  }
  const worksheetBoundary = parseChangeSetBinding(reviewContext?.boundary);
  const binding = changeSetBinding(boundary);
  if (!worksheetBoundary || !sameChangeSetBinding(worksheetBoundary, binding)) {
    throw new Error(
      "the review worksheet does not match the current staged boundary; run `codument verify` to regenerate it",
    );
  }
  if (input.bundleStamp !== bundle.stamp) {
    throw new Error(
      "the review worksheet's bundle stamp is stale; run `codument verify` to regenerate it",
    );
  }
  if (JSON.stringify(reviewContext) !== JSON.stringify(bundle)) {
    throw new Error(
      "the generated review context was modified; run `codument verify --prepare-review` to restore it",
    );
  }

  const provisional = parseReviewArtifact({
    base,
    diffFingerprint: "pending",
    invariantsChecked: input.invariantsChecked,
    findings: input.findings,
    signer: input.signer,
    bundleStamp: input.bundleStamp,
    boundary: binding,
  });
  if (!provisional) {
    throw new Error(
      "complete invariantsChecked and signer, and keep every finding in the generated worksheet shape",
    );
  }
  const snapshotRead = (path: string) => readChangeSetFile(root, boundary, path);
  const resolveTest = (reference: string) =>
    resolveTestPath(root, reference, DEFAULT_TEST_SEARCH_DIRS, snapshotRead);
  const fingerprint = gatherReviewFingerprint(
    root,
    base,
    realChangeSet,
    provisional.findings,
    resolveTest,
    currentOracle(root, base, report.state, boundary, report.testImpact, report.plan, report.changedPaths, report.ignoredPaths),
    binding.fingerprint,
    snapshotRead,
  );
  writeReview(root, {
    ...provisional,
    diffFingerprint: fingerprint,
    files: gatherReviewedFiles(root, realChangeSet, snapshotRead),
  });
}

function assessReview(
  root: string,
  base: string,
  boundary: ChangeSet,
  report: ReviewReport,
  realChangeSet: string[],
  realDeletions: string[],
  options: VerifyOptions,
): ReviewAssessment {
  const binding = changeSetBinding(boundary);
  const snapshotRead = (path: string) => readChangeSetFile(root, boundary, path);
  const resolveTest = (reference: string) =>
    resolveTestPath(root, reference, DEFAULT_TEST_SEARCH_DIRS, snapshotRead);
  const covering = findCoveringReviews(
    root,
    base,
    realChangeSet,
    resolveTest,
    currentOracle(root, base, report.state, boundary, report.testImpact, report.plan, report.changedPaths, report.ignoredPaths),
    binding,
    snapshotRead,
  );
  const recordedFindings = covering.length > 0 ? mergeCoveringFindings(covering) : null;
  const hasReproduction = recordedFindings?.some((finding) => finding.failingTest) === true;
  // Runner availability is relevant only when a covering review made a reproducible
  // claim. Probing npx for a missing review or a clean review would add a 15-second
  // subprocess to the ordinary green path and can leave a timed-out Windows shell
  // holding the repository open after the command already returned.
  const resolvedCommand = hasReproduction ? resolveTestCommand(root, options.testCommand, snapshotRead) : null;
  const resolvedTimeout = hasReproduction ? resolveTestTimeout(root, options.testTimeout, snapshotRead) : null;
  const confirmed = recordedFindings
    ? confirmFindings(
        recordedFindings,
        hasReproduction
          ? makeTestRunner({
              root,
              snapshot: boundary,
              command: resolvedCommand?.command,
              timeoutMs: resolvedTimeout?.timeoutMs,
            })
          : () => {
              throw new Error("a review finding without a test must not invoke the test runner");
            },
      ).findings
    : null;
  const unadjudicated = confirmed?.filter((finding) => finding.testOutcome === "unrunnable") ?? [];
  const confirmUnavailable =
    resolvedCommand && resolvedTimeout
      ? confirmCondition({
          commandProblem: resolvedCommand.problem,
          timeoutProblem: resolvedTimeout.problem,
          unadjudicated: unadjudicated.length,
          timedOut: unadjudicated.filter((finding) => finding.testCause === "timeout").length,
          budgetMs: resolvedTimeout.timeoutMs,
          noun: "finding",
          consequence: "advisory rather than judged",
          runnerUnavailable: runnerUnavailable(root, resolvedCommand.command),
        })
      : null;
  const gate = evaluateReviewGate(
    {
      realChangeCount: realChangeSet.length,
      contractChangeCount: report.contractChanges?.filter((change) => change.requiresReview).length,
      housekeepingInstructionCount: report.contractChanges?.filter((change) => change.kind === "instruction" && !change.requiresReview && change.before !== null && change.after !== null && realChangeSet.includes(change.path)).length,
      changedSourceCount: report.state.changedSources.length,
      otherChangedCount: report.state.otherChanged.length,
      deletionCount: realDeletions.length,
      riskTouchCount: report.state.riskTouches.length,
      ownershipLintCount: report.state.ownershipLints.length,
      moduleResidualMoved: report.drift.some((item) => item.symbol === MODULE_ANCHOR_NAME),
      movedSymbolCount: countResolvedMovedSymbols(report.drift.map((item) => item.symbol)),
    },
    confirmed,
  );
  return { gate, confirmUnavailable };
}

function writeWorksheet(root: string, bundle: ReviewBundle, force = false): void {
  const path = join(root, WORKSHEET_PATH);
  if (!force && existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (existing.bundleStamp === bundle.stamp) return;
    } catch {
      // Replace an unreadable or malformed generated worksheet.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const worksheet = {
    version: 1,
    instructions: [
      "Review reviewContext against its documented contracts and staged files.",
      "List each contract you actually checked in invariantsChecked.",
      "Record findings using citation, detail, failingTest (or null), and status.",
      "Set signer, then run the printed codument verify --record command.",
    ],
    invariantsChecked: [] as string[],
    findings: [] as unknown[],
    signer: "",
    bundleStamp: bundle.stamp,
    reviewContext: bundle,
  };
  atomicWriteFileSync(path, `${JSON.stringify(worksheet, null, 2)}\n`);
}

function writeReceipt(root: string, boundary: ChangeSetBinding, planApproval: VerificationReceipt["planApproval"]): void {
  const path = getGitPath(root, RECEIPT_GIT_PATH);
  if (!path) throw new Error("could not resolve Git-owned verification receipt path");
  mkdirSync(dirname(path), { recursive: true });
  const receipt: VerificationReceipt = { version: 1, codumentVersion: version, boundary, planApproval };
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === encoded) return;
  atomicWriteFileSync(path, encoded);
}

function reusableReceiptCovers(root: string, boundary: ChangeSetBinding, planApproval: VerificationReceipt["planApproval"]): boolean {
  const path = getGitPath(root, RECEIPT_GIT_PATH);
  if (!path || !existsSync(path)) return false;
  try {
    const receipt = parseVerificationReceipt(JSON.parse(readFileSync(path, "utf8")));
    return receipt ? verificationReceiptCovers(receipt, boundary, version, planApproval) : false;
  } catch {
    return false;
  }
}

function canReuseReceipt(options: VerifyOptions, boundary: ChangeSet): boolean {
  return (
    boundary.complete &&
    options.paths === undefined &&
    options.details !== true &&
    options.json !== true &&
    options.prepareReview !== true &&
    options.record === undefined &&
    options.testCommand === undefined &&
    options.testTimeout === undefined &&
    options.requireIndependentAck !== true
  );
}

function invocation(options: VerifyOptions, extra: string): string {
  const selected = options.paths?.length
    ? ` --paths ${options.paths.map((path) => (/\s/.test(path) ? `"${path.replace(/"/g, '""')}"` : path)).join(" ")}`
    : "";
  const plan = options.plan ? ` --plan ${JSON.stringify(options.plan)}` : "";
  const id = options.planId ? ` --plan-id ${JSON.stringify(options.planId)}` : "";
  return `codument verify${selected}${plan}${id} ${extra}`;
}

function printCompact(
  options: VerifyOptions,
  boundary: ChangeSet,
  failures: VerificationFailures,
  review: ReviewGateResult | null,
  worksheetWritten: boolean,
  passed: boolean,
): void {
  if (passed) {
    console.log(
      `codument verify: ${pc.green("PASS")} — staged · ${boundary.fingerprint.slice(0, 12)}`,
    );
    return;
  }
  if (hasStaticFailure(failures)) {
    console.log(`codument verify: ${pc.red("BLOCKED")}`);
    for (const path of failures.unselectedStagedPaths)
      console.log(`  staged path outside selection → ${path}`);
    for (const path of failures.staleDocs) console.log(`  stale doc → ${path}`);
    for (const path of failures.unmappedSources) console.log(`  map source → ${path}`);
    for (const path of failures.registryPointers)
      console.log(`  repair registry pointer → ${path}`);
    for (const path of failures.docPointers) console.log(`  repair doc pointer → ${path}`);
    console.log(`  details → ${invocation(options, "--details")}`);
    return;
  }
  if (review && !review.covered && worksheetWritten) {
    console.log(`codument verify: ${pc.yellow("REVIEW REQUIRED")}`);
    console.log(`  worksheet → ${WORKSHEET_PATH}`);
    console.log(`  next → ${invocation(options, `--record ${WORKSHEET_PATH}`)}`);
    return;
  }
  console.log(`codument verify: ${pc.red("BLOCKED")}`);
  for (const finding of failures.blockingFindings) {
    console.log(
      `  finding → ${finding.citation}: ${finding.detail}` +
        (finding.failingTest ? ` (test: ${finding.failingTest})` : ""),
    );
  }
  console.log(`  details → ${invocation(options, "--details")}`);
}

export async function verify(options: VerifyOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();
  const machineFailure = (reason: string): void => {
    if (options.json) {
      console.log(JSON.stringify({ version: 1, gate: "unavailable", reason }, null, 2));
    } else {
      console.log(`codument verify: ${pc.red("BLOCKED")} — ${reason}`);
    }
    process.exitCode = 1;
  };

  if (options.details && options.json) {
    machineFailure("--details cannot combine with --json");
    return;
  }
  if (options.prepareReview && options.record) {
    machineFailure("--prepare-review cannot combine with --record");
    return;
  }
  if (!isGateableRoot(root)) {
    machineFailure("not a git repository");
    return;
  }

  try {
    assertRootIsRepoToplevel(root);
    options = { ...options, ...workPlanSelection(root, options, true) };
    const boundary = resolveChangeSet(
      root,
      options.paths ? { mode: "explicit-staged", paths: options.paths } : { mode: "staged" },
    );
    const binding = changeSetBinding(boundary);
    const selectedPlan = planForBoundary(root, boundary, options);
    const planApproval = selectedPlan ? { path: selectedPlan.plan, planId: selectedPlan.planId ?? null, digest: selectedPlan.approvalDigest ?? null } : null;
    if (canReuseReceipt(options, boundary) && reusableReceiptCovers(root, binding, planApproval)) {
      console.log(
        `codument verify: ${pc.green("PASS")} — staged · ${boundary.fingerprint.slice(0, 12)}`,
      );
      return;
    }
    await warmAdaptersForRepo(root);
    const exclusion = exclusionForBoundary(root, boundary);
    const report = buildReview(root, undefined, "HEAD", undefined, {
      plan: options.plan,
      planId: options.planId,
      requireIndependentAck: options.requireIndependentAck === true,
      exclusion,
      boundary,
    });
    const base = getHeadSha(root) ?? EMPTY_TREE_SHA;
    const failures = strictFailures(report, boundary);
    const { set: realChangeSet, realDeletions } = computeRealChange(
      report,
      report.deletions,
      exclusion,
    );
    let bundle: ReviewBundle | null = null;

    if (options.record) {
      if (hasStaticFailure(failures)) {
        throw new Error(
          "the staged boundary must pass documentation sync before review is recorded",
        );
      }
      bundle = bundleFor(root, base, boundary, report);
      recordReview(root, options.record, base, boundary, report, realChangeSet, bundle);
    }

    const staticFailed = hasStaticFailure(failures);
    const assessment = staticFailed
      ? null
      : assessReview(root, base, boundary, report, realChangeSet, realDeletions, options);
    failures.blockingFindings =
      assessment?.gate.blockingFindings.map((finding) => ({
        citation: finding.citation,
        detail: finding.detail,
        failingTest: finding.failingTest,
      })) ?? [];
    const passed = !staticFailed && assessment?.gate.passed === true;
    const shouldWriteWorksheet =
      !staticFailed &&
      assessment?.gate.required === true &&
      (!assessment.gate.covered || options.prepareReview === true);
    if (shouldWriteWorksheet) {
      bundle ??= bundleFor(root, base, boundary, report);
      writeWorksheet(root, bundle, options.prepareReview === true);
    }
    if (passed && boundary.complete) writeReceipt(root, binding, planApproval);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            version: 1,
            gate: "ok",
            passed,
            boundary: {
              ...binding,
              complete: boundary.complete,
              unselectedStagedPaths: boundary.unselectedStagedPaths,
            },
            ignoredDirtyCount: boundary.dirtyOutside.length,
            documentation: {
              passed:
                failures.staleDocs.length === 0 &&
                failures.unmappedSources.length === 0 &&
                failures.registryPointers.length === 0 &&
                failures.docPointers.length === 0,
            },
            testImpact: report.testImpact,
            review: assessment
              ? assessment.confirmUnavailable
                ? { ...assessment.gate, confirmUnavailable: assessment.confirmUnavailable }
                : assessment.gate
              : { status: "not-run", reason: "documentation synchronization failed" },
            failures,
            worksheet: shouldWriteWorksheet ? WORKSHEET_PATH : null,
            receipt: passed && boundary.complete ? RECEIPT_DISPLAY_PATH : null,
          },
          null,
          2,
        ),
      );
    } else {
      if (options.details) printHuman(report);
      printCompact(
        options,
        boundary,
        failures,
        assessment?.gate ?? null,
        shouldWriteWorksheet,
        passed,
      );
    }
    if (!passed) process.exitCode = 1;
  } catch (error) {
    machineFailure(error instanceof Error ? error.message : String(error));
  }
}
import { workPlanSelection } from "../lib/work-state.js";
