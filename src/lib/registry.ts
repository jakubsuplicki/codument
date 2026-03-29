import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface RegistryEntry {
  doc: string;
  type: "feature" | "concept";
  sources: string[];
  depends_on: string[];
  last_updated: string;
  status: "current" | "stale" | "needs-review";
}

export interface Registry {
  features: Record<string, RegistryEntry>;
}

export async function readRegistry(registryPath: string): Promise<Registry> {
  if (!existsSync(registryPath)) {
    return { features: {} };
  }
  const content = await readFile(registryPath, "utf-8");
  try {
    return JSON.parse(content) as Registry;
  } catch {
    return { features: {} };
  }
}

export async function writeRegistry(
  registryPath: string,
  registry: Registry,
): Promise<void> {
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

export function updateRegistryEntry(
  registryPath: string,
  key: string,
  entry: Partial<RegistryEntry>,
): Registry {
  let registry: Registry = { features: {} };
  if (existsSync(registryPath)) {
    try {
      registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Registry;
    } catch {
      registry = { features: {} };
    }
  }
  const existing = registry.features[key];
  registry.features[key] = {
    ...existing,
    ...entry,
    last_updated: new Date().toISOString().split("T")[0],
  } as RegistryEntry;
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  return registry;
}
