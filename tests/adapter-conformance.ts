import type { Anchor, LanguageAdapter } from "../src/lib/fingerprint.js";

// The adapter conformance battery: the ONE testable meaning of "precise",
// regardless of language. Every per-symbol adapter (TS today, plans 19–24
// next) must pass all eight behaviors below; a battery the known-good adapter
// fails is a battery bug, and a battery too weak to reject a seeded mutant is
// theater — both are pinned by the runner. The checks are pure functions
// returning violations instead of describe/it blocks precisely so a runner can
// assert green on a real adapter AND red on a deliberately broken one.

export type FileMode = "precise" | "coarse" | "unevaluable";

export interface ConformanceFixtures {
  /** Repo-style path with the language's precise extension. */
  path: string;
  /** ≥2 public symbols with separable signatures, one module-private helper
   *  referenced from exactly one public symbol's body, and module-level
   *  residual content (e.g. a side-effecting call) no anchor covers. */
  base: string;
  /** `base` with only comments / whitespace / formatting changed. */
  formatted: string;
  /** `base` with one public symbol's BODY edited; `symbol` names its anchor. */
  bodyEdit: { content: string; symbol: string };
  /** `base` with the same symbol's declared CONTRACT edited. */
  signatureEdit: { content: string; symbol: string };
  /** `base` with only the module-private helper edited; `symbol` names the
   *  public anchor whose closure must move. */
  helperEdit: { content: string; symbol: string };
  /** `base` with only the residual (un-anchored) content edited. */
  residualEdit: string;
  /** `base` with the public declarations reordered, nothing else. */
  reordered: string;
  /** Content that must not parse. */
  parseError: string;
}

export interface AdapterHarness {
  adapter: LanguageAdapter;
  classify: (path: string, content: string) => FileMode;
  fixtures: ConformanceFixtures;
}

export interface ConformanceViolation {
  rule: string;
  detail: string;
}

const MODULE_KIND = "module";

function preciseOf(anchors: Anchor[]): Anchor[] {
  return anchors.filter((a) => a.kind !== MODULE_KIND);
}

function residualOf(anchors: Anchor[]): Anchor | undefined {
  return anchors.find((a) => a.kind === MODULE_KIND);
}

function named(anchors: Anchor[], name: string): Anchor | undefined {
  return preciseOf(anchors).find((a) => a.name === name);
}

// Anchor-map delta in prose: which ids moved fingerprint/signature, appeared,
// or vanished between two runs. Empty = the sets are identical.
function anchorDelta(before: Anchor[], after: Anchor[]): string[] {
  const a = new Map(before.map((x) => [x.id, x]));
  const b = new Map(after.map((x) => [x.id, x]));
  const notes: string[] = [];
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y) {
      notes.push(`${id} vanished`);
      continue;
    }
    if (x.fingerprint !== y.fingerprint) notes.push(`${id} fingerprint moved`);
    if (x.signature !== y.signature) notes.push(`${id} signature moved`);
  }
  for (const id of b.keys()) {
    if (!a.has(id)) notes.push(`${id} appeared`);
  }
  return notes;
}

// SCIP-shaped descriptor discipline: acks, ownership, drift, and SARIF stay
// byte-identical in shape across languages because every adapter emits ids of
// the form `<path>::<descriptor>` with one of these descriptor suffixes.
const DESCRIPTOR = /^(?:[\w$]+#)?(?:[\w$]+\(\)\.|[\w$]+#|[\w$]+\.|default\.|<module>)$/;

export function checkAdapterConformance(h: AdapterHarness): ConformanceViolation[] {
  const { adapter, classify, fixtures: f } = h;
  const violations: ConformanceViolation[] = [];
  const flag = (rule: string, detail: string) => violations.push({ rule, detail });

  // Rule 0 — fixture shape + descriptor discipline. A malformed fixture must
  // read as a violation, never as a vacuously green battery.
  if (!adapter.matches(f.path)) {
    flag("0-fixture-shape", `adapter does not match ${f.path}`);
    return violations;
  }
  const base = adapter.anchors(f.path, f.base);
  if (preciseOf(base).length < 2) {
    flag("0-fixture-shape", `base must yield ≥2 precise anchors, got ${preciseOf(base).length}`);
  }
  if (!residualOf(base)) {
    flag("0-fixture-shape", "base must yield a residual module anchor");
  }
  for (const symbol of [f.bodyEdit.symbol, f.signatureEdit.symbol, f.helperEdit.symbol]) {
    if (!named(base, symbol)) flag("0-fixture-shape", `symbol "${symbol}" not anchored in base`);
  }
  for (const a of base) {
    const prefix = `${f.path}::`;
    if (!a.id.startsWith(prefix) || !DESCRIPTOR.test(a.id.slice(prefix.length))) {
      flag("0-fixture-shape", `anchor id "${a.id}" is not SCIP-descriptor-shaped`);
    }
  }
  if (named(base, f.bodyEdit.symbol)?.signature === undefined) {
    flag("0-fixture-shape", `symbol "${f.bodyEdit.symbol}" has no separable signature`);
  }
  if (violations.length > 0) return violations; // fixtures broken — rules would mislead

  // Rule 1 — comment/whitespace/format edits move NO fingerprint.
  for (const note of anchorDelta(base, adapter.anchors(f.path, f.formatted))) {
    flag("1-format-invariance", note);
  }

  // Rule 2 — a body edit moves the symbol's fingerprint but not its signature
  // (ackable), and nothing else.
  {
    const after = adapter.anchors(f.path, f.bodyEdit.content);
    const was = named(base, f.bodyEdit.symbol);
    const is = named(after, f.bodyEdit.symbol);
    if (!was || !is) {
      flag("2-body-split", `symbol "${f.bodyEdit.symbol}" missing after body edit`);
    } else {
      if (was.fingerprint === is.fingerprint)
        flag("2-body-split", "body edit did not move the fingerprint");
      if (was.signature === undefined || is.signature === undefined)
        flag("2-body-split", "signature must stay separable across a body edit");
      else if (was.signature !== is.signature)
        flag("2-body-split", "body edit moved the signature — contract misread");
      const others = anchorDelta(base, after).filter((n) => !n.startsWith(was.id));
      for (const note of others) flag("2-body-split", `collateral: ${note}`);
    }
  }

  // Rule 3 — a declared-contract edit moves the signature (never ackable),
  // and nothing else.
  {
    const after = adapter.anchors(f.path, f.signatureEdit.content);
    const was = named(base, f.signatureEdit.symbol);
    const is = named(after, f.signatureEdit.symbol);
    if (!was || !is) {
      flag("3-signature-contract", `symbol "${f.signatureEdit.symbol}" missing after edit`);
    } else {
      if (was.signature === undefined || is.signature === undefined)
        flag("3-signature-contract", "signature must be separable on both sides");
      else if (was.signature === is.signature)
        flag("3-signature-contract", "contract edit did not move the signature");
      if (was.fingerprint === is.fingerprint)
        flag("3-signature-contract", "contract edit did not move the composite");
      const others = anchorDelta(base, after).filter((n) => !n.startsWith(was.id));
      for (const note of others) flag("3-signature-contract", `collateral: ${note}`);
    }
  }

  // Rule 4 — a referenced module-private helper's change moves its public
  // referencer (closure), and nothing else.
  {
    const after = adapter.anchors(f.path, f.helperEdit.content);
    const was = named(base, f.helperEdit.symbol);
    const is = named(after, f.helperEdit.symbol);
    if (!was || !is) {
      flag("4-helper-closure", `symbol "${f.helperEdit.symbol}" missing after helper edit`);
    } else {
      if (was.fingerprint === is.fingerprint)
        flag("4-helper-closure", "private-helper edit did not move its public referencer");
      const others = anchorDelta(base, after).filter((n) => !n.startsWith(was.id));
      for (const note of others) flag("4-helper-closure", `collateral: ${note}`);
    }
  }

  // Rule 5 — content no anchor covers lands in the module residual: editing it
  // moves ONLY the residual anchor.
  {
    const after = adapter.anchors(f.path, f.residualEdit);
    const was = residualOf(base);
    const is = residualOf(after);
    if (!was || !is) {
      flag("5-module-residual", "residual anchor missing across the residual edit");
    } else {
      if (was.fingerprint === is.fingerprint)
        flag("5-module-residual", "residual edit did not move the residual anchor");
      const others = anchorDelta(base, after).filter((n) => !n.startsWith(was.id));
      for (const note of others) flag("5-module-residual", `collateral: ${note}`);
    }
  }

  // Rule 6 — a parse error classifies unevaluable (fail-loud), never silently
  // coarse or precise-with-partial-anchors.
  {
    const mode = classify(f.path, f.parseError);
    if (mode !== "unevaluable") {
      flag("6-parse-error-unevaluable", `parse error classified "${mode}"`);
    }
  }

  // Rule 7 — anchor identity is position-independent: reordering declarations
  // moves nothing.
  for (const note of anchorDelta(base, adapter.anchors(f.path, f.reordered))) {
    flag("7-order-independence", note);
  }

  // Rule 8 — byte-determinism: same content, same anchors, every run; a CRLF +
  // BOM re-encoding of the same logical content changes nothing. The variant is
  // fed RAW (committed blobs reach adapters unnormalized).
  {
    const again = adapter.anchors(f.path, f.base);
    for (const note of anchorDelta(base, again)) flag("8-byte-determinism", `rerun: ${note}`);
    if (JSON.stringify(base) !== JSON.stringify(again)) {
      flag("8-byte-determinism", "rerun output not byte-identical (ordering unstable)");
    }
    const crlfBom = "\uFEFF" + f.base.replace(/\n/g, "\r\n");
    for (const note of anchorDelta(base, adapter.anchors(f.path, crlfBom))) {
      flag("8-byte-determinism", `crlf/bom: ${note}`);
    }
  }

  return violations;
}
