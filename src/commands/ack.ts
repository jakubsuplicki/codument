import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import {
  gatherAnchorChanges,
  type AnchorChange,
} from "../lib/fingerprint.js";
import {
  ACKS_DIR,
  ackFileName,
  isIndependent,
  readAcks,
  writeAck,
  type Acknowledgment,
} from "../lib/acknowledgment.js";
import { getGitAuthor } from "../lib/git.js";
import { resolveBase } from "../lib/two-ref.js";
import { emitAck, emitAckRemove } from "../lib/review-events.js";

// `codument ack` — the reachable surface for the agent-judge loop. When a review
// finding is a pure-internal refactor that owes no doc change, the agent records a
// fingerprint-bound, auto-invalidating decision here instead of writing a junk
// mirror sentence to clear the gate. The command recomputes the exact `from`->`to`
// transition itself (against the same base ref `review` used), so the agent never
// copies a fingerprint — it runs the line `review` prints, or names the symbol.

export interface AckCliOptions {
  reason?: string;
  base?: string;
  signer?: string;
  list?: boolean;
  remove?: string;
  root?: string;
}

const short = (fp: string): string => fp.slice(0, 8);
const handleOf = (ack: Acknowledgment): string => ackFileName(ack).replace(/\.json$/, "");

function fail(message: string): void {
  console.error(`codument ack: ${message}`);
  process.exitCode = 1;
}

export function ackCommand(anchor: string | undefined, options: AckCliOptions): void {
  const root = options.root ?? process.cwd();

  if (options.list) {
    listAcks(root);
    return;
  }
  if (options.remove !== undefined) {
    removeAck(root, options.remove);
    return;
  }

  if (!anchor) {
    fail('an anchor is required: codument ack <path>::<symbol> --reason "..."');
    return;
  }
  if (!options.reason || options.reason.trim().length === 0) {
    fail(
      '--reason is required — name the contract that stayed constant ' +
        '(e.g. "renamed a local; same inputs/outputs"), not a bare "refactor"',
    );
    return;
  }
  const sep = anchor.indexOf("::");
  if (sep === -1) {
    fail(`anchor must be <path>::<symbol> (got "${anchor}")`);
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

  const { anchorChanges, unevaluable } = gatherAnchorChanges(root, baseRef, [file]);
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
    fail(
      `${ch.id} was ${ch.kind}, not changed — an added or removed symbol needs doc attention, not an ack`,
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

function listAcks(root: string): void {
  const acks = readAcks(root);
  if (acks.length === 0) {
    console.log(pc.dim("No acknowledgments recorded."));
    return;
  }
  console.log(pc.bold(`Acknowledgments (${acks.length})`));
  for (const a of acks) {
    console.log(
      `  ${pc.bold(handleOf(a))}  ${a.anchorId} ${pc.dim(`(${short(a.fromHash)}→${short(a.toHash)})`)}`,
    );
    console.log(`    ${pc.dim(`${a.signer}:`)} ${a.reason}`);
  }
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
