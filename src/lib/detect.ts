import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectInfo {
  language: "typescript" | "javascript";
  srcDir: string;
  sourceGlobs: string[];
  framework: string | null;
}

export async function detectProject(root: string): Promise<ProjectInfo> {
  const hasTs = existsSync(join(root, "tsconfig.json"));
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
