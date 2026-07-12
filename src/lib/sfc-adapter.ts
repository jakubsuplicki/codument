import { createHash } from "node:crypto";
import type { Anchor, LanguageAdapter } from "./fingerprint.js";
import {
  classifyTsFile,
  MODULE_ANCHOR_NAME,
  type TsClassification,
  tsAnchors,
} from "./ts-adapter.js";
import { byteNormalize } from "./two-ref.js";

// The single-file-component adapter: `.vue`, `.svelte`, and `.astro` share one
// shape — named top-level blocks, one of which is a script in a language the
// gate already understands. The script block delegates to the EXISTING TS
// engine (fingerprinting, canonicalization, closure, and the signature/body
// split are already built and battle-tested), keyed on the SFC path, so
// `Hero.vue::rotateToken().` is a normal per-symbol anchor. Template and style
// are body-grain pseudo-anchors: a markup tweak is one named, ackable finding —
// never a whole-file wake, never silence.
//
// Block extraction is a small deterministic scanner, not a grammar: top-level
// `<script>`/`<template>`/`<style>` regions (and Astro's `---` frontmatter
// fence) are non-nesting at the top level, so a bounded scanner is
// byte-deterministic and dependency-free. A file the scanner cannot segment
// classifies unevaluable — fail-loud, never guessed.
//
// `<script setup>`, a Svelte instance script, and Astro frontmatter export
// nothing by design: their top-level declarations ARE the component's public
// surface (they are what the template binds), so those blocks extract in the
// TS engine's all-top-level-public mode. A plain Vue `<script>` keeps normal
// export semantics (`export default {...}` is the ADR-014 `default.` anchor).

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type BlockKind = "script" | "template" | "style" | "custom";

interface SfcBlock {
  kind: BlockKind;
  /** The raw tag name (`script`, `template`, `style`, or a custom tag). */
  tag: string;
  /** Raw attribute text from the opening tag (`setup lang="ts"`). */
  attrs: string;
  /** Block content, opening tag exclusive. */
  content: string;
}

interface SfcScan {
  blocks: SfcBlock[];
  /** Markup OUTSIDE any explicit block — Svelte/Astro's implicit template. */
  markup: string;
}

class SfcScanError extends Error {}

// Match a top-level opening tag at `pos` (which must point at "<"). Returns
// the tag name, raw attrs, and the offset just past the ">" — or null when the
// text at `pos` is not a well-formed opening tag.
function readOpenTag(
  source: string,
  pos: number,
): { tag: string; attrs: string; end: number; selfClosing: boolean } | null {
  const m = /^<([A-Za-z][\w-]*)((?:\s[^>]*)?)>/.exec(source.slice(pos));
  if (!m) return null;
  const rawAttrs = m[2] ?? "";
  return {
    tag: m[1],
    attrs: rawAttrs.trim().replace(/\/$/, "").trim(),
    end: pos + m[0].length,
    selfClosing: /\/\s*$/.test(rawAttrs),
  };
}

// Find the matching close tag for `tag` starting at `from`, honoring nested
// same-name OPEN tags (a Vue template legitimately contains nested
// `<template #slot>` elements). Script/style content never legally contains
// its own close tag, so depth handling is only ever exercised for markup tags.
function findClose(source: string, tag: string, from: number): { start: number; end: number } {
  const open = new RegExp(`<${tag}(?=[\\s/>])`, "g");
  const close = new RegExp(`</${tag}\\s*>`, "g");
  let depth = 1;
  let pos = from;
  while (true) {
    close.lastIndex = pos;
    const c = close.exec(source);
    if (!c) throw new SfcScanError(`unclosed <${tag}> block`);
    open.lastIndex = pos;
    let o = open.exec(source);
    // Count intervening opens (not self-closing) before this close.
    while (o && o.index < c.index) {
      const tail = readOpenTag(source, o.index);
      if (tail && !tail.selfClosing) depth++;
      open.lastIndex = o.index + 1;
      o = open.exec(source);
    }
    depth--;
    if (depth === 0) return { start: c.index, end: c.index + c[0].length };
    pos = c.index + c[0].length;
  }
}

// Segment an SFC into its top-level blocks plus loose markup. Astro's
// frontmatter fence (`---` ... `---` at the file head) becomes a script block.
// Throws SfcScanError when the file cannot be segmented confidently.
export function scanSfc(path: string, source: string): SfcScan {
  const blocks: SfcBlock[] = [];
  let text = source;

  if (/\.astro$/.test(path)) {
    const fence = /^(?:\s*)---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (fence) {
      blocks.push({ kind: "script", tag: "script", attrs: "astro-frontmatter", content: fence[1] });
      text = text.slice(fence.index + fence[0].length);
    } else if (/^\s*---/.test(text)) {
      throw new SfcScanError("unterminated frontmatter fence");
    }
  }

  const markupParts: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt === -1) {
      markupParts.push(text.slice(pos));
      break;
    }
    markupParts.push(text.slice(pos, lt));
    // HTML comment at top level → trivia between blocks.
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) throw new SfcScanError("unterminated HTML comment");
      pos = end + 3;
      continue;
    }
    const tagInfo = readOpenTag(text, lt);
    if (!tagInfo) {
      // A stray `<` that opens no tag (loose markup text, `1 < 2` in Svelte
      // expressions). Consume it as markup and continue.
      markupParts.push("<");
      pos = lt + 1;
      continue;
    }
    const isBlockTag = ["script", "template", "style"].includes(tagInfo.tag);
    if (tagInfo.selfClosing) {
      if (isBlockTag) {
        blocks.push({
          kind: tagInfo.tag as BlockKind,
          tag: tagInfo.tag,
          attrs: tagInfo.attrs,
          content: "",
        });
      } else {
        markupParts.push(text.slice(lt, tagInfo.end));
      }
      pos = tagInfo.end;
      continue;
    }
    const closing = findClose(text, tagInfo.tag, tagInfo.end);
    const content = text.slice(tagInfo.end, closing.start);
    if (isBlockTag) {
      blocks.push({
        kind: tagInfo.tag as BlockKind,
        tag: tagInfo.tag,
        attrs: tagInfo.attrs,
        content,
      });
    } else if (/\.vue$/.test(path)) {
      // A Vue top-level non-standard tag is a custom block (`<i18n>`, `<docs>`):
      // pass-through into the residual, per the plan's non-goal.
      blocks.push({
        kind: "custom",
        tag: tagInfo.tag,
        attrs: tagInfo.attrs,
        content,
      });
    } else {
      // Svelte/Astro: any other element IS the component's markup.
      markupParts.push(text.slice(lt, closing.end));
    }
    pos = closing.end;
  }

  const markup = markupParts.join("");
  if (/\.vue$/.test(path) && markup.trim().length > 0) {
    // Vue allows only comments/whitespace between top-level blocks; loose text
    // means the scanner mis-segmented something — refuse rather than guess.
    throw new SfcScanError("content outside any top-level block");
  }
  return { blocks, markup };
}

// Markup-aware trivia folding: HTML comments and inter-tag whitespace are not
// content, so a reformat or a comment reword never moves a markup hash — the
// pseudo-anchor analog of the script side's token-stream invariance.
export function markupHash(markup: string): string {
  const folded = markup
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(folded);
}

// The style analog: CSS comments and formatting are trivia; selectors and
// declarations are content.
function styleHash(css: string): string {
  const folded = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
  return sha256(folded);
}

// A script block extracts in all-public mode unless it is a plain Vue
// `<script>` (normal export semantics: `export default {...}`). Svelte module
// scripts (`context="module"`) do use exports, but their non-exported
// declarations are still the component's module surface — all-public is the
// conservative direction (over-anchors, never silently ignores).
function scriptIsAllPublic(path: string, block: SfcBlock): boolean {
  if (/\.vue$/.test(path)) return /\bsetup\b/.test(block.attrs);
  return true;
}

function scriptBlocksOf(path: string, scan: SfcScan): { text: string; allPublic: boolean } | null {
  const scripts = scan.blocks.filter((b) => b.kind === "script");
  if (scripts.length === 0) return null;
  // Multiple script blocks (`<script>` + `<script setup>`) fold into ONE
  // extraction in source order — the multi-node composite, like an overload
  // run. All-public wins ties: if any block is a setup-style surface, the
  // combined extraction treats the top level as public.
  return {
    text: scripts.map((b) => b.content).join("\n"),
    allPublic: scripts.some((b) => scriptIsAllPublic(path, b)),
  };
}

// Anchor extraction: delegated script symbols + body-grain template./style.
// pseudo-anchors + a residual folding the custom blocks.
function sfcAnchors(path: string, content: string): Anchor[] {
  const scan = scanSfc(path, byteNormalize(content)); // throws SfcScanError → caller classifies
  const anchors: Anchor[] = [];

  const script = scriptBlocksOf(path, scan);
  let scriptResidual: Anchor | undefined;
  if (script) {
    for (const anchor of tsAnchors(path, script.text, { allTopLevelPublic: script.allPublic })) {
      if (anchor.name === MODULE_ANCHOR_NAME) scriptResidual = anchor;
      else anchors.push(anchor);
    }
  }

  // Template: an explicit <template> block (Vue), or the loose markup that IS
  // the template (Svelte/Astro). Body-grain: no signature, always ackable.
  const templates = scan.blocks.filter((b) => b.kind === "template").map((b) => b.content);
  if (scan.markup.trim().length > 0) templates.push(scan.markup);
  if (templates.length > 0) {
    anchors.push({
      id: `${path}::template.`,
      fingerprint: markupHash(templates.join("\n")),
      name: "template",
      kind: "template",
    });
  }

  const styles = scan.blocks.filter((b) => b.kind === "style").map((b) => b.content);
  if (styles.length > 0) {
    anchors.push({
      id: `${path}::style.`,
      fingerprint: styleHash(styles.join("\n")),
      name: "style",
      kind: "style",
    });
  }

  // Residual: the script's own residual (imports, side effects) plus any custom
  // blocks, folded into one `<module>` anchor so nothing changes in silence.
  const customs = scan.blocks.filter((b) => b.kind === "custom");
  if (scriptResidual || customs.length > 0) {
    const parts: string[] = [];
    if (scriptResidual) parts.push(scriptResidual.fingerprint);
    for (const b of customs) parts.push(`${b.tag} ${markupHash(b.content)}`);
    anchors.push({
      id: `${path}::${MODULE_ANCHOR_NAME}`,
      fingerprint: parts.length === 1 && scriptResidual ? scriptResidual.fingerprint : sha256(parts.join("\n")),
      name: MODULE_ANCHOR_NAME,
      kind: "module",
    });
  }

  return anchors;
}

export type SfcFileMode = "precise" | "coarse" | "unevaluable";

export interface SfcClassification {
  mode: SfcFileMode;
  reason: string;
}

// Classify an SFC for the gate: unevaluable when the scanner cannot segment it
// or its script does not parse; precise when any anchor exists (a template or
// style pseudo-anchor is a real per-part anchor); coarse only for an empty
// shell. The script's own classification is consulted so a parse-broken script
// is surfaced, never hashed around.
export function classifySfcFile(path: string, content: string): SfcClassification {
  let scan: SfcScan;
  const normalized = byteNormalize(content);
  try {
    scan = scanSfc(path, normalized);
  } catch (err) {
    return { mode: "unevaluable", reason: (err as Error).message };
  }
  const script = scriptBlocksOf(path, scan);
  if (script) {
    const klass: TsClassification = classifyTsFile(`${path}.ts`, script.text, {
      allTopLevelPublic: script.allPublic,
    });
    if (klass.mode === "unevaluable") {
      return { mode: "unevaluable", reason: `script block: ${klass.reason}` };
    }
  }
  const anchors = sfcAnchors(path, normalized);
  if (anchors.length === 0) return { mode: "coarse", reason: "no anchorable content" };
  const precise = anchors.filter((a) => a.kind !== "module").length;
  return {
    mode: "precise",
    reason: `${precise} component part${precise === 1 ? "" : "s"}`,
  };
}

export const sfcAdapter: LanguageAdapter = {
  language: "sfc",
  matches: (path) => /\.(vue|svelte|astro)$/.test(path),
  anchors: sfcAnchors,
  classify: classifySfcFile,
};
