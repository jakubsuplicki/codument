import type { AnchorChangeKind } from "./fingerprint.js";

// Symbol-scoped doc co-movement — an INFO-ONLY telemetry signal (decided
// 2026-06-27), never a verdict input. The deterministic drift verdict already
// lives in the change-state (an owned symbol moved AND its owning doc file did not
// change); whether the doc still DESCRIBES the symbol correctly is a judgment the
// agent in the loop makes. This computes a cheap proxy — "did the doc lines that
// mention the moved symbol change?" — that we LOG for the soak (to measure its
// real false-fire rate before anyone considers gating on it). It is deliberately
// symbol-scoped, not "any prose hash differs", so it is not vacuous under the
// agent-regenerates-the-whole-doc workflow. Known soft spots (why it is telemetry,
// not a gate): default exports (the literal name never appears in prose), symbols
// named like common words, and renames.

// Strip a leading YAML frontmatter block (so a `last_updated` bump never counts).
function stripFrontmatter(md: string): string {
  const m = /^\uFEFF?---\n[\s\S]*?\n---[ \t]*\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

// `[text](url)` -> `text`: keep the human-visible link text, drop the churny URL.
function stripLinkUrls(md: string): string {
  return md.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

// Normalize prose to comparable non-empty trimmed lines (frontmatter + link URLs
// stripped, CRLF folded). Cosmetic churn and the date game wash out; real wording
// changes survive.
export function normalizeProse(md: string): string[] {
  return stripLinkUrls(stripFrontmatter(md))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The normalized lines that mention `symbol` as a whole identifier — not as a
// substring of a larger name (so `foo` does not match `foobar`). Markdown
// punctuation / code-span backticks around the name are fine.
export function symbolMentionLines(lines: string[], symbol: string): Set<string> {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(symbol)}(?![A-Za-z0-9_$])`);
  return new Set(lines.filter((l) => re.test(l)));
}

export type ComovementStatus =
  | "co-moved" // the symbol's doc region moved (obligation looks met)
  | "not-referenced" // the doc does not mention the symbol at head
  | "prose-unchanged" // the symbol is mentioned but its doc region did not move
  | "no-doc"; // there is no primary doc to move

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// Classify whether the primary doc co-moved with a moved symbol anchor. Pure.
// `baseDoc`/`headDoc` are the doc's content at the two refs (null = absent there).
// For the `<module>` residual backstop (no named symbol to scope to), pass
// `opts.module` — then any prose movement counts (it is the coarse residual).
export function classifyComovement(
  baseDoc: string | null,
  headDoc: string | null,
  symbol: string,
  change: AnchorChangeKind,
  opts: { module?: boolean } = {},
): ComovementStatus {
  // The symbol exists at head (added/changed) but there is no doc to carry it.
  if (headDoc === null && change !== "removed") return "no-doc";

  const base = baseDoc === null ? [] : normalizeProse(baseDoc);
  const head = headDoc === null ? [] : normalizeProse(headDoc);

  if (opts.module) {
    if (base.length === 0 && head.length === 0) return "no-doc";
    return base.join("\n") !== head.join("\n") ? "co-moved" : "prose-unchanged";
  }

  const baseLines = symbolMentionLines(base, symbol);
  const headLines = symbolMentionLines(head, symbol);
  const moved = !setsEqual(baseLines, headLines);

  if (change === "removed") {
    // The symbol is gone at head; the doc should drop/adjust its mention. A change
    // (incl. removal) to the mentioning lines = co-moved; an identical lingering
    // mention = prose-unchanged (a stale reference to a removed symbol).
    if (baseLines.size === 0 && headLines.size === 0) return "not-referenced";
    return moved ? "co-moved" : "prose-unchanged";
  }

  // added / changed: the symbol exists at head and must be referenced AND moved.
  if (headLines.size === 0) return "not-referenced";
  return moved ? "co-moved" : "prose-unchanged";
}
