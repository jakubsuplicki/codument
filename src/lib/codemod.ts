import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FileHash {
  path: string;
  hash: string;
}

export interface MetaFile {
  version: string;
  initialized: string;
  project: Record<string, unknown>;
  lastScan?: Record<string, unknown>;
  fileHashes?: Record<string, string>;
}

export type MergeResult =
  | { action: "overwrite"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "merge"; reason: string };

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function readMeta(root: string): Promise<MetaFile | null> {
  const metaPath = join(root, ".codument-meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(await readFile(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

export async function writeMeta(
  root: string,
  meta: MetaFile,
): Promise<void> {
  const metaPath = join(root, ".codument-meta.json");
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Determines the correct merge strategy for a managed file.
 *
 * - upstream changed + user didn't modify → overwrite
 * - both changed → merge (caller handles section-based merge)
 * - only user changed → skip
 * - no changes → skip
 */
export function decideMergeStrategy(
  upstreamContent: string,
  currentContent: string,
  storedHash: string | undefined,
): MergeResult {
  const upstreamHash = hashContent(upstreamContent);
  const currentHash = hashContent(currentContent);

  // No stored hash means first update — treat current as user-modified
  if (!storedHash) {
    if (currentHash === upstreamHash) {
      return { action: "skip", reason: "already up to date" };
    }
    return { action: "merge", reason: "no prior hash recorded, merging conservatively" };
  }

  const upstreamChanged = upstreamHash !== storedHash;
  const userChanged = currentHash !== storedHash;

  if (!upstreamChanged && !userChanged) {
    return { action: "skip", reason: "no changes" };
  }
  if (upstreamChanged && !userChanged) {
    return { action: "overwrite", reason: "upstream updated, no local modifications" };
  }
  if (!upstreamChanged && userChanged) {
    return { action: "skip", reason: "only local modifications, upstream unchanged" };
  }
  // Both changed
  return { action: "merge", reason: "both upstream and local modified" };
}

/**
 * Records the hash of a file's content in the meta file.
 */
export function setFileHash(
  meta: MetaFile,
  relativePath: string,
  content: string,
): void {
  if (!meta.fileHashes) meta.fileHashes = {};
  meta.fileHashes[relativePath] = hashContent(content);
}
