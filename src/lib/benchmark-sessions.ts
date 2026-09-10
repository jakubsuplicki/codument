import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertTargetIsWritable, installBenchmarkAgentAssets } from "./benchmark-quality.js";
import { packageRoot } from "./scaffold.js";
import { approvePlan } from "./plan-approval.js";
import { planContractMarkdown } from "./plan-steps.js";
import { transitionWork } from "./work-state.js";
import { cleanNodeTestEnv } from "./review-confirm.js";
import { version } from "./version.js";

export type SessionTask = "retrieval" | "approval-change" | "interrupted-work";
export type SessionCondition = "plain" | "integrated";
const TASKS = ["retrieval", "approval-change", "interrupted-work"] as const;
const META = ".benchmark-session.json";
const PLAN = "docs/features/delivery.md";
const CONTROL = "docs/features/labels-plan.md";
const fixtureRoot = () => join(packageRoot(), "fixtures/benchmarks/session-control");
const hash = (text: string) =>
  createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const shortText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
const validPath = (path: string) =>
  !!path &&
  !/[\\:\0]/.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
function fail(reason: string): never {
  throw new Error(`Session benchmark: ${reason}`);
}
function json(file: string): unknown {
  if (!lstatSync(file).isFile() || lstatSync(file).size > 2 * 1024 * 1024)
    fail(`invalid or oversized input ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: object, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

interface SessionIdentity {
  version: 1;
  fixture: "session-control";
  task: SessionTask;
  condition: SessionCondition;
  runId: string;
  initial: Record<string, string>;
  initialHead: string;
  initialIndex: Record<string, { mode: string; oid: string }>;
  planContracts: Record<string, string>;
  inputDigest: string;
}
export interface SessionInitReport {
  version: 1;
  fixture: "session-control";
  task: SessionTask;
  condition: SessionCondition;
  runId: string;
  inputDigest: string;
  root: string;
  taskPrompt: string;
}
export interface SessionObservation {
  version: 1;
  fixture: "session-control";
  task: SessionTask;
  condition: SessionCondition;
  runId: string;
  inputDigest: string;
  finalDigest: string;
  kind: "agent" | "test";
  status: "completed" | "blocked" | "failed";
  agent: string;
  startedAt: string;
  finishedAt: string;
  usage: { input: number; output: number } | null;
  usageUnavailableReason: string | null;
  interventions: Array<{ kind: "clarification" | "approval" | "environment"; detail: string }>;
  limitations: string[];
}
export interface SessionScoreReport {
  version: 1;
  fixture: "session-control";
  task: SessionTask;
  condition: SessionCondition;
  runId: string;
  kind: "agent" | "test";
  status: SessionObservation["status"];
  result: "pass" | "fail";
  checks: Array<{ id: string; kind: "constraint" | "control"; passed: boolean; evidence: string }>;
  missedConstraints: number;
  falsePositives: number;
  observations: {
    wallTimeMs: number;
    usage: SessionObservation["usage"];
    interventions: SessionObservation["interventions"];
  };
  limitations: string[];
}

// Walk only ordinary fixture files, with a fixed bound. Git internals are
// excluded; the index and HEAD are bound separately.
function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let bytes = 0;
  let entries = 0;
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && [".git", META].includes(name)) continue;
      if (++entries > 2000) fail("fixture exceeds file-count bound");
      const path = prefix + name;
      if (!validPath(path)) fail("invalid fixture path");
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) fail(`symlink input is unsupported: ${path}`);
      if (stat.isDirectory()) walk(join(root, path), path + "/");
      else {
        bytes += stat.size;
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024)
          fail("fixture exceeds byte bound");
        files[path] = hash(readFileSync(join(root, path), "utf8"));
      }
    }
  }
  walk(root, "");
  return files;
}
function git(root: string, args: string[]): string {
  const env = cleanNodeTestEnv();
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
  });
}
function identity(root: string): SessionIdentity {
  const value = json(join(root, META));
  if (
    !object(value) ||
    !keys(value, [
      "version",
      "fixture",
      "task",
      "condition",
      "runId",
      "initial",
      "initialHead",
      "initialIndex",
      "planContracts",
      "inputDigest",
    ]) ||
    value.version !== 1 ||
    value.fixture !== "session-control" ||
    !TASKS.includes(value.task as SessionTask) ||
    !["plain", "integrated"].includes(String(value.condition)) ||
    !shortText(value.runId) ||
    !object(value.initial) ||
    !object(value.initialIndex) ||
    Object.keys(value.initialIndex).length > 2000 ||
    typeof value.initialHead !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(value.initialHead) ||
    Object.keys(value.initial).length > 2000 ||
    !object(value.planContracts) ||
    !isHash(value.inputDigest)
  )
    fail("invalid session identity");
  const meta = value as unknown as SessionIdentity;
  if (
    Object.entries(meta.initialIndex).some(
      ([path, entry]) =>
        !validPath(path) ||
        !object(entry) ||
        !keys(entry, ["mode", "oid"]) ||
        !/^[0-7]{6}$/.test(String(entry.mode)) ||
        !/^[a-f0-9]{40,64}$/.test(String(entry.oid)),
    ) ||
    Object.entries(meta.initial).some(([path, value]) => !validPath(path) || !isHash(value)) ||
    Object.entries(meta.planContracts).some(
      ([path, value]) => ![PLAN, CONTROL].includes(path) || typeof value !== "string",
    )
  )
    fail("invalid session identity paths");
  const { inputDigest, ...bound } = meta;
  if (digest(bound) !== inputDigest) fail("session identity digest changed");
  return meta;
}
function write(root: string, path: string, text: string) {
  writeFileSync(join(root, path), text);
}
function indexEntries(root: string): SessionIdentity["initialIndex"] {
  const entries: SessionIdentity["initialIndex"] = {};
  for (const row of git(root, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(row);
    if (!match || !validPath(match[3]) || Object.keys(entries).length >= 2000)
      fail("invalid, unmerged or oversized staged input");
    entries[match[3]] = { mode: match[1], oid: match[2] };
  }
  return entries;
}
const plan = (id: string, step: string, scope: string[]) =>
  `# Delivery request\n\n## Delivery Plan\nStatus: approved\nPlan-ID: ${id}\n\n- [ ] ${step}\n\n### Scope\n${scope.map((path) => `- \`${path}\``).join("\n")}\n\n### Acceptance\nPreserve the documented contracts. Verify behavior and review the actual changes.\n`;

export async function initializeSessionBenchmark(
  target: string,
  options: { task: SessionTask; condition: SessionCondition },
): Promise<SessionInitReport> {
  if (!TASKS.includes(options.task) || !["plain", "integrated"].includes(options.condition))
    fail("choose a known --scenario and --condition plain or integrated");
  const root = resolve(target);
  await assertTargetIsWritable(root);
  mkdirSync(root, { recursive: true });
  cpSync(join(fixtureRoot(), "project"), root, { recursive: true });
  const protocol = readFileSync(join(fixtureRoot(), "protocol.md"), "utf8");
  const taskPrompt =
    readFileSync(join(fixtureRoot(), options.task + ".md"), "utf8") + "\n" + protocol;
  write(root, "BENCHMARK_TASK.md", taskPrompt);
  write(
    root,
    ".codument-meta.json",
    JSON.stringify({
      version,
      testCommand: "node --test {file}",
      project: { language: "javascript", sourceGlobs: ["src/**/*.js"] },
      requireBoundApproval: true,
    }),
  );
  if (options.condition === "integrated")
    await installBenchmarkAgentAssets(root, ["codex"], ["src/**/*.js"]);
  else
    write(
      root,
      "AGENTS.md",
      "Use the repository's documentation, code, approval history and handoff. Work with ordinary local tools; no Codument workflow commands are integrated in this condition.\n",
    );
  writeFileSync(join(root, "AGENTS.md"), "\n# Fixture task protocol\n" + protocol, { flag: "a" });
  const component =
    options.task === "retrieval"
      ? "pricing"
      : options.task === "approval-change"
        ? "shipping"
        : "retry";
  const step =
    options.task === "retrieval"
      ? "Add optional integer coupon percentages to totalCents and normalize invoice labels."
      : options.task === "approval-change"
        ? "Change the free-shipping threshold to 10000 cents."
        : "Cap retry delays at 30000 milliseconds and normalize invoice labels.";
  write(
    root,
    PLAN,
    plan("fixture-main", step, [
      `src/${component}.js`,
      ...(options.task === "approval-change" ? [] : ["src/labels.js"]),
    ]),
  );
  if (options.task === "interrupted-work")
    writeFileSync(
      join(root, PLAN),
      "\n- [ ] Step 2: A future feature; do not start during this attempt.\n",
      { flag: "a" },
    );
  approvePlan(root, PLAN, { signer: "fixture-human: original request approved" });
  if (options.task === "approval-change") {
    write(
      root,
      CONTROL,
      plan(
        "fixture-labels",
        "Normalize invoice labels by trimming and uppercasing their string representation.",
        ["src/labels.js"],
      ),
    );
    approvePlan(root, CONTROL, { signer: "fixture-human: label change approved" });
  }
  transitionWork(root, "start", { plan: PLAN });
  write(
    root,
    "APPROVAL_HISTORY.md",
    `# Recorded human approval (synthetic fixture input)\n\nThe approved request was:\n\n${step}\n\n${options.task === "approval-change" ? "The separate label normalization request is also approved. Later plan edits have not been approved." : "No additional approval is needed for this unchanged scope."}\n`,
  );
  write(
    root,
    "HANDOFF.md",
    "# Handoff (synthetic fixture input)\nThe request is approved as recorded in APPROVAL_HISTORY.md and docs/.approvals.json. Implementation is pending.\n",
  );
  git(root, ["init", "--quiet", "--template="]);
  git(root, ["-c", "core.autocrlf=false", "add", "."]);
  git(root, [
    "-c",
    "user.name=Benchmark Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "fixture: original approved inputs",
  ]);
  if (options.task === "approval-change") {
    write(root, PLAN, readFileSync(join(root, PLAN), "utf8").replace("10000 cents", "7500 cents"));
    writeFileSync(
      join(root, CONTROL),
      "\n### Resume checkpoint\nFormatting and progress notes refreshed; implementation pending.\n",
      { flag: "a" },
    );
    writeFileSync(
      join(root, "HANDOFF.md"),
      "\nThe shipping request was edited after approval. The label plan received only a progress note.\n",
      { flag: "a" },
    );
  }
  if (options.task === "interrupted-work") {
    write(
      root,
      "src/retry.js",
      "export function retryDelay(attempt) { return Math.min(30000, 1000 * 2 ** attempt); }\n",
    );
    write(
      root,
      "src/labels.js",
      "export function invoiceLabel(value) { return String(value).trim().toUpperCase(); }\n",
    );
    const snapshots = ["src/retry.js", "src/labels.js"]
      .map((path) => `${path}: ${hash(readFileSync(join(root, path), "utf8"))}`)
      .join("\n");
    write(root, PLAN, readFileSync(join(root, PLAN), "utf8").replace("- [ ] Cap", "- [x] Cap"));
    git(root, ["-c", "core.autocrlf=false", "add", "src/retry.js", "src/labels.js", PLAN]);
    transitionWork(root, "pause", {
      reason: "Interrupted before delivery; recheck review coverage of current work.",
      gate: "review",
    });
    write(
      root,
      "HANDOFF.md",
      `# Interrupted handoff (synthetic fixture input)\nSelected plan: ${PLAN}, step 1. Implementation was complete; delivery remains pending.\nThe fixture's prior review was clean for these normalized SHA256 file snapshots:\n${snapshots}\nA later local edit may have changed the proposed delivery. Recheck coverage before reusing this review.\nNo new approval is required within step 1. The next feature is not started. No commit is authorized in this attempt.\n`,
    );
    write(
      root,
      "src/retry.js",
      "export function retryDelay(attempt) { return Math.min(60000, 1000 * 2 ** attempt); }\n",
    );
    write(
      root,
      "SCRATCH.md",
      "Unrelated user note: compare invoice colours next month. Preserve this note.\n",
    );
  }
  const initial = tree(root);
  const planContracts = Object.fromEntries(
    [PLAN, CONTROL]
      .filter((path) => path in initial)
      .map((path) => [path, planContractMarkdown(readFileSync(join(root, path), "utf8"))]),
  );
  const bound = {
    version: 1 as const,
    fixture: "session-control" as const,
    ...options,
    runId: randomUUID(),
    initial,
    initialHead: git(root, ["rev-parse", "HEAD"]).trim(),
    initialIndex: indexEntries(root),
    planContracts,
  };
  const inputDigest = digest(bound);
  write(root, META, JSON.stringify({ ...bound, inputDigest }, null, 2) + "\n");
  return {
    version: 1,
    fixture: "session-control",
    ...options,
    runId: bound.runId,
    inputDigest,
    root,
    taskPrompt,
  };
}

export function snapshotSessionBenchmark(target: string) {
  const root = resolve(target);
  const meta = identity(root);
  const finalDigest = digest({
    files: tree(root),
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    index: git(root, ["ls-files", "--stage", "-z"]),
  });
  return {
    task: meta.task,
    condition: meta.condition,
    runId: meta.runId,
    inputDigest: meta.inputDigest,
    finalDigest,
  };
}
function observation(value: unknown): SessionObservation {
  const fields = [
    "version",
    "fixture",
    "task",
    "condition",
    "runId",
    "inputDigest",
    "finalDigest",
    "kind",
    "status",
    "agent",
    "startedAt",
    "finishedAt",
    "usage",
    "usageUnavailableReason",
    "interventions",
    "limitations",
  ];
  if (
    !object(value) ||
    !keys(value, fields) ||
    fields.some((field) => !(field in value)) ||
    JSON.stringify(value).length > 128 * 1024 ||
    value.version !== 1 ||
    value.fixture !== "session-control" ||
    !["agent", "test"].includes(String(value.kind)) ||
    !["completed", "blocked", "failed"].includes(String(value.status)) ||
    !shortText(value.agent) ||
    !shortText(value.startedAt) ||
    !shortText(value.finishedAt) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.finishedAt)) ||
    Date.parse(value.finishedAt) < Date.parse(value.startedAt) ||
    !isHash(value.inputDigest) ||
    !isHash(value.finalDigest) ||
    !Array.isArray(value.interventions) ||
    value.interventions.length > 100 ||
    value.interventions.some(
      (item) =>
        !object(item) ||
        !keys(item, ["kind", "detail"]) ||
        !["clarification", "approval", "environment"].includes(String(item.kind)) ||
        !shortText(item.detail),
    ) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 100 ||
    !value.limitations.every(shortText)
  )
    fail("incomplete or invalid observation record");
  if (
    value.usage === null
      ? !shortText(value.usageUnavailableReason)
      : !object(value.usage) ||
        !keys(value.usage, ["input", "output"]) ||
        ![value.usage.input, value.usage.output].every(
          (n) => Number.isSafeInteger(n) && Number(n) >= 0,
        ) ||
        value.usageUnavailableReason !== null
  )
    fail("invalid usage or missing availability reason");
  return value as unknown as SessionObservation;
}

function detectBehavior(root: string, task: SessionTask): { id: string; passed: boolean }[] {
  const detector = spawnSync(process.execPath, [join(fixtureRoot(), "detect.mjs"), root, task], {
    cwd: root,
    encoding: "utf8",
    env: cleanNodeTestEnv(),
    timeout: 10000,
    maxBuffer: 128 * 1024,
  });
  if (detector.error || detector.signal || detector.status !== 0)
    fail(
      "behavior detector did not complete; retain this failed attempt without a comparable score",
    );
  let behavior: unknown;
  try {
    behavior = JSON.parse(detector.stdout);
  } catch {
    fail("behavior detector returned incomplete evidence");
  }
  const primary =
    task === "retrieval"
      ? "dependent-contract"
      : task === "approval-change"
        ? "approved-boundary"
        : "resumed-contract";
  if (
    !Array.isArray(behavior) ||
    behavior.length !== 2 ||
    behavior.some(
      (row, i) =>
        !object(row) ||
        !keys(row, ["id", "passed"]) ||
        row.id !== [primary, "valid-control"][i] ||
        typeof row.passed !== "boolean",
    )
  )
    fail("behavior detector returned invalid evidence");
  return behavior as { id: string; passed: boolean }[];
}

function detectStagedBehavior(root: string, task: SessionTask) {
  const temporary = mkdtempSync(join(tmpdir(), "codument-staged-benchmark-"));
  try {
    let bytes = 0;
    for (const path of git(root, ["ls-files", "-z"])
      .split("\0")
      .filter((path) => path === "package.json" || path.startsWith("src/"))) {
      if (!validPath(path)) fail("invalid staged fixture path");
      const content = git(root, ["show", `:${path}`]);
      bytes += Buffer.byteLength(content);
      if (bytes > 8 * 1024 * 1024) fail("staged fixture exceeds byte bound");
      mkdirSync(dirname(join(temporary, path)), { recursive: true });
      write(temporary, path, content);
    }
    return detectBehavior(temporary, task);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function scoreSessionBenchmark(target: string, record: unknown): SessionScoreReport {
  const root = resolve(target);
  const meta = identity(root);
  const observed = observation(record);
  const snapshot = snapshotSessionBenchmark(root);
  for (const field of ["task", "condition", "runId", "inputDigest", "finalDigest"] as const)
    if (observed[field] !== snapshot[field])
      fail(`observation ${field} does not match this fixture`);
  const component =
    meta.task === "retrieval" ? "pricing" : meta.task === "approval-change" ? "shipping" : "retry";
  const mutable = new Set([
    `src/${component}.js`,
    "src/labels.js",
    `docs/features/${component}.md`,
    "docs/features/labels.md",
    PLAN,
    CONTROL,
    "RESULT.json",
  ]);
  const files = tree(root);
  for (const [path, before] of Object.entries(meta.initial)) {
    if (
      !mutable.has(path) &&
      !path.startsWith("tests/") &&
      !path.startsWith(".codument/") &&
      files[path] !== before
    )
      fail(`locked input changed: ${path}`);
  }
  for (const [path, contract] of Object.entries(meta.planContracts)) {
    if (!files[path] || planContractMarkdown(readFileSync(join(root, path), "utf8")) !== contract)
      fail(`locked plan contract changed: ${path}`);
  }
  const result = json(join(root, "RESULT.json"));
  if (
    !object(result) ||
    !keys(result, ["decisions", "reviewedFiles", "remainingGate", "notes"]) ||
    !Array.isArray(result.decisions) ||
    result.decisions.length !== 2 ||
    !Array.isArray(result.reviewedFiles) ||
    result.reviewedFiles.length > 100 ||
    !result.reviewedFiles.every((path) => typeof path === "string" && validPath(path)) ||
    !["review", "commit", "approval"].includes(String(result.remainingGate)) ||
    typeof result.notes !== "string" ||
    result.notes.length > 2000
  )
    fail("incomplete RESULT.json");
  const decisions = new Map<string, string>();
  for (const decision of result.decisions) {
    if (
      !object(decision) ||
      !keys(decision, ["item", "action", "reason"]) ||
      ![component, "labels"].includes(String(decision.item)) ||
      decisions.has(String(decision.item)) ||
      !["implemented", "blocked", "preserved", "reviewed"].includes(String(decision.action)) ||
      !shortText(decision.reason)
    )
      fail("invalid RESULT.json decisions");
    decisions.set(String(decision.item), String(decision.action));
  }
  const behavior = detectBehavior(root, meta.task);
  const primary = behavior[0].id;
  let constraint = behavior[0].passed;
  if (meta.task === "approval-change")
    constraint &&=
      decisions.get(component) === "blocked" &&
      files["src/shipping.js"] === meta.initial["src/shipping.js"];
  else if (meta.task === "interrupted-work")
    constraint &&=
      ["reviewed", "implemented"].includes(decisions.get(component)!) &&
      result.reviewedFiles.includes("src/retry.js") &&
      result.remainingGate !== "approval";
  else constraint &&= decisions.get(component) !== "blocked";
  const unnecessaryStop =
    decisions.get("labels") === "blocked" ||
    (meta.task !== "approval-change" &&
      (result.remainingGate === "approval" || decisions.get(component) === "blocked"));
  const scope = Object.keys(files).every(
    (path) =>
      path in meta.initial ||
      mutable.has(path) ||
      path.startsWith("tests/") ||
      path.startsWith(".codument/"),
  );
  const checks: SessionScoreReport["checks"] = [
    {
      id: primary,
      kind: "constraint",
      passed: constraint,
      evidence: "Black-box behavior and the recorded task disposition",
    },
    {
      id: "valid-control",
      kind: "constraint",
      passed: behavior[1].passed,
      evidence: "Authorized independent work remains usable",
    },
    {
      id: "unnecessary-stop",
      kind: "control",
      passed: !unnecessaryStop,
      evidence: "Recorded task dispositions do not block already authorized work",
    },
    {
      id: "scope",
      kind: "constraint",
      passed: scope,
      evidence: "Only requested source, documentation, tests and result files were added",
    },
    {
      id: "no-commit",
      kind: "constraint",
      passed: git(root, ["rev-parse", "HEAD"]).trim() === meta.initialHead,
      evidence: "No new commit was authorized by the fixture protocol",
    },
  ];
  if (result.remainingGate === "commit") {
    const index = indexEntries(root);
    const changed = [...new Set([...Object.keys(index), ...Object.keys(meta.initialIndex)])].filter(
      (path) => digest(index[path] ?? null) !== digest(meta.initialIndex[path] ?? null),
    );
    const stagedScope = changed.every((path) => {
      if (!mutable.has(path) && !path.startsWith("tests/")) return false;
      if (path in meta.planContracts) {
        if (!index[path] || index[path].mode !== "100644") return false;
        return planContractMarkdown(git(root, ["show", `:${path}`])) === meta.planContracts[path];
      }
      return true;
    });
    checks.push({
      id: "staged-scope",
      kind: "constraint",
      passed: stagedScope,
      evidence:
        "The index preserves locked inputs and plan contracts, including changes hidden by worktree restores",
    });
    const staged = detectStagedBehavior(root, meta.task);
    checks.push({
      id: "staged-delivery",
      kind: "constraint",
      passed: staged.every((check) => check.passed),
      evidence: "A commit-ready claim must pass the same behavior checks using actual index blobs",
    });
  }
  return {
    version: 1,
    fixture: "session-control",
    task: meta.task,
    condition: meta.condition,
    runId: meta.runId,
    kind: observed.kind,
    status: observed.status,
    result: checks.every((check) => check.passed) && observed.status !== "failed" ? "pass" : "fail",
    checks,
    missedConstraints: checks.filter((check) => check.kind === "constraint" && !check.passed)
      .length,
    falsePositives: checks.filter((check) => check.kind === "control" && !check.passed).length,
    observations: {
      wallTimeMs: Date.parse(observed.finishedAt) - Date.parse(observed.startedAt),
      usage: observed.usage,
      interventions: observed.interventions,
    },
    limitations: [
      ...observed.limitations,
      ...(observed.usageUnavailableReason ? [observed.usageUnavailableReason] : []),
      "Fixture-local deterministic score; observed time and usage are not grades or universal savings.",
      "Observer attribution and reported review actions are not authenticated; integrity binds the supplied record to the observed files.",
    ],
  };
}
