import type { Registry } from "./registry.js";

// Symbol-grained ownership, derived-first. An anchor's owning feature is what the
// gate wakes when that anchor moves. Ownership is derived from `primary_sources`
// (owned), never `related_sources` (merely impacted): a file owned by exactly one
// feature needs zero authoring — that feature owns all its symbols, including the
// `<module>` residual backstop. Only a file shared across several FEATURES needs a
// per-symbol owner map (`owned_symbols`) to say which feature owns which symbol;
// the gate fails loud (never silently wakes all co-owners) on a shared symbol no
// feature claims. This is what actually dissolves the shared-file cascade.
//
// Per-symbol ownership is a FEATURE concept. A `concept`-type entry (e.g. the
// `lib` umbrella that narrates a whole directory file-by-file) is NOT a per-symbol
// owner: it co-documents at file grain and is woken by a coarse whole-file change
// in the wiring layer, never fragmenting a feature's symbol ownership nor counting
// toward `unassigned`/`ambiguous`. So a file owned by exactly one feature plus any
// number of concept umbrellas still resolves derived (zero authoring); only a file
// in two+ FEATURES' primary_sources is a genuine split.

// Splits an anchor id (`<path>::<descriptor>`) into its file path and descriptor
// tail. Repo-relative source paths never contain "::", so the first occurrence is
// the boundary; an id with no "::" is treated as a bare path (empty descriptor).
export function splitAnchorId(id: string): { path: string; descriptor: string } {
  const i = id.indexOf("::");
  if (i < 0) return { path: id, descriptor: "" };
  return { path: id.slice(0, i), descriptor: id.slice(i + 2) };
}

export type OwnershipResolution =
  | { kind: "owned"; feature: string }
  | { kind: "unowned" }
  | { kind: "unassigned"; candidates: string[] }
  | { kind: "ambiguous"; owners: string[] };

// Resolves which feature OWNS an anchor:
//   - file in exactly one feature's primary_sources -> that feature (derived)
//   - file in no feature's primary_sources           -> unowned
//   - file shared across N>1 features -> consult each candidate's owned_symbols:
//       exactly one claims the descriptor -> owned
//       none claim it                     -> unassigned (lint / fail-loud)
//       two or more claim it              -> ambiguous (lint / fail-loud)
export function resolveOwner(registry: Registry, anchorId: string): OwnershipResolution {
  const { path, descriptor } = splitAnchorId(anchorId);

  // Only FEATURE entries are per-symbol owners; concept umbrellas are handled at
  // file grain by the wiring and never fragment ownership.
  const candidates: string[] = [];
  for (const [key, entry] of Object.entries(registry.features)) {
    if (entry.type === "feature" && entry.primary_sources.includes(path)) {
      candidates.push(key);
    }
  }
  candidates.sort();

  if (candidates.length === 0) return { kind: "unowned" };
  if (candidates.length === 1) return { kind: "owned", feature: candidates[0] };

  const claimers = candidates.filter((key) =>
    (registry.features[key].owned_symbols?.[path] ?? []).includes(descriptor),
  );
  if (claimers.length === 1) return { kind: "owned", feature: claimers[0] };
  if (claimers.length === 0) return { kind: "unassigned", candidates };
  return { kind: "ambiguous", owners: claimers };
}
