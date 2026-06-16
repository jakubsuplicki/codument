import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_EXCLUSION_SPEC } from "./analyze.js";

export interface ProjectInfo {
  language: "typescript" | "javascript";
  srcDir: string;
  sourceGlobs: string[];
  framework: string | null;
}

export async function detectProject(root: string): Promise<ProjectInfo> {
  const hasTs = await hasTypeScriptProject(root);
  const hasSrc = existsSync(join(root, "src"));

  const srcDir = hasSrc ? "src" : ".";
  const ext = hasTs ? "ts" : "js";
  const sourceGlobs = [
    `${srcDir}/**/*.${ext}`,
    `${srcDir}/**/*.${ext}x`,
  ];

  let framework: string | null = null;
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
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
  }

  return { language: hasTs ? "typescript" : "javascript", srcDir, sourceGlobs, framework };
}

// Shared with the analyzer so source discovery never disagrees across commands.
const IGNORED_DIRS = new Set(DEFAULT_EXCLUSION_SPEC.dirs);

async function hasTypeScriptProject(root: string): Promise<boolean> {
  if (existsSync(join(root, "tsconfig.json"))) {
    return true;
  }

  return hasNestedTypeScript(root, 0, 4);
}

async function hasNestedTypeScript(
  dir: string,
  depth: number,
  maxDepth: number,
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
      if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        return true;
      }
      continue;
    }

    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      if (await hasNestedTypeScript(join(dir, entry.name), depth + 1, maxDepth)) {
        return true;
      }
    }
  }

  return false;
}
