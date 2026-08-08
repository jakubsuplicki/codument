import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import {
  ACKS_DIR,
  type Acknowledgment,
  ackCovers,
  ackFileName,
  isFileGrainAck,
  isIndependent,
  readAcks,
  writeAck,
} from "../lib/acknowledgment.js";
import {
  type AckValidity,
  type AnchorChange,
  ackValidity,
  fileContentTransition,
  gatherAnchorChanges,
  isSignatureMove,
  warmAdaptersForRepo,
} from "../lib/fingerprint.js";
import {
  getGitAuthor,
  getWorkingTreeChanges,
  getWorkingTreeRenames,
  renamedFromMap,
  resolveWorkspace,
} from "../lib/git.js";
import { resolveOwner } from "../lib/ownership.js";
import { type Registry, readRegistrySync } from "../lib/registry.js";
import { emitAck, emitAckRemove } from "../lib/review-events.js";
import { resolveBase, worktreeChangesSince, worktreeRenamesSince } from "../lib/two-ref.js";

// `codument ack` — the reachable surface for the agent-judge loop. When a review
// finding is a pure-internal refactor that owes no doc change, the agent records a
// fingerprint-bound, auto-invalidating decision here instead of writing a junk
// mirror sentence to clear the gate. The command recomputes the exact `from`->`to`
// transition itself (against the same base ref `review` used), so the agent never
// copies a fingerprint — it runs the line `review` prints, or names the symbol.

// Where each moved file's base content lived, resolved exactly as `review` resolves
// it — same listers, same move filter, same map. `ack` reads base blobs for a living,
// so it has to answer "did this file move?" the same way the surface that printed the
// command did: when it did not, a `git mv` made `review` say `changed` and print an
// ack, while `ack` saw a file that never existed at that path, called it `added`, and
// refused its own instruction. Advisory: a rename lister that cannot answer leaves the
// map empty, which is exactly the pre-rename behavior.
function renamedFromFor(root: string, base?: string): Map<string, string> {
  try {
    return base
      ? renamedFromMap(worktreeRenamesSince(root, base), new Set(worktreeChangesSince(root, base)))
      : renamedFromMap(getWorkingTreeRenames(root), new Set(getWorkingTreeChanges(root)));
  } catch {
    return new Map();
  }
}

export interface AckCliOptions {
  reason?: string;
  base?: string;
  signer?: string;
  list?: boolean;
  json?: boolean;
  remove?: string;
  root?: string;
}

// Versioned machine contract for `ack --list --json`: the recorded audit trail as
// data, so a human or CI can query the ack-rate the trust model rests on. Validity
// is RECOMPUTED per render (never a stored status), so an auto-invalidated ack is
// visible as such. Independence is deliberately absent — it is a property of an ack
// relative to a specific change's author, surfaced in the review card where that
// author is known, not here where there is no single change in view.
export interface AckJson {
  /** The stable handle (`--remove <handle>`), the ack file's digest stem. */
  handle: string;
  /** The full anchor id: `<path>::<descriptor>` (symbol) or `<path>` (file-grain). */
  anchorId: string;
  /** The file the ack vouches for. */
  path: string;
  /** The symbol descriptor for a per-symbol ack; null for a file-grain ack. */
  symbol: string | null;
  grain: "symbol" | "file";
  /** The fingerprint transition the ack is bound to. */
  from: string;
  to: string;
  reason: string;
  signer: string;
  /** Recomputed against the working tree this run, never trusted from disk. */
  validity: AckValidity;
}

export interface AckListJson {
  version: 1;
  acks: AckJson[];
}

const short = (fp: string): string => fp.slice(0, 8);
const handleOf = (ack: Acknowledgment): string => ackFileName(ack).replace(/\.json$/, "");

function fail(message: string): void {
  console.error(`codument ack: ${message}`);
  process.exitCode = 1;
}

export async function ackCommand(anchor: string | undefined, options: AckCliOptions): Promise<void> {
  const root = options.root ?? process.cwd();
  // Recording and re-validating acks parses worktree content synchronously;
  // warm whatever grammar the repo's files need first.
  await warmAdaptersForRepo(root);

  if (options.list) {
    if (options.json) listAcksJson(root);
    else listAcks(root);
    return;
  }
  if (options.remove !== undefined) {
    removeAck(root, options.remove);
    return;
  }

  // A `--base` ack ranges against one ref, which cannot name a workspace of
  // member repositories: the outer repo's merge-base sha is not a ref any member
  // knows, so a symbol that genuinely moved would read as "nothing to ack" (the
  // routed member read fails, the finding is silently omitted). Refuse by name,
  // the same wrong-topology stance review/audit/hooks take, before resolveBase.
  // A worktree-grain ack (no `--base`) routes HEAD per member and works fine.
  if (options.base && resolveWorkspace(root).isWorkspace) {
    fail(
      "--base cannot ack against a workspace of member repositories: a single ref names one repository, not the tuple of member heads. Run the ack inside the member repository whose history you mean.",
    );
    return;
  }

  if (!anchor) {
    fail('an anchor is required: codument ack <path>::<symbol> --reason "..."');
    return;
  }
  if (!options.reason || options.reason.trim().length === 0) {
    fail(
      "--reason is required — name the contract that stayed constant " +
        '(e.g. "renamed a local; same inputs/outputs"), not a bare "refactor"',
    );
    return;
  }
  const sep = anchor.indexOf("::");
  if (sep === -1) {
    // A bare path (no `::descriptor`) is a file-grain ack: it vouches for the whole
    // file's current content, clearing additive / concept / coarse staleness a
    // per-symbol ack cannot reach — while never masking a moved symbol.
    ackFile(root, anchor, options);
    return;
  }
  const file = anchor.slice(0, sep);
  const symbol = anchor.slice(sep + 2);

  let baseRef = "HEAD";
  if (options.base) {
    try {
      baseRef = resolveBase(root, options.base, "HEAD").sha;
    } catch (err) {
      fail((err as Error).message);
      return;
    }
  }

  const renamedFrom = renamedFromFor(root, options.base);
  const { anchorChanges, unevaluable } = gatherAnchorChanges(root, baseRef, [file], renamedFrom);
  if (unevaluable.includes(file)) {
    fail(`${file} does not parse — fix the parse error before acking`);
    return;
  }
  const changes = anchorChanges[file] ?? [];
  if (changes.length === 0) {
    fail(
      `no moved symbols in ${file} against ${options.base ? `merge-base with ${options.base}` : "HEAD"} — nothing to ack`,
    );
    return;
  }

  const match = resolveAnchor(anchor, symbol, changes);
  if (!match.ok) {
    fail(match.error);
    return;
  }
  const ch = match.change;
  if (ch.kind !== "changed" || ch.from === undefined || ch.to === undefined) {
    // Name the resolution that actually applies: an added/removed symbol has no
    // per-symbol transition to ack; the documented alternative is a doc update
    // or the FILE-grain ack over the additive residue.
    const file = ch.id.split("::")[0];
    fail(
      `${ch.id} was ${ch.kind}, not changed — an added or removed symbol needs doc attention: ` +
        `update the owning doc, or acknowledge the file's additive residue with ` +
        `\`codument ack ${file} --reason "..."\``,
    );
    return;
  }
  if (isSignatureMove(ch)) {
    // The highest-signal refusal (ADR 006): a public signature moved, so the
    // symbol's CONTRACT changed. No ack — per-symbol or file-grain — clears it;
    // the owning doc's contract needs an update. A body-only move stays ackable.
    fail(
      `${ch.id}'s signature changed — the symbol's contract moved, so no ack applies: ` +
        `update the owning doc's contract at intent altitude. ` +
        `(An implementation-only body change would still be ackable.)`,
    );
    return;
  }

  const author = getGitAuthor(root) ?? "agent";
  const signer = options.signer ?? author;
  const ack: Acknowledgment = {
    anchorId: ch.id,
    fromHash: ch.from,
    toHash: ch.to,
    reason: options.reason.trim(),
    signer,
  };
  writeAck(root, ack);
  const kind = isIndependent(ack, author) ? "independent" : "self";
  emitAck(root, { ...ack, kind });

  console.log(
    `${pc.green("✓")} acknowledged ${pc.bold(ch.id)} ${pc.dim(
      `(${short(ch.from)}→${short(ch.to)}, ${kind})`,
    )}`,
  );
  console.log(`  ${pc.dim("reason:")} ${ack.reason}`);
  console.log(`  ${pc.dim(`signer: ${signer} · handle ${handleOf(ack)}`)}`);
  console.log(pc.dim("  Re-run `codument review` to confirm the finding cleared."));
}

// `codument ack <path>` — the file-grain surface. A purely-additive change (a new
// exported helper) or a concept doc (whose ownership is file-grain, no per-symbol
// anchor) has no symbol to ack; without this, the only way to clear the gate is to
// touch the doc (a weak, non-fingerprint-bound `last_reviewed` bump). This records a
// real, attributed, fingerprint-bound decision that the file's CURRENT content owes
// no doc change, bound to the file's content transition so it auto-invalidates on the
// next change to the file — exactly like a symbol ack. It never masks a moved symbol:
// any still-unacknowledged moved anchor is named so it is resolved properly.
function ackFile(root: string, file: string, options: AckCliOptions): void {
  const baseLabel = options.base ? `merge-base with ${options.base}` : "HEAD";
  let baseRef = "HEAD";
  if (options.base) {
    try {
      baseRef = resolveBase(root, options.base, "HEAD").sha;
    } catch (err) {
      fail((err as Error).message);
      return;
    }
  }

  // A parse-unevaluable file is never acked into freshness (the fail-loud stance the
  // symbol path also takes) — fix the parse error, then ack.
  const renamedFrom = renamedFromFor(root, options.base);
  const { anchorChanges, unevaluable } = gatherAnchorChanges(root, baseRef, [file], renamedFrom);
  if (unevaluable.includes(file)) {
    fail(`${file} does not parse — fix the parse error before acking`);
    return;
  }

  const { from, to } = fileContentTransition(root, baseRef, file, renamedFrom.get(file) ?? file);
  if (from === null && to === null) {
    fail(`${file} is absent at ${baseLabel} and in the working tree — nothing to ack`);
    return;
  }
  if (from === null || to === null) {
    // Name the resolution that applies to each case, so the error is a signpost:
    // a new file needs an owner (materialize) and narration; a removed file owes
    // its doc an update — or the doc's own removal — never an ack (ADR-012).
    fail(
      from === null
        ? `${file} was added, not changed — a new file needs an owner and doc attention: \`codument map materialize ${file}\`, then narrate it (no ack applies)`
        : `${file} was deleted, not changed — a removal owes its owning doc an update (or remove the doc with its feature); no acknowledgment clears a deletion`,
    );
    return;
  }
  if (from === to) {
    fail(`${file} content is unchanged against ${baseLabel} — nothing to ack`);
    return;
  }

  const author = getGitAuthor(root) ?? "agent";
  const signer = options.signer ?? author;
  const ack: Acknowledgment = {
    anchorId: file,
    fromHash: from,
    toHash: to,
    reason: options.reason!.trim(),
    signer,
  };
  writeAck(root, ack);
  const kind = isIndependent(ack, author) ? "independent" : "self";
  emitAck(root, { ...ack, kind });

  console.log(
    `${pc.green("✓")} acknowledged file ${pc.bold(file)} ${pc.dim(
      `(${short(from)}→${short(to)}, ${kind})`,
    )}`,
  );
  console.log(`  ${pc.dim("reason:")} ${ack.reason}`);
  console.log(`  ${pc.dim(`signer: ${signer} · handle ${handleOf(ack)}`)}`);

  // Guide, don't blanket: a file ack never clears a moved OWNED symbol. Name any
  // still-unacknowledged moved anchor that a feature owns (so it stays flagged) so it
  // is resolved (doc update or a per-symbol ack) rather than mistaken for covered. An
  // unowned move (a concept-only file) is fully cleared by the file ack, so it is not
  // warned about; a non-precise file has no per-symbol anchors at all.
  const acks = readAcks(root);
  let registry: Registry | null = null;
  try {
    registry = readRegistrySync(join(root, "docs", ".registry.json"));
  } catch {
    registry = null; // no registry → nothing is owned/gated → no guidance to give
  }
  const stillMoved = !registry
    ? []
    : (anchorChanges[file] ?? []).filter(
        (ch) =>
          ch.kind === "changed" &&
          ch.from !== undefined &&
          ch.to !== undefined &&
          resolveOwner(registry as Registry, ch.id).kind === "owned" &&
          !acks.some((a) => ackCovers(a, ch.id, ch.from as string, ch.to as string)),
      );
  if (stillMoved.length > 0) {
    const sigMoved = stillMoved.filter((ch) => isSignatureMove(ch));
    const bodyMoved = stillMoved.filter((ch) => !isSignatureMove(ch));
    console.log();
    console.log(
      pc.yellow(`  ⚠ ${stillMoved.length} moved symbol(s) here are NOT cleared by a file ack:`),
    );
    for (const ch of stillMoved) {
      const tag = isSignatureMove(ch) ? pc.dim(" (signature changed)") : "";
      console.log(`      ${pc.dim("•")} ${ch.id}${tag}`);
    }
    // Route each class to the resolution that actually applies. A body-only move
    // can be a per-symbol ack if it changed no contract; a signature move owes a
    // doc-contract update — no ack (per-symbol or file-grain) clears it, so never
    // suggest one for it.
    if (bodyMoved.length > 0) {
      console.log(
        pc.dim(
          "    Body-only moves: update the owning doc, or codument ack <path>::<symbol> each.",
        ),
      );
    }
    if (sigMoved.length > 0) {
      console.log(
        pc.dim(
          "    Signature moves: update the owning doc's contract at intent altitude (no ack applies).",
        ),
      );
    }
  }
  // Make the API growth visible: an added/removed OWNED export IS cleared by this
  // file ack (additive residue), but it changed the surface — surface it (info-only,
  // not a warning) so the vouch is a conscious call, not a silent sweep.
  const clearedExports = !registry
    ? []
    : (anchorChanges[file] ?? []).filter(
        (ch) => ch.kind !== "changed" && resolveOwner(registry as Registry, ch.id).kind === "owned",
      );
  if (clearedExports.length > 0) {
    console.log();
    console.log(
      pc.dim(
        `  This file ack cleared ${clearedExports.length} added/removed export(s) — confirm they owe no doc line:`,
      ),
    );
    for (const ch of clearedExports) console.log(`      ${pc.dim(`• ${ch.name} (${ch.kind})`)}`);
  }
  console.log(pc.dim("  Re-run `codument review` to confirm the finding cleared."));
}

type Resolved = { ok: true; change: AnchorChange } | { ok: false; error: string };

// Resolve which moved anchor an `ack` argument refers to. The canonical path is the
// exact `<path>::<descriptor>` id `review` prints. As a convenience a bare symbol
// NAME is also accepted and matched against the moved-anchor display names —
// failing loud (listing the candidate descriptors) on a real collision rather than
// guessing, the same anti-ambiguity stance the ownership resolver takes.
function resolveAnchor(fullId: string, symbol: string, changes: AnchorChange[]): Resolved {
  const exact = changes.find((c) => c.id === fullId);
  if (exact) return { ok: true, change: exact };
  const byName = changes.filter((c) => c.name === symbol);
  if (byName.length === 1) return { ok: true, change: byName[0] };
  const moved = changes.map((c) => `  - ${c.id}`).join("\n");
  if (byName.length === 0) {
    return { ok: false, error: `no moved symbol "${symbol}" found. Moved anchors:\n${moved}` };
  }
  return {
    ok: false,
    error: `"${symbol}" is ambiguous — pass the full descriptor:\n${byName
      .map((c) => `  - ${c.id}`)
      .join("\n")}`,
  };
}

// Recompute each ack's standing against the working tree and shape it for the
// machine contract — one place both the human and `--json` renderers read, so they
// can never disagree about validity.
function ackToJson(root: string, ack: Acknowledgment): AckJson {
  const sep = ack.anchorId.indexOf("::");
  const fileGrain = isFileGrainAck(ack);
  return {
    handle: handleOf(ack),
    anchorId: ack.anchorId,
    path: fileGrain ? ack.anchorId : ack.anchorId.slice(0, sep),
    symbol: fileGrain ? null : ack.anchorId.slice(sep + 2),
    grain: fileGrain ? "file" : "symbol",
    from: ack.fromHash,
    to: ack.toHash,
    reason: ack.reason,
    signer: ack.signer,
    validity: ackValidity(root, ack),
  };
}

// The dim tag a non-covering ack carries in the human list — an invalidated ack is
// dead weight the user can `--remove`; an indeterminate one flags an unparseable
// file to fix. A covering ack (the common case) stays unadorned.
function validityTag(v: AckValidity): string {
  if (v === "covering") return "";
  return v === "invalidated"
    ? pc.yellow(" (auto-invalidated — the anchor moved past it; codument ack --remove)")
    : pc.dim(" (indeterminate — the file does not parse)");
}

function listAcks(root: string): void {
  const acks = readAcks(root);
  if (acks.length === 0) {
    console.log(pc.dim("No acknowledgments recorded."));
    return;
  }
  console.log(pc.bold(`Acknowledgments (${acks.length})`));
  for (const a of acks) {
    const validity = ackValidity(root, a);
    console.log(
      `  ${pc.bold(handleOf(a))}  ${a.anchorId} ${pc.dim(
        `(${short(a.fromHash)}→${short(a.toHash)})`,
      )}${validityTag(validity)}`,
    );
    console.log(`    ${pc.dim(`${a.signer}:`)} ${a.reason}`);
  }
}

function listAcksJson(root: string): void {
  const payload: AckListJson = {
    version: 1,
    acks: readAcks(root).map((a) => ackToJson(root, a)),
  };
  console.log(JSON.stringify(payload, null, 2));
}

function removeAck(root: string, handle: string): void {
  const path = join(root, ACKS_DIR, `${handle}.json`);
  if (!existsSync(path)) {
    fail(`no acknowledgment with handle "${handle}" (codument ack --list to see handles)`);
    return;
  }
  const match = readAcks(root).find((a) => handleOf(a) === handle);
  rmSync(path, { force: true });
  emitAckRemove(root, handle, match?.anchorId ?? null);
  console.log(`${pc.green("✓")} removed acknowledgment ${pc.bold(handle)}`);
}
