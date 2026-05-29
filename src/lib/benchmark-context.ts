import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { readRegistry, type Registry } from "./registry.js";

export interface ContextBenchmarkTask {
  id: string;
  title: string;
  featureKeys: string[];
  requiredDocs: string[];
  requiredSources: string[];
  irrelevantFiles: string[];
}

export interface ContextBenchmarkReport {
  schemaVersion: 1;
  fixture: string;
  tokenEstimate: {
    unit: "estimated file-context tokens";
    heuristic: "ceil(characters / 4)";
  };
  task: ContextBenchmarkTask;
  naive: ContextSetReport;
  codument: ContextSetReport;
  reductionPercent: number;
  requiredDocsFound: number;
  requiredDocsTotal: number;
  requiredSourcesFound: number;
  requiredSourcesTotal: number;
  irrelevantFilesIncluded: number;
  irrelevantFilesTotal: number;
}

export interface ContextSetReport {
  files: string[];
  estimatedTokens: number;
}

interface TaskFile {
  fixture: string;
  task: ContextBenchmarkTask;
}

const CONTEXT_EXTENSIONS = new Set([".js", ".jsx", ".json", ".md", ".ts", ".tsx"]);
const IGNORED_DIRS = new Set([".git", ".wxt", "dist", "node_modules"]);

export async function runContextBenchmark(
  fixtureRoot: string,
): Promise<ContextBenchmarkReport> {
  const taskFile = await readTaskFile(join(fixtureRoot, "task.json"));
  const projectRoot = join(fixtureRoot, "project");
  const registryPath = join(projectRoot, "docs", ".registry.json");
  const registry = await readRegistry(registryPath);

  const naiveFiles = await collectContextFiles(projectRoot);
  const codumentFiles = selectCodumentContextFiles(registry, taskFile.task);
  assertTaskFilesExist(taskFile.task, naiveFiles);

  const naive = await buildSetReport(projectRoot, naiveFiles);
  const codument = await buildSetReport(projectRoot, codumentFiles);
  const requiredDocsFound = countIncluded(
    taskFile.task.requiredDocs,
    codument.files,
  );
  const requiredSourcesFound = countIncluded(
    taskFile.task.requiredSources,
    codument.files,
  );
  const irrelevantFilesIncluded = countIncluded(
    taskFile.task.irrelevantFiles,
    codument.files,
  );
  assertCodumentContextIsRelevant(taskFile.task, codument.files);

  return {
    schemaVersion: 1,
    fixture: taskFile.fixture,
    tokenEstimate: {
      unit: "estimated file-context tokens",
      heuristic: "ceil(characters / 4)",
    },
    task: taskFile.task,
    naive,
    codument,
    reductionPercent: percentReduction(
      naive.estimatedTokens,
      codument.estimatedTokens,
    ),
    requiredDocsFound,
    requiredDocsTotal: taskFile.task.requiredDocs.length,
    requiredSourcesFound,
    requiredSourcesTotal: taskFile.task.requiredSources.length,
    irrelevantFilesIncluded,
    irrelevantFilesTotal: taskFile.task.irrelevantFiles.length,
  };
}

export function formatContextBenchmarkReport(
  report: ContextBenchmarkReport,
): string {
  return [
    "codument benchmark context",
    "",
    `Fixture: ${report.fixture}`,
    `Task: ${report.task.title} (${report.task.id})`,
    "",
    `Naive context:    ${formatNumber(report.naive.estimatedTokens)} estimated file-context tokens (${report.naive.files.length} files)`,
    `Codument context: ${formatNumber(report.codument.estimatedTokens)} estimated file-context tokens (${report.codument.files.length} files)`,
    `Reduction:        ${report.reductionPercent.toFixed(1)}%`,
    "",
    "Relevance:",
    `  Required docs found:       ${report.requiredDocsFound}/${report.requiredDocsTotal}`,
    `  Required source files:     ${report.requiredSourcesFound}/${report.requiredSourcesTotal}`,
    `  Irrelevant files included: ${report.irrelevantFilesIncluded}/${report.irrelevantFilesTotal}`,
    "",
  ].join("\n");
}

export function formatContextBenchmarkJson(
  report: ContextBenchmarkReport,
): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function estimateTokens(content: string): number {
  if (content.length === 0) return 0;
  return Math.ceil(content.length / 4);
}

async function readTaskFile(taskPath: string): Promise<TaskFile> {
  const raw = JSON.parse(await readFile(taskPath, "utf-8")) as TaskFile;
  return {
    fixture: raw.fixture,
    task: {
      id: raw.task.id,
      title: raw.task.title,
      featureKeys: [...raw.task.featureKeys],
      requiredDocs: [...raw.task.requiredDocs],
      requiredSources: [...raw.task.requiredSources],
      irrelevantFiles: [...raw.task.irrelevantFiles],
    },
  };
}

async function collectContextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectContextFilesInto(root, root, files);
  return files.sort();
}

async function collectContextFilesInto(
  root: string,
  currentDir: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await collectContextFilesInto(root, fullPath, files);
      }
      continue;
    }

    if (entry.isFile() && CONTEXT_EXTENSIONS.has(extname(entry.name))) {
      files.push(relative(root, fullPath));
    }
  }
}

function selectCodumentContextFiles(
  registry: Registry,
  task: ContextBenchmarkTask,
): string[] {
  const selectedFeatureKeys = new Set<string>();
  const pending = [...task.featureKeys];

  while (pending.length > 0) {
    const key = pending.shift();
    if (!key || selectedFeatureKeys.has(key)) continue;

    const entry = registry.features[key];
    if (!entry) {
      throw new Error(`Benchmark fixture references unknown feature "${key}"`);
    }

    selectedFeatureKeys.add(key);
    for (const dependencyKey of entry.depends_on) {
      if (!selectedFeatureKeys.has(dependencyKey)) {
        pending.push(dependencyKey);
      }
    }
  }

  const files = new Set<string>(["docs/.registry.json"]);
  for (const key of selectedFeatureKeys) {
    const entry = registry.features[key];
    files.add(entry.doc);
    for (const source of entry.sources) {
      files.add(source);
    }
  }

  return [...files].sort();
}

async function buildSetReport(
  projectRoot: string,
  files: string[],
): Promise<ContextSetReport> {
  let estimatedTokens = 0;

  for (const file of files) {
    const content = await readFile(join(projectRoot, file), "utf-8");
    estimatedTokens += estimateTokens(content);
  }

  return { files: [...files].sort(), estimatedTokens };
}

function countIncluded(expectedFiles: string[], actualFiles: string[]): number {
  const actual = new Set(actualFiles);
  return expectedFiles.filter((file) => actual.has(file)).length;
}

function assertTaskFilesExist(
  task: ContextBenchmarkTask,
  availableFiles: string[],
): void {
  const available = new Set(availableFiles);
  const expectedFiles = [
    ...task.requiredDocs,
    ...task.requiredSources,
    ...task.irrelevantFiles,
  ];
  const missingFiles = expectedFiles.filter((file) => !available.has(file));

  if (missingFiles.length > 0) {
    throw new Error(
      `Benchmark fixture task "${task.id}" references missing files: ${missingFiles.join(", ")}`,
    );
  }
}

function assertCodumentContextIsRelevant(
  task: ContextBenchmarkTask,
  codumentFiles: string[],
): void {
  const selected = new Set(codumentFiles);
  const expectedRelevantFiles = new Set([
    "docs/.registry.json",
    ...task.requiredDocs,
    ...task.requiredSources,
  ]);
  const missingRequiredFiles = [...expectedRelevantFiles].filter(
    (file) => !selected.has(file),
  );
  const includedIrrelevantFiles = task.irrelevantFiles.filter((file) =>
    selected.has(file),
  );

  if (missingRequiredFiles.length > 0) {
    throw new Error(
      `Benchmark fixture task "${task.id}" Codument context is missing required files: ${missingRequiredFiles.join(", ")}`,
    );
  }

  if (includedIrrelevantFiles.length > 0) {
    throw new Error(
      `Benchmark fixture task "${task.id}" Codument context includes irrelevant files: ${includedIrrelevantFiles.join(", ")}`,
    );
  }
}

function percentReduction(naiveTokens: number, codumentTokens: number): number {
  if (naiveTokens === 0) return 0;
  return ((naiveTokens - codumentTokens) / naiveTokens) * 100;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
