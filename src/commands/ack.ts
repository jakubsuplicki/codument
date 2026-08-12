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
  isTreeGrainAck,
  readAcks,
  shellArg,
  treeSetHash,
  writeAck,
} from "../lib/acknowledgment.js";
import { resolveScopeSync } from "../lib/analyze.js";
import { treeCoverage } from "../lib/change-state.js";
import { anchorGates } from "../lib/drift.js";
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
  getWorkingTreeDeletions,
  getWorkingTreeRenames,
  renamedFromMap,
  resolveWorkspace,
} from "../lib/git.js";
import { resolveOwner, splitAnchorId } from "../lib/ownership.js";
import {
  isSourcePattern,
  normalizeRelPath,
  type Registry,
  readRegistrySync,
  registeredPatterns,
} from "../lib/registry.js";
import { emitAck, emitAckRemove } from "../lib/review-events.js";
import {
  changedLinesAgainst,
  resolveBase,
  worktreeChangesSince,
  worktreeDeletionsSince,
  worktreeRenamesSince,
} from "../lib/two-ref.js";

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
  /** Bind the vouch to the owning doc's claims instead of the file's bytes, so it
   *  stands across content changes and dies when the doc moves. File grain only. */
  standing?: boolean;
  list?: boolean;
  json?: boolean;
  remove?: string;
  prune?: boolean;
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
  /** The full anchor id: `<path>::<descriptor>` (symbol), `<path>` (file-grain), or
   *  the registered pattern (tree-grain). */
  anchorId: string;
  /** The file the ack vouches for; the pattern itself at tree grain. */
  path: string;
  /** The symbol descriptor for a per-symbol ack; null for a file- or tree-grain ack. */
  symbol: string | null;
  grain: "symbol" | "file" | "tree";
  /** Tree grain only: every path this one vouch covered. The width is the trade the
   *  grain makes, so the record is readable rather than a bare digest — an
   *  acknowledgment nobody can audit afterwards is a signature on a blank page. */
  covers?: string[];
  /** File grain, where no adapter can name a symbol: the lines the vouch covered.
   *  The width is the trade this grain makes too, so the record is readable rather
   *  than a bare hash transition — the same rule `covers` holds one grain up. */
  coveredLines?: string[];
  /** Present when the vouch is STANDING: the docs whose claims decide it, and whose
   *  movement ends it. `from`/`to` are then that doc set's hash rather than a content
   *  transition, so a consumer reading the transition alone is told which it is. */
  standing?: { docs: string[] };
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

/** Enough to see what was signed for; a wall of diff is the unreadable surface this
 *  disclosure exists to replace, so the rest is counted rather than printed. */
const COVERED_LINE_CAP = 20;

function fail(message: string): void {
  console.error(`codument ack: ${message}`);
  process.exitCode = 1;
}

export async function ackCommand(
  anchor: string | undefined,
  options: AckCliOptions,
): Promise<void> {
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
  if (options.prune) {
    pruneAcks(root);
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
  // ADR 019 is retired by ADR 020. A standing vouch existed so that a recurring
  // judgment about a body-only change was not re-signed on every unrelated edit —
  // in the field, one locale namespace signed for four times in a session. Under
  // 020 a body-only move is reported and never gated, so that judgment is never
  // requested and there is nothing to stand over. Refused by name rather than
  // quietly ignored: a flag that parses and does nothing is worse than one that is
  // gone, and the reason is the thing worth telling a reader who had adopted it.
  // Records already written stay parseable and are labeled obsolete on read.
  if (options.standing) {
    fail(
      "--standing is retired (ADR 020 supersedes ADR 019). It existed so a recurring judgment about a " +
        "body-only change was not re-signed on every unrelated edit; a body-only move is now reported and " +
        "never gates, so no signature is asked for in the first place. Drop the flag: if the change still " +
        "gates, it is an added or removed export, a signature move, a deletion or a risk-declared file, " +
        "and each of those wants a doc update or a plain ack.",
    );
    return;
  }

  const sep = anchor.indexOf("::");
  if (sep === -1) {
    // A glob or trailing-slash directory is a TREE ack: one judgment over every file
    // a registered pattern governs. A bare path (no `::descriptor`) is a file-grain
    // ack: it vouches for the whole file's current content, clearing additive /
    // concept / coarse staleness a per-symbol ack cannot reach — while never masking
    // a moved symbol.
    if (isSourcePattern(anchor)) ackTree(root, anchor, options);
    else ackFile(root, anchor, options);
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
        `\`codument ack ${shellArg(file)} --reason "..."\``,
    );
    return;
  }
  // Who owns this symbol decides whether an ack can do anything at all. Drift
  // consults acknowledgments only for an anchor that resolves to ONE owner, so an
  // ack recorded against a shared symbol no feature claims is inert: it wrote a
  // file, printed "✓ acknowledged … re-run to confirm the finding cleared", and
  // the finding could not clear. A green checkmark over a red gate is worse than a
  // refusal, because it spends the reader's trust in the surface — so refuse, and
  // route to the two registry edits that end the wake, exactly as `review` does.
  // Absent or unreadable registry → nothing is owned, so nothing is gated and
  // there is no guidance to give; the pre-ownership behavior stands.
  let registry: Registry | null = null;
  try {
    registry = readRegistrySync(join(root, "docs", ".registry.json"));
  } catch {
    registry = null;
  }
  const owner = registry ? resolveOwner(registry, ch.id) : null;
  if (owner?.kind === "unowned") {
    // No FEATURE owns the symbol, so no per-symbol ack can clear anything. Which
    // route applies depends on what DOES gate the file: a concept umbrella wakes
    // it whole, and only a file-grain judgment settles that; nothing at all means
    // the ack would be an artifact about a symbol no verdict consults.
    const concept = Object.values(registry?.features ?? {}).some(
      (e) => e.type === "concept" && e.primary_sources.includes(file),
    );
    fail(
      concept
        ? `no feature owns ${ch.id} — it is narrated at file grain by a concept umbrella, which a per-symbol ack never clears: \`codument ack ${shellArg(file)} --reason "..."\``
        : `no feature owns ${ch.id}, so nothing gates it and an ack would clear nothing. If it should be governed, map the file first: \`codument map materialize ${shellArg(file)}\``,
    );
    return;
  }
  if (owner?.kind === "unassigned" || owner?.kind === "ambiguous") {
    const who = owner.kind === "unassigned" ? owner.candidates : owner.owners;
    // The RESOLVED descriptor, not what was typed: a bare symbol name is a valid
    // way to invoke ack, and a fragment echoing it back would not match anything.
    const descriptor = splitAnchorId(ch.id).descriptor;
    fail(
      owner.kind === "unassigned"
        ? `${ch.id} is a shared symbol no feature claims (${who.join(", ")}), so no ack reaches it — ` +
            `the wake is ownership, not doc debt. Claim it under ONE of them in docs/.registry.json ` +
            `("owned_symbols": { ${JSON.stringify(file)}: [${JSON.stringify(descriptor)}] }), or keep one ` +
            `primary owner and move ${file} to the others' related_sources.`
        : `${ch.id} is claimed by ${who.join(" and ")}, so ownership is ambiguous and no ack reaches it — ` +
            `remove the claim from owned_symbols in all but one of them.`,
    );
    return;
  }
  if (isSignatureMove(ch)) {
    // The highest-signal refusal (ADR 006): a public signature moved, so the
    // symbol's CONTRACT changed. No ack — per-symbol or file-grain — clears it;
    // the owning doc's contract needs an update.
    fail(
      `${ch.id}'s signature changed — the symbol's contract moved, so no ack applies: ` +
        `update the owning doc's contract at intent altitude.`,
    );
    return;
  }
  if (!anchorGates(ch)) {
    // ADR 020 retires the per-symbol acknowledgment wherever an adapter reports a
    // signature: a move that is not a signature move is body-only, body-only is
    // reported and never gated, so there is no finding for a signature to clear.
    // Recording one anyway would write precisely the artifact this release exists
    // to stop producing — a vouch nobody reads back, over a question nobody asked.
    // Refused rather than accepted-and-inert, on the same principle as every other
    // refusal here: a green checkmark over a gate that never moved spends the
    // reader's trust in everything else the surface says.
    fail(
      `${ch.id} is a body-only move — implementation changed, and no documented contract can have gone ` +
        `stale from it, so it is reported and never gates (ADR 020). There is nothing here to acknowledge. ` +
        `If behaviour a doc actually describes did change, that is a doc update, not a signature.`,
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
        ? `${file} was added, not changed — a new file needs an owner and doc attention: \`codument map materialize ${shellArg(file)}\`, then narrate it (no ack applies)`
        : `${file} was deleted, not changed — a removal owes its owning doc an update (or remove the doc with its feature); no acknowledgment clears a deletion`,
    );
    return;
  }
  if (from === to) {
    fail(`${file} content is unchanged against ${baseLabel} — nothing to ack`);
    return;
  }

  // What this vouch actually covers, where no adapter can name it in symbols. A
  // hash transition discloses nothing, so a reason that is true about one part of
  // the file buys silence over every other part — which is how a rules change
  // making private data world-readable rode a comment ack to a green, signed gate.
  // Named BEFORE the signature is taken, and recorded with it, on exactly the
  // principle tree grain already holds: an acknowledgment nobody can read
  // afterwards is a signature on a blank page.
  const symbolic = (anchorChanges[file] ?? []).length > 0;
  const coveredLines = symbolic
    ? undefined
    : changedLinesAgainst(root, baseRef, file, renamedFrom.get(file) ?? file);
  if (coveredLines && coveredLines.length > 0) {
    console.log(
      pc.yellow(`  This ack covers every change in ${file} — ${coveredLines.length} line(s):`),
    );
    for (const l of coveredLines.slice(0, COVERED_LINE_CAP)) console.log(`      ${pc.dim(l)}`);
    if (coveredLines.length > COVERED_LINE_CAP) {
      console.log(pc.dim(`      … +${coveredLines.length - COVERED_LINE_CAP} more`));
    }
    console.log();
  }

  let registry: Registry | null = null;
  try {
    registry = readRegistrySync(join(root, "docs", ".registry.json"));
  } catch {
    registry = null; // no registry → nothing is owned/gated → no guidance to give
  }

  const author = getGitAuthor(root) ?? "agent";
  const signer = options.signer ?? author;
  const ack: Acknowledgment = {
    anchorId: file,
    fromHash: from,
    toHash: to,
    reason: options.reason!.trim(),
    signer,
    ...(coveredLines && coveredLines.length > 0 ? { coveredLines } : {}),
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
  const stillMoved = !registry
    ? []
    : (anchorChanges[file] ?? []).filter(
        (ch) =>
          ch.kind === "changed" &&
          ch.from !== undefined &&
          ch.to !== undefined &&
          // Only a move that still GATES belongs in a warning about what this vouch
          // failed to clear. A body-only move is not cleared either, but it holds
          // nothing red, so naming it here invents work from a fact the reader can
          // do nothing with — and routes them to a command `ack` now refuses.
          anchorGates(ch) &&
          resolveOwner(registry as Registry, ch.id).kind === "owned" &&
          !acks.some((a) => ackCovers(a, ch.id, ch.from as string, ch.to as string)),
      );
  if (stillMoved.length > 0) {
    console.log();
    // The ack that was just written DID what it was asked to do; these symbols were
    // never in its reach. Leading with the failure made a command that fully worked
    // read as a half-failure — and where the remaining symbols belong to a different
    // doc, the reader had already finished the job they came to do.
    console.log(
      pc.yellow(
        `  ⚠ the ack above stands; ${stillMoved.length} moved symbol(s) in this file are NOT cleared by a file ack:`,
      ),
    );
    // The resolution belongs INSIDE the finding it resolves, and it has to be a
    // command rather than a shape to fill in: `codument ack <path>::<symbol>`, dim
    // and last under the warning, was read past twice in one field session before it
    // was acted on. A body-only move keeps the ack route if it changed no contract;
    // a signature move owes a contract update and gets no ack offered at any grain.
    for (const ch of stillMoved) {
      const owner = resolveOwner(registry as Registry, ch.id);
      const doc =
        owner.kind === "owned"
          ? ((registry as Registry).features[owner.feature]?.doc ?? "the owning doc")
          : "the owning doc";
      const sig = isSignatureMove(ch);
      console.log(`      ${pc.dim("•")} ${ch.id}${sig ? pc.dim(" (signature changed)") : ""}`);
      console.log(
        `          ${pc.dim("contract changed →")} update ${doc} ${pc.dim(
          sig
            ? "at intent altitude — no ack of any grain clears a signature move"
            : "at intent altitude",
        )}`,
      );
      if (!sig) {
        console.log(
          `          ${pc.dim("internal only   →")} ${pc.cyan(`codument ack ${shellArg(ch.id)} --reason "..."`)}`,
        );
      }
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

// `codument ack <pattern>` — the tree-grain surface. A registry entry that governs a
// tree answers for it in ONE line: the ack records every file the pattern matched in
// this change, each with the transition it was bound to, and stands only while that
// whole set is unchanged. The alternative was never "many careful judgments" — it was
// a 380-file locale tree nobody registered, because answering for it cost 380
// signatures. The width is real, so it is disclosed rather than hidden: the count is
// stated as it writes, and one file moving again (or a new one appearing) decays it.
function ackTree(root: string, pattern: string, options: AckCliOptions): void {
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

  // Only a pattern some entry DECLARES is ackable. A wide vouch is earned by a
  // committed declaration (ADR 017), never by the argument typed at the prompt —
  // otherwise `codument ack "src/**"` would clear every coarse wake in the repo.
  let registry: Registry | null = null;
  try {
    registry = readRegistrySync(join(root, "docs", ".registry.json"));
  } catch {
    registry = null;
  }
  const governed = registry ? registeredPatterns(registry) : [];
  const tree = normalizeRelPath(pattern);
  if (!governed.includes(tree)) {
    fail(
      `no registry entry declares ${tree} in primary_sources, so a tree ack over it would vouch for files nothing governs — register the tree first, then ack it` +
        (governed.length > 0 ? `. Governed trees: ${governed.join(", ")}` : ""),
    );
    return;
  }
  const owners = Object.values(registry?.features ?? {})
    .filter((e) => e.primary_sources.some((s) => normalizeRelPath(s) === tree))
    .map((e) => e.doc);

  const changes = options.base
    ? worktreeChangesSince(root, options.base)
    : getWorkingTreeChanges(root);
  const deletions = options.base
    ? worktreeDeletionsSince(root, options.base)
    : getWorkingTreeDeletions(root);
  const renamedFrom = renamedFromFor(root, options.base);
  const { files, unresolvable } = treeCoverage(
    root,
    baseRef,
    tree,
    [...changes, ...deletions],
    resolveScopeSync(root).spec,
    renamedFrom,
  );
  if (files.length === 0 && unresolvable.length === 0) {
    fail(`no changed file under ${tree} against ${baseLabel} — nothing to ack`);
    return;
  }
  if (unresolvable.length > 0) {
    // A file that APPEARED in the tree is a new governed unit and a file that left it
    // is a removal: neither has a transition to bind, and both owe the doc a line.
    // Adding a language is the single change in a locale tree most worth seeing, so
    // it is the one thing this grain must never wave through.
    const shown = unresolvable.slice(0, 5).join(", ");
    const rest = unresolvable.length > 5 ? `, +${unresolvable.length - 5} more` : "";
    fail(
      `${unresolvable.length} file(s) under ${tree} were added or removed, not changed — no ack of any grain binds that: ` +
        `update ${owners.join(", ") || "the owning doc"} at intent altitude (${shown}${rest})`,
    );
    return;
  }

  const author = getGitAuthor(root) ?? "agent";
  const signer = options.signer ?? author;
  const ack: Acknowledgment = {
    anchorId: tree,
    fromHash: treeSetHash(files, "from"),
    toHash: treeSetHash(files, "to"),
    reason: options.reason!.trim(),
    signer,
    covered: files,
  };
  writeAck(root, ack);
  const kind = isIndependent(ack, author) ? "independent" : "self";
  emitAck(root, {
    anchorId: ack.anchorId,
    fromHash: ack.fromHash,
    toHash: ack.toHash,
    reason: ack.reason,
    signer,
    kind,
    covers: files.length,
  });

  console.log(
    `${pc.green("✓")} acknowledged tree ${pc.bold(tree)} ${pc.dim(
      `(${files.length} file${files.length === 1 ? "" : "s"}, ${short(ack.fromHash)}→${short(ack.toHash)}, ${kind})`,
    )}`,
  );
  console.log(`  ${pc.dim("reason:")} ${ack.reason}`);
  console.log(`  ${pc.dim(`signer: ${signer} · handle ${handleOf(ack)}`)}`);
  console.log(
    pc.dim(
      `  This one judgment vouches for all ${files.length} — it expires the moment any of them changes again, or a file appears under ${tree}.`,
    ),
  );

  // A tree ack is a file-grain judgment made wholesale, so it clears exactly what a
  // file ack clears and no more: a moved OWNED symbol inside the tree stays flagged.
  // Say so here, or a `src/**` tree would read as having settled a contract change it
  // never touched. Only precise files carry anchors, so a locale tree pays nothing.
  const acks = readAcks(root);
  const stillMoved = !registry
    ? []
    : Object.values(
        gatherAnchorChanges(
          root,
          baseRef,
          files.map((f) => f.path),
          renamedFrom,
        ).anchorChanges,
      )
        .flat()
        .filter(
          (ch) =>
            ch.kind === "changed" &&
            ch.from !== undefined &&
            ch.to !== undefined &&
            // Same rule the file-grain warning holds: only a move that still gates
            // is something this vouch can be said to have left behind.
            anchorGates(ch) &&
            resolveOwner(registry as Registry, ch.id).kind === "owned" &&
            !acks.some((a) => ackCovers(a, ch.id, ch.from as string, ch.to as string)),
        );
  if (stillMoved.length > 0) {
    console.log();
    console.log(
      pc.yellow(
        `  ⚠ the ack above stands; ${stillMoved.length} moved symbol(s) inside this tree are NOT cleared by it:`,
      ),
    );
    for (const ch of stillMoved.slice(0, 10)) {
      const sig = isSignatureMove(ch);
      console.log(`      ${pc.dim("•")} ${ch.id}${sig ? pc.dim(" (signature changed)") : ""}`);
      if (!sig) {
        console.log(
          `          ${pc.dim("internal only →")} ${pc.cyan(`codument ack ${shellArg(ch.id)} --reason "..."`)}`,
        );
      }
    }
    if (stillMoved.length > 10) {
      console.log(
        `      ${pc.dim(`• +${stillMoved.length - 10} more — \`codument review\` lists them all`)}`,
      );
    }
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
  const tree = isTreeGrainAck(ack);
  const fileGrain = isFileGrainAck(ack);
  const bare = tree || fileGrain;
  return {
    handle: handleOf(ack),
    anchorId: ack.anchorId,
    path: bare ? ack.anchorId : ack.anchorId.slice(0, sep),
    symbol: bare ? null : ack.anchorId.slice(sep + 2),
    grain: tree ? "tree" : fileGrain ? "file" : "symbol",
    ...(tree ? { covers: ack.covered?.map((c) => c.path) ?? [] } : {}),
    ...(ack.coveredLines ? { coveredLines: ack.coveredLines } : {}),
    ...(ack.standing ? { standing: { docs: ack.standing.docs } } : {}),
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
function validityTag(v: AckValidity, ack: Acknowledgment): string {
  if (v === "covering") return "";
  if (v === "indeterminate") return pc.dim(" (indeterminate — the file does not parse)");
  // A standing vouch did not decay: nothing moved past it, the mechanism behind it
  // was retired. Saying "the anchor moved past it" would send the reader hunting for
  // a move that never happened, on a record they can only delete.
  if (ack.standing) {
    return pc.yellow(" (auto-invalidated — --standing is retired; codument ack --prune)");
  }
  return pc.yellow(" (auto-invalidated — the anchor moved past it; codument ack --remove)");
}

function listAcks(root: string): void {
  const acks = readAcks(root);
  if (acks.length === 0) {
    console.log(pc.dim("No acknowledgments recorded."));
    return;
  }
  console.log(pc.bold(`Acknowledgments (${acks.length})`));
  let invalidated = 0;
  for (const a of acks) {
    const validity = ackValidity(root, a);
    if (validity === "invalidated") invalidated += 1;
    // A tree ack's width is stated wherever it is shown: "one line, 120 files" is the
    // whole trade, and a reader who has to open the record to learn it will not.
    const covers = isTreeGrainAck(a) ? ` ${pc.dim(`(tree, ${a.covered?.length ?? 0} files)`)}` : "";
    console.log(
      `  ${pc.bold(handleOf(a))}  ${a.anchorId}${covers} ${pc.dim(
        a.standing ? "(standing)" : `(${short(a.fromHash)}→${short(a.toHash)})`,
      )}${validityTag(validity, a)}`,
    );
    console.log(`    ${pc.dim(`${a.signer}:`)} ${a.reason}`);
    // What the record used to answer for, in the past tense it now deserves. The
    // binding is still shown because it is the only thing that explains a signature
    // nobody can find a matching transition for.
    if (a.standing) {
      console.log(
        pc.dim(
          `      was standing on ${a.standing.docs.join(", ")} — the moves it absorbed are no longer asked about`,
        ),
      );
    }
    // The width beside the reason. A file ack over a file no adapter reads covers
    // everything in it, so the audit surface has to show what that was — a reason
    // and a hash transition let a truthful sentence about one line stand in for the
    // whole file, which is exactly how one bought silence over a security rule.
    if (a.coveredLines && a.coveredLines.length > 0) {
      console.log(
        pc.dim(
          `      covered ${a.coveredLines.length} changed line(s): ${a.coveredLines.slice(0, 2).join(" · ")}${a.coveredLines.length > 2 ? ` · +${a.coveredLines.length - 2} more` : ""}`,
        ),
      );
    }
  }
  // Auto-invalidation (ADR 006) is the design working, but it produces dead weight
  // nothing sweeps: a field session finished with 52 of 342 acks invalidated, each
  // carrying its own `--remove` hint that nothing in the loop ever ran. The list is
  // where the pile becomes visible, so it is where the one command that ends it
  // belongs — a per-ack hint fifty-two times is how the pile got there.
  if (invalidated > 0) {
    console.log(
      pc.dim(
        `\n  ${invalidated} of these ${invalidated === 1 ? "is" : "are"} auto-invalidated and clear nothing — \`codument ack --prune\` removes them all.`,
      ),
    );
  }
}

function listAcksJson(root: string): void {
  const payload: AckListJson = {
    version: 1,
    acks: readAcks(root).map((a) => ackToJson(root, a)),
  };
  console.log(JSON.stringify(payload, null, 2));
}

// Sweep every ack the working tree has already moved past. Validity is recomputed
// here exactly as `--list` recomputes it — one function, so the command can never
// remove something the list called covering. It is deliberately narrow: an
// INDETERMINATE ack is not dead, it is unreadable (the file does not parse), and
// deleting it would destroy a judgment on the strength of a parse error the user
// still has to fix. Removals ride the same audit path a manual `--remove` does, so
// a swept ack is as traceable as a hand-removed one.
function pruneAcks(root: string): void {
  const acks = readAcks(root);
  const dead = acks.filter((a) => ackValidity(root, a) === "invalidated");
  if (dead.length === 0) {
    console.log(
      pc.dim(
        acks.length === 0
          ? "No acknowledgments recorded."
          : `Nothing to prune — none of the ${acks.length} recorded acknowledgment(s) is auto-invalidated.`,
      ),
    );
    return;
  }
  for (const a of dead) {
    const handle = handleOf(a);
    rmSync(join(root, ACKS_DIR, `${handle}.json`), { force: true });
    emitAckRemove(root, handle, a.anchorId);
    console.log(`  ${pc.dim("removed")} ${pc.bold(handle)}  ${a.anchorId}`);
  }
  // The count that remains is stated because the point of the sweep is the pile,
  // not the individual ack: "52 removed, 290 still standing" is the shape a reader
  // needs to know the trust surface did not just get quietly smaller.
  const left = acks.length - dead.length;
  console.log(
    `${pc.green("✓")} pruned ${dead.length} auto-invalidated acknowledgment(s); ${left} still recorded`,
  );
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
