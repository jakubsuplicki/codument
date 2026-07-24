import pc from "picocolors";
import { warmAllAdapters } from "../lib/fingerprint.js";
import { auditRange, type AuditEntry, type HistoryAudit } from "../lib/history-audit.js";
import { assertRootIsRepoToplevel, isGitRepo, resolveWorkspace } from "../lib/git.js";
import { GateError } from "../lib/two-ref.js";

// `codument audit <base>..<head>` — retroactive drift audit over committed
// history: which documented features' sources moved in the range while their
// owning doc got no attention. Informational by contract: findings NEVER change
// the exit code (threshold the counts yourself if you want a gate). Only an
// audit that could not run exits non-zero — a bad range, a broken git, no repo —
// because "could not look" must never read as "no drift".

interface AuditCliOptions {
  json?: boolean;
  root?: string;
  dir?: string;
}

// The machine contract, version-tagged like `doctor --json`. `audit` is the
// discriminant: "ok" means the audit ran and this IS its result; every
// could-not-run (bad range, no repo, unreachable ref, broken git) is a valid
// `{ audit: "unavailable", reason }` shape instead of human text a JSON
// consumer would crash on — and always exits 1, because an audit that could
// not look must never be mistaken for zero drift. `driftedCount` is first-class
// so a consumer can threshold without reimplementing the join.
type AuditJson =
  | ({ version: 1; audit: "ok"; driftedCount: number } & HistoryAudit)
  | { version: 1; audit: "unavailable"; reason: string };

function emitJson(payload: AuditJson): void {
  console.log(JSON.stringify(payload, null, 2));
}

// The range shape is `<base>..<head>` (the `...` spelling is accepted and means
// the same thing: the audit always diffs from the merge-base of the two refs, so
// commits merged in from elsewhere are not misattributed to the range).
export function parseRange(range: string): { base: string; head: string } | null {
  const match = /^([^.]+(?:\.[^.]+)*)\.{2,3}(.*)$/.exec(range);
  if (!match) return null;
  const base = match[1].trim();
  const head = match[2].trim();
  if (!base) return null;
  return { base, head: head === "" ? "HEAD" : head };
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function renderEntry(audit: HistoryAudit, entry: AuditEntry): string[] {
  const lines: string[] = [];
  lines.push(`  ${pc.yellow("■")} ${pc.bold(entry.feature)} — ${entry.doc}`);
  const movedByFile = new Map<string, string[]>();
  for (const move of entry.symbolMoves) {
    const list = movedByFile.get(move.file) ?? [];
    list.push(`${move.symbol} (${move.kind})`);
    movedByFile.set(move.file, list);
  }
  const deleted = new Set(audit.deletedSources);
  for (const file of entry.changedSources) {
    const moves = movedByFile.get(file);
    if (moves) {
      lines.push(`      ${file} :: ${moves.join(", ")}`);
    } else {
      lines.push(`      ${file}${deleted.has(file) ? pc.dim(" (deleted)") : ""}`);
    }
  }
  lines.push(
    `      ${pc.dim(
      entry.docLastTouched === null
        ? "doc never committed"
        : `doc last touched ${shortSha(entry.docLastTouched)}`,
    )}`,
  );
  return lines;
}

export async function auditCommand(range: string, options: AuditCliOptions = {}): Promise<void> {
  const root = options.root ?? options.dir ?? process.cwd();
  // History may contain a language the tree no longer does, so the audit warms
  // EVERY warmable adapter before its synchronous walk.
  await warmAllAdapters();

  const unavailable = (reason: string, humanLine: string): void => {
    if (options.json) emitJson({ version: 1, audit: "unavailable", reason });
    else console.log(pc.red(`  ✗ ${humanLine}`));
    process.exitCode = 1;
  };

  const parsed = parseRange(range);
  if (!parsed) {
    unavailable(
      `not a range: "${range}"`,
      `not a range: "${range}" — expected <baseRef>..<headRef> (e.g. v1.0.0..HEAD)`,
    );
    return;
  }

  if (!isGitRepo(root)) {
    // No history to audit is a could-not-run, not a zero-drift result.
    unavailable("not a git repository", "not a git repository — audit reads committed history");
    return;
  }

  let audit: HistoryAudit;
  try {
    // A subdirectory root produces WRONG answers (everything unmapped), not
    // absent ones — same loud assertion as the live gate. On the human path a
    // GateError (wrong root, unreachable ref, broken git read) surfaces red at
    // the CLI boundary; under --json it stays machine-readable here.
    assertRootIsRepoToplevel(root);
    // History is per-repository: a ref range names one repository's commits, and
    // a workspace has several with independent histories. Refuse rather than
    // audit one member's range as if it were the whole (ADR-016) — run audit
    // inside the member whose history you mean.
    if (resolveWorkspace(root).isWorkspace) {
      throw new GateError(
        `audit cannot range over a workspace of member repositories: a ref range names one repository's history. Run it inside the member repository you mean.`,
        "wrong-topology",
      );
    }
    audit = auditRange(root, parsed.base, parsed.head);
  } catch (err) {
    if (err instanceof GateError && options.json) {
      emitJson({ version: 1, audit: "unavailable", reason: err.message });
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (options.json) {
    // Spelled field-by-field so the key order is part of the contract — the
    // same repo state must serialize byte-identically run over run.
    emitJson({
      version: 1,
      audit: "ok",
      driftedCount: audit.drifted.length,
      base: audit.base,
      head: audit.head,
      baseSha: audit.baseSha,
      headSha: audit.headSha,
      baseEmptyTree: audit.baseEmptyTree,
      baseAmbiguous: audit.baseAmbiguous,
      algo: audit.algo,
      documented: audit.documented,
      drifted: audit.drifted,
      changedSources: audit.changedSources,
      changedDocs: audit.changedDocs,
      deletedSources: audit.deletedSources,
      unmapped: audit.unmapped,
      unevaluable: audit.unevaluable,
      ownershipLints: audit.ownershipLints,
    });
    return;
  }

  console.log(pc.bold("codument audit") + pc.dim(`  ${audit.base}..${audit.head}`));
  console.log();

  if (audit.documented === 0) {
    console.log(pc.yellow("  No registry entries to audit."));
    console.log(
      pc.dim("  Run `npx codument scan` first — audit checks documented features only."),
    );
    return;
  }

  const n = audit.drifted.length;
  const headline = `${n} of ${audit.documented} documented feature(s) drifted in this range`;
  console.log(n === 0 ? pc.green(`  ✓ ${headline}`) : pc.yellow(`  ${headline}`));
  console.log(
    pc.dim(
      `  ${shortSha(audit.baseSha)}..${shortSha(audit.headSha)} · ` +
        `${audit.changedSources} source(s) changed · ${audit.changedDocs} doc(s) changed`,
    ),
  );
  if (audit.baseEmptyTree) {
    console.log(pc.dim("  note: the refs share no common ancestor — audited from an empty tree"));
  }
  if (audit.baseAmbiguous) {
    console.log(
      pc.dim("  note: several merge-bases (criss-cross history) — tie-broke deterministically"),
    );
  }
  console.log();

  for (const entry of audit.drifted) {
    for (const line of renderEntry(audit, entry)) console.log(line);
  }
  if (n > 0) console.log();

  if (audit.unmapped.length > 0) {
    console.log(
      pc.yellow(`  ⚠ ${audit.unmapped.length} changed source(s) have no registry owner — not audited:`),
    );
    for (const file of audit.unmapped) console.log(`      ${file}`);
  }
  if (audit.unevaluable.length > 0) {
    console.log(
      pc.yellow(
        `  ⚠ ${audit.unevaluable.length} file(s) could not be parsed at head — audited whole-file:`,
      ),
    );
    for (const file of audit.unevaluable) console.log(`      ${file}`);
  }
  for (const lint of audit.ownershipLints) {
    console.log(
      pc.yellow(
        `  ⚠ ${lint.file} :: ${lint.descriptor} — ${lint.kind} across ${lint.features.join(", ")}`,
      ),
    );
  }
  if (audit.unmapped.length > 0 || audit.unevaluable.length > 0 || audit.ownershipLints.length > 0) {
    console.log();
  }

  console.log(
    pc.dim("  An audit of ownership drift (source moved, doc did not) — not a quality score."),
  );
}
