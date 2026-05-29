import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";

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

interface LegacyRegistry {
  features?: unknown;
  mappings?: unknown;
}

export async function readRegistry(registryPath: string): Promise<Registry> {
  if (!existsSync(registryPath)) {
    return { features: {} };
  }
  const content = await readFile(registryPath, "utf-8");
  try {
    return normalizeRegistry(JSON.parse(content));
  } catch {
    return { features: {} };
  }
}

export function readRegistrySync(registryPath: string): Registry {
  if (!existsSync(registryPath)) {
    return { features: {} };
  }
  try {
    return normalizeRegistry(JSON.parse(readFileSync(registryPath, "utf-8")));
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
      registry = normalizeRegistry(JSON.parse(readFileSync(registryPath, "utf-8")));
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

export function normalizeRegistry(
  input: unknown,
  date = new Date().toISOString().split("T")[0],
): Registry {
  const raw = isRecord(input) ? (input as LegacyRegistry) : {};
  const registry: Registry = { features: {} };

  if (isRecord(raw.features)) {
    for (const [key, value] of Object.entries(raw.features)) {
      const entry = normalizeRegistryEntry(key, value, date);
      if (entry) {
        registry.features[key] = entry;
      }
    }
  }

  if (isRecord(raw.mappings)) {
    for (const [source, docs] of Object.entries(raw.mappings)) {
      if (!Array.isArray(docs)) continue;

      for (const doc of docs) {
        if (typeof doc !== "string" || !doc.trim()) continue;
        const docPath = normalizeDocPath(doc);
        const key = keyFromDocPath(docPath);
        const existing =
          registry.features[key] ??
          ({
            doc: docPath,
            type: typeFromDocPath(docPath),
            sources: [],
            depends_on: [],
            last_updated: date,
            status: "current",
          } satisfies RegistryEntry);

        if (!existing.sources.includes(source)) {
          existing.sources.push(source);
          existing.sources.sort();
        }
        registry.features[key] = existing;
      }
    }
  }

  return registry;
}

export function hasLegacyMappings(input: unknown): boolean {
  return isRecord(input) && isRecord((input as LegacyRegistry).mappings);
}

function normalizeRegistryEntry(
  key: string,
  value: unknown,
  date: string,
): RegistryEntry | null {
  if (!isRecord(value)) return null;

  const doc =
    typeof value.doc === "string" && value.doc.trim()
      ? normalizeDocPath(value.doc)
      : `docs/features/${key}.md`;
  const type =
    value.type === "feature" || value.type === "concept"
      ? value.type
      : typeFromDocPath(doc);
  const sources = Array.isArray(value.sources)
    ? value.sources.filter((source): source is string => typeof source === "string")
    : [];
  const depends_on = Array.isArray(value.depends_on)
    ? value.depends_on.filter((dependency): dependency is string => typeof dependency === "string")
    : [];
  const status =
    value.status === "stale" || value.status === "needs-review"
      ? value.status
      : "current";
  const last_updated =
    typeof value.last_updated === "string" && value.last_updated.trim()
      ? value.last_updated
      : date;

  return {
    doc,
    type,
    sources: [...new Set(sources)].sort(),
    depends_on: [...new Set(depends_on)].sort(),
    last_updated,
    status,
  };
}

function normalizeDocPath(doc: string): string {
  const trimmed = doc.trim().replace(/^\/+/, "");
  return trimmed.startsWith("docs/") ? trimmed : `docs/${trimmed}`;
}

function keyFromDocPath(docPath: string): string {
  const withoutDocs = docPath.replace(/^docs\//, "");
  const withoutExtension = withoutDocs.slice(
    0,
    withoutDocs.length - extname(withoutDocs).length,
  );
  const name = basename(withoutExtension);

  if (
    withoutExtension.startsWith("features/") ||
    withoutExtension.startsWith("concepts/")
  ) {
    return slug(name);
  }

  return slug(withoutExtension.replace(/\//g, "-"));
}

function typeFromDocPath(docPath: string): RegistryEntry["type"] {
  return docPath.replace(/^docs\//, "").startsWith("features/")
    ? "feature"
    : "concept";
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
