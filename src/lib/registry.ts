import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";

// The registry entry is THE model the analyzers read. It splits ownership into
// owned (`primary_sources`) versus impacted (`related_sources`), adds durable
// `docs`, and carries optional `risk` hints. `status` preserves the project's
// real vocabulary instead of flattening unknown values to "current".
export interface RegistryEntry {
  doc: string;
  type: "feature" | "concept";
  primary_sources: string[];
  related_sources: string[];
  docs: string[];
  depends_on: string[];
  risk: string[];
  status: string;
  /** When true, mutes the `under-decomposed` shape nudge — a deliberately large
   *  but cohesive feature the author has acknowledged. Absent ⇒ not acknowledged. */
  cohesive?: boolean;
}

export interface Registry {
  features: Record<string, RegistryEntry>;
}

// Statuses that mean "not built yet". A registry entry with one of these is not
// considered "mature" for coverage ratios (e.g. an empty `depends_on` on a draft
// entry should not be penalized).
export const PLANNED_STATUSES = new Set(["draft", "planned", "proposed"]);

interface RawRegistry {
  features?: unknown;
}

// Union of every source path an entry maps, owned or related, deduped and sorted.
// Consumers that only care "is this file mentioned anywhere" use this.
export function allSources(entry: RegistryEntry): string[] {
  return uniqSort([...entry.primary_sources, ...entry.related_sources]);
}

// True when the entry represents real, built work: it owns at least one source
// and its status is not a planned/draft placeholder.
export function isMatureEntry(entry: RegistryEntry): boolean {
  return entry.primary_sources.length > 0 && !PLANNED_STATUSES.has(entry.status);
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
  registry.features[key] = ensureEntryDefaults(key, { ...existing, ...entry });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  return registry;
}

// The read path validates/defaults/sorts registry entries and preserves the
// status vocabulary. An entry with no `primary_sources` normalizes to empty,
// which `doctor` surfaces.
export function normalizeRegistry(input: unknown): Registry {
  const raw = isRecord(input) ? (input as RawRegistry) : {};
  const registry: Registry = { features: {} };

  if (isRecord(raw.features)) {
    for (const [key, value] of Object.entries(raw.features)) {
      const entry = parseEntry(key, value);
      if (entry) {
        registry.features[key] = entry;
      }
    }
  }

  return registry;
}

// Parses one entry into the registry shape, defaulting and sorting its fields.
function parseEntry(key: string, value: unknown): RegistryEntry | null {
  if (!isRecord(value)) return null;

  const doc =
    typeof value.doc === "string" && value.doc.trim()
      ? normalizeDocPath(value.doc)
      : `docs/features/${key}.md`;
  const type =
    value.type === "feature" || value.type === "concept"
      ? value.type
      : typeFromDocPath(doc);

  const primary_sources = stringArray(value.primary_sources);
  const related_sources = stringArray(value.related_sources);
  const docs = stringArray(value.docs);
  const depends_on = stringArray(value.depends_on);
  const risk = stringArray(value.risk);

  // Preserve the real status vocabulary. Only an empty/non-string value falls
  // back to "current"; unknown statuses like "in-progress" are kept verbatim.
  const status =
    typeof value.status === "string" && value.status.trim()
      ? value.status
      : "current";

  return {
    doc,
    type,
    primary_sources: uniqSort(primary_sources),
    related_sources: uniqSort(related_sources),
    docs: uniqSort(docs),
    depends_on: uniqSort(depends_on),
    risk: uniqSort(risk),
    status,
    ...(value.cohesive === true ? { cohesive: true } : {}),
  };
}

// Fills any missing fields with safe defaults without reordering the arrays a
// caller supplied (merge semantics, used by updateRegistryEntry).
function ensureEntryDefaults(
  key: string,
  partial: Partial<RegistryEntry>,
): RegistryEntry {
  const doc = partial.doc ?? `docs/features/${key}.md`;
  return {
    doc,
    type: partial.type ?? typeFromDocPath(doc),
    primary_sources: partial.primary_sources ?? [],
    related_sources: partial.related_sources ?? [],
    docs: partial.docs ?? [],
    depends_on: partial.depends_on ?? [],
    risk: partial.risk ?? [],
    status: partial.status ?? "current",
    ...(partial.cohesive === true ? { cohesive: true } : {}),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqSort(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeDocPath(doc: string): string {
  const trimmed = doc.trim().replace(/^\/+/, "");
  return trimmed.startsWith("docs/") ? trimmed : `docs/${trimmed}`;
}

function typeFromDocPath(docPath: string): RegistryEntry["type"] {
  return docPath.replace(/^docs\//, "").startsWith("features/")
    ? "feature"
    : "concept";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
