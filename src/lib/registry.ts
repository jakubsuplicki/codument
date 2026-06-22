import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";

// The v2 registry entry is THE model the analyzers read. It splits the old flat
// `sources` array into owned (`primary_sources`) versus impacted (`related_sources`),
// adds durable `docs`, and carries optional `risk` hints. `status` preserves the
// project's real vocabulary instead of flattening unknown values to "current".
export interface RegistryEntry {
  doc: string;
  type: "feature" | "concept";
  primary_sources: string[];
  related_sources: string[];
  docs: string[];
  depends_on: string[];
  risk: string[];
  last_updated: string;
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

interface LegacyRegistry {
  features?: unknown;
  mappings?: unknown;
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
  registry.features[key] = ensureEntryDefaults(
    key,
    { ...existing, ...entry },
    new Date().toISOString().split("T")[0],
  );
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  return registry;
}

// The normal read path is v2-only. It validates/defaults/sorts v2 entries and
// preserves the status vocabulary; it does NOT read the legacy flat `sources`
// array or the old `mappings` shape — those are converted once by
// `migrateRegistry` (the only legacy reader). A legacy-only entry therefore
// normalizes to empty `primary_sources`, which `doctor` surfaces and the
// migration fixes.
export function normalizeRegistry(
  input: unknown,
  date = new Date().toISOString().split("T")[0],
): Registry {
  const raw = isRecord(input) ? (input as LegacyRegistry) : {};
  const registry: Registry = { features: {} };

  if (isRecord(raw.features)) {
    for (const [key, value] of Object.entries(raw.features)) {
      const entry = parseEntry(key, value, date, false);
      if (entry) {
        registry.features[key] = entry;
      }
    }
  }

  return registry;
}

export function hasLegacyMappings(input: unknown): boolean {
  return isRecord(input) && isRecord((input as LegacyRegistry).mappings);
}

// True when an entry on disk still uses the flat legacy shape (a `sources` array
// and no v2 ownership fields). Used by the migration to know what to convert.
export function isLegacyEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.sources) &&
    value.primary_sources === undefined &&
    value.related_sources === undefined
  );
}

// True when a registry blob still holds any legacy data the migration must convert.
export function registryNeedsMigration(input: unknown): boolean {
  if (hasLegacyMappings(input)) return true;
  if (isRecord(input) && isRecord((input as LegacyRegistry).features)) {
    return Object.values((input as { features: Record<string, unknown> }).features).some(
      isLegacyEntry,
    );
  }
  return false;
}

/**
 * The one-shot legacy → v2 migration — the ONLY code that reads the legacy flat
 * `sources` array and the old `mappings` shape. It folds a flat `sources` array
 * into `primary_sources` and treats each `mappings` source as owned (primary) by
 * its doc's feature. `changed` reports whether any legacy data was present.
 */
export function migrateRegistry(
  input: unknown,
  date = new Date().toISOString().split("T")[0],
): { registry: Registry; changed: boolean } {
  const changed = registryNeedsMigration(input);
  const raw = isRecord(input) ? (input as LegacyRegistry) : {};
  const registry: Registry = { features: {} };

  if (isRecord(raw.features)) {
    for (const [key, value] of Object.entries(raw.features)) {
      const entry = parseEntry(key, value, date, true);
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
            primary_sources: [],
            related_sources: [],
            docs: [],
            depends_on: [],
            risk: [],
            last_updated: date,
            status: "current",
          } satisfies RegistryEntry);

        if (!existing.primary_sources.includes(source)) {
          existing.primary_sources.push(source);
          existing.primary_sources.sort();
        }
        registry.features[key] = existing;
      }
    }
  }

  return { registry, changed };
}

// Parses one entry into the v2 shape. With allowLegacy, a flat `sources` array
// is folded into `primary_sources` when no v2 ownership field is present (used
// only by migrateRegistry); without it, legacy `sources` is ignored.
function parseEntry(
  key: string,
  value: unknown,
  date: string,
  allowLegacy: boolean,
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

  const primary_sources =
    value.primary_sources !== undefined
      ? stringArray(value.primary_sources)
      : allowLegacy
        ? stringArray(value.sources)
        : [];
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
  const last_updated =
    typeof value.last_updated === "string" && value.last_updated.trim()
      ? value.last_updated
      : date;

  return {
    doc,
    type,
    primary_sources: uniqSort(primary_sources),
    related_sources: uniqSort(related_sources),
    docs: uniqSort(docs),
    depends_on: uniqSort(depends_on),
    risk: uniqSort(risk),
    last_updated,
    status,
    ...(value.cohesive === true ? { cohesive: true } : {}),
  };
}

// Fills any missing v2 fields with safe defaults without reordering the arrays a
// caller supplied (merge semantics, used by updateRegistryEntry).
function ensureEntryDefaults(
  key: string,
  partial: Partial<RegistryEntry>,
  date: string,
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
    last_updated: date,
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
