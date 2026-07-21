import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveScopeSync } from "./analyze.js";

export interface ProjectInfo {
  language: "typescript" | "javascript";
  srcDir: string;
  sourceGlobs: string[];
  framework: string | null;
}

export async function detectProject(root: string): Promise<ProjectInfo> {
  const hasTs = await hasTypeScriptProject(root, new Set(resolveScopeSync(root).spec.dirs));
  const hasSrc = existsSync(join(root, "src"));

  const srcDir = hasSrc ? "src" : ".";
  // The chosen family plus its module flavors, so the scaffolded always-document
  // rule covers every file shape the gate governs for that language.
  const ext = hasTs ? "ts" : "js";
  const sourceGlobs = [
    `${srcDir}/**/*.${ext}`,
    `${srcDir}/**/*.${ext}x`,
    `${srcDir}/**/*.m${ext}`,
    `${srcDir}/**/*.c${ext}`,
  ];

  let framework: string | null = null;
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    // The target project's package.json is the user's file, read only for a
    // best-effort framework hint. A malformed one must not crash onboarding with
    // a raw SyntaxError on the very first command: warn once and carry on with no
    // detected framework (unlike codument's own state files, which fail loud).
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      const deps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (deps["next"]) framework = "nextjs";
      else if (deps["@remix-run/node"] || deps["@remix-run/react"]) framework = "remix";
      else if (deps["express"]) framework = "express";
      else if (deps["@nestjs/core"]) framework = "nestjs";
      else if (deps["react"]) framework = "react";
      else if (deps["vue"]) framework = "vue";
      else if (deps["svelte"]) framework = "svelte";
    } catch {
      console.warn(
        "  codument: could not parse package.json — skipping framework detection",
      );
    }
  }

  return { language: hasTs ? "typescript" : "javascript", srcDir, sourceGlobs, framework };
}

// Shared with the analyzer so source discovery never disagrees across commands —
// including the project's own declared exclusions, so a build tree the project
// named cannot be what detection reads a language or framework off.

async function hasTypeScriptProject(root: string, ignoredDirs: Set<string>): Promise<boolean> {
  if (existsSync(join(root, "tsconfig.json"))) {
    return true;
  }

  return hasNestedTypeScript(root, 0, 4, ignoredDirs);
}

async function hasNestedTypeScript(
  dir: string,
  depth: number,
  maxDepth: number,
  ignoredDirs: Set<string>,
): Promise<boolean> {
  if (depth > maxDepth) {
    return false;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      if (entry.name === "tsconfig.json") {
        return true;
      }
      if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.(ts|mts|cts)$/.test(entry.name)) {
        return true;
      }
      continue;
    }

    if (entry.isDirectory() && !ignoredDirs.has(entry.name)) {
      if (await hasNestedTypeScript(join(dir, entry.name), depth + 1, maxDepth, ignoredDirs)) {
        return true;
      }
    }
  }

  return false;
}
