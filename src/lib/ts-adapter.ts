import { createHash } from "node:crypto";
import ts from "typescript";
import type { Anchor, LanguageAdapter } from "./fingerprint.js";

// The precise TypeScript adapter: it fingerprints each EXPORTED (globally
// reachable) declaration individually, so editing one symbol in a shared file
// wakes only that symbol's owner — the cascade dissolution. Syntactic parse only
// (no type-checker, which is non-deterministic across machines). Identity is
// SCIP-descriptor-shaped and order-independent, so reordering declarations is a
// no-op. Each export's fingerprint is transitively closed over the same-file,
// non-exported declarations it references (so a private-helper behavior change
// moves its callers), and the file carries a coarse residual backstop anchor for
// module-top-level content no precise anchor covers (imports, side effects,
// unreferenced module state) — so a changed owned file is never read as fresh.

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Token-stream fingerprint of a source span: scan with skipTrivia and feed each
// token's getTokenText() (the literal token text — NOT getTokenValue, NOT
// getText()+regex, which would collapse intra-string whitespace) into the digest.
// Invariant to reformatting, CRLF/LF, BOM, and comment churn, but keeps `0x10` ≠
// `16` and catches changes inside string literals. Each token is length-prefixed
// (`<utf8-byte-count>:<bytes>`), an injective framing that makes the token
// boundary unambiguous without a separator byte — so `a b` (two identifiers) and
// `"a b"` (one string literal) can never collide, and the source stays plain text
// (a NUL separator would make git treat the file as binary and drop line diffs).
function tokenStreamHash(spanText: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    ts.LanguageVariant.Standard,
    spanText,
  );
  const hash = createHash("sha256");
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    const text = scanner.getTokenText();
    hash.update(`${Buffer.byteLength(text, "utf8")}:`);
    hash.update(text, "utf8");
    tok = scanner.scan();
  }
  return hash.digest("hex");
}

// The synthetic identity of the per-file residual backstop anchor. Distinct from
// every real symbol descriptor (no identifier is `<module>`), so it never
// collides with a precise anchor and the ownership/gate slices can recognize it.
export const MODULE_ANCHOR_NAME = "<module>";

export type TsAnchorKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "default"
  | "module";

// SCIP-style descriptor suffix for a name+kind. Order-independent (keyed on the
// name and kind, never the position). Type-like → `Name#`; functions → `name().`;
// terms (variables) → `name.`; the default export keys on the literal `default`;
// the residual backstop keys on the literal `<module>`.
function descriptor(name: string, kind: TsAnchorKind): string {
  switch (kind) {
    case "function":
      return `${name}().`;
    case "class":
    case "interface":
    case "type":
    case "enum":
      return `${name}#`;
    case "default":
      return "default.";
    case "module":
      return "<module>";
    default:
      return `${name}.`;
  }
}

function anchorId(path: string, name: string, kind: TsAnchorKind): string {
  return `${path}::${descriptor(name, kind)}`;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

function spanText(content: string, sf: ts.SourceFile, node: ts.Node): string {
  return content.slice(node.getStart(sf), node.getEnd());
}

// The free identifier names a node references — a lexical, conservative
// over-approximation (no type resolution, so a shadowing local or a colliding
// object-literal key over-includes, which only ever wakes MORE docs, never
// fewer). The two essential exclusions are the member name of a property access
// (`obj.helper`) and the right side of a qualified name (`NS.helper`): those are
// the ubiquitous `.method()`/`NS.Type` forms that would otherwise match a
// same-named top-level declaration on nearly every line. Everything else
// (including computed property names, which DO carry references) is traversed.
function collectFreeIdentifiers(root: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isQualifiedName(node)) {
      visit(node.left);
      return;
    }
    if (ts.isIdentifier(node)) {
      names.add(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return names;
}

// Transitive closure of an export over same-file non-exported declarations it
// references (directly or via other private declarations). Returns the included
// private names sorted, paired with their span text — sorted so the composite
// fingerprint is independent of where the helpers sit in the file.
function closureOf(
  start: ts.Node,
  content: string,
  sf: ts.SourceFile,
  privateByName: Map<string, ts.Node>,
): { name: string; span: string }[] {
  const included = new Map<string, ts.Node>();
  const stack: ts.Node[] = [start];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    for (const ref of collectFreeIdentifiers(node)) {
      const decl = privateByName.get(ref);
      if (decl && !included.has(ref)) {
        included.set(ref, decl);
        stack.push(decl);
      }
    }
  }
  return [...included.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({
      name,
      span: spanText(content, sf, included.get(name) as ts.Node),
    }));
}

// The composite fingerprint of an export: its own token stream, plus — when it
// references same-file private helpers — each helper's token stream keyed by
// name. With no closure members this is exactly the bare span hash (the common
// case stays identical to the signature-only Slice 2a behavior).
function compositeFingerprint(ownSpan: string, members: { name: string; span: string }[]): string {
  const own = tokenStreamHash(ownSpan);
  if (members.length === 0) return own;
  const parts = [own];
  for (const m of members) parts.push(`${m.name} ${tokenStreamHash(m.span)}`);
  return sha256(parts.join("\n"));
}

// The top-level names a declaration statement binds (for residual accounting).
function declaredNames(stmt: ts.Statement): string[] {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations
      .filter((d) => ts.isIdentifier(d.name))
      .map((d) => (d.name as ts.Identifier).text);
  }
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
    return [stmt.name.text];
  }
  if (
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt)
  ) {
    return [stmt.name.text];
  }
  return [];
}

// Extract one anchor per exported global declaration (fingerprint closed over
// referenced same-file private helpers), plus one residual backstop anchor for
// the module-top-level content no precise anchor covers.
function tsAnchors(path: string, content: string): Anchor[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const anchors: Anchor[] = [];

  // Index every non-exported top-level declaration by name, so closures can pull
  // in the exact span of a referenced private helper (per-declarator for
  // multi-declarator variable statements).
  const privateByName = new Map<string, ts.Node>();
  for (const stmt of sf.statements) {
    if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) privateByName.set(decl.name.text, decl);
      }
    } else if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
      privateByName.set(stmt.name.text, stmt);
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      privateByName.set(stmt.name.text, stmt);
    }
  }

  // Private names pulled into some export's closure: those declarations are
  // covered by a precise anchor and are excluded from the residual backstop.
  const closureCovered = new Set<string>();
  // Statements that produced at least one precise anchor (excluded from residual).
  const anchoredStmts = new Set<ts.Statement>();

  const push = (name: string, kind: TsAnchorKind, node: ts.Node, stmt: ts.Statement) => {
    const members = closureOf(node, content, sf, privateByName);
    for (const m of members) closureCovered.add(m.name);
    anchors.push({
      id: anchorId(path, name, kind),
      fingerprint: compositeFingerprint(spanText(content, sf, node), members),
      name,
      kind,
    });
    anchoredStmts.add(stmt);
  };

  for (const stmt of sf.statements) {
    const isExported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      push(isDefault ? "default" : stmt.name.text, isDefault ? "default" : "function", stmt, stmt);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      push(isDefault ? "default" : stmt.name.text, isDefault ? "default" : "class", stmt, stmt);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      push(stmt.name.text, "interface", stmt, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      push(stmt.name.text, "type", stmt, stmt);
    } else if (ts.isEnumDeclaration(stmt)) {
      push(stmt.name.text, "enum", stmt, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      // `export const a = 1, b = 2;` yields one anchor per declared name. Each
      // anchor's span is the individual declaration so editing `a` leaves `b`'s
      // fingerprint untouched.
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) push(decl.name.text, "variable", decl, stmt);
      }
    } else if (isDefault) {
      // `export default <expression>;` — an anonymous default export.
      push("default", "default", stmt, stmt);
    }
    // Re-exports (`export { ... }`, `export * from`), `export =`, and namespace
    // members produce no precise anchor here; the residual backstop below still
    // covers them (never silently un-gated). Phase 2e classifies such files.
  }

  // Residual backstop: every top-level statement no precise anchor covers —
  // imports, side-effecting expression statements, and module state unreferenced
  // by any export. Hashed over the token streams in source order (side-effect
  // order is semantic). Only emitted when residual content exists; with none, any
  // file change must have moved a precise anchor, so the file is never read fresh.
  const residualSpans: string[] = [];
  for (const stmt of sf.statements) {
    if (anchoredStmts.has(stmt)) continue;
    const names = declaredNames(stmt);
    // A private declaration whose every bound name is closure-covered is already
    // accounted for by the covering anchor(s); everything else is residual.
    if (
      names.length > 0 &&
      !hasModifier(stmt, ts.SyntaxKind.ExportKeyword) &&
      names.every((n) => closureCovered.has(n))
    ) {
      continue;
    }
    residualSpans.push(spanText(content, sf, stmt));
  }
  if (residualSpans.length > 0) {
    anchors.push({
      id: anchorId(path, MODULE_ANCHOR_NAME, "module"),
      fingerprint: sha256(residualSpans.map(tokenStreamHash).join("\n")),
      name: MODULE_ANCHOR_NAME,
      kind: "module",
    });
  }

  return anchors;
}

export type TsFileMode = "precise" | "coarse" | "unevaluable";

export interface TsClassification {
  /** Whether the per-symbol gate applies (`precise`), the file is gated whole —
   *  `coarse` (a declaration/generated file, a re-export barrel, a side-effect
   *  module, `export =`, or namespace-only) — or it cannot be trusted at all,
   *  `unevaluable` (a parse error / conflict markers / syntax newer than the
   *  pinned parser): fail loud, never an anchor set that reads as fresh. */
  mode: TsFileMode;
  reason: string;
}

// A generated-code banner near the file head — the portable, content-only signal
// for codegen output committed as `.ts` (outDir-based detection needs tsconfig and
// is deferred). Matched case-insensitively in the first lines only.
const GENERATED_BANNER = /@generated\b|do not edit|auto-?generated/i;

// Classify a TS file for the gate: does the precise per-symbol path fully apply,
// is it only coarse-gatable, or is it un-evaluable (fail loud)? This is what keeps
// a file whose real surface the precise extractor does not anchor (a re-export
// barrel, `export =`, a namespace, generated output) from silently reading as
// fresh through an empty/partial precise anchor set — such files are routed to the
// coarse file-grain gate instead, and a parse error is surfaced rather than trusted.
export function classifyTsFile(path: string, content: string): TsClassification {
  if (path.endsWith(".d.ts")) {
    return { mode: "coarse", reason: "declaration file" };
  }
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diags && diags.length > 0) {
    const n = diags.length;
    return { mode: "unevaluable", reason: `parse error (${n} diagnostic${n === 1 ? "" : "s"})` };
  }
  if (GENERATED_BANNER.test(content.slice(0, 2000))) {
    return { mode: "coarse", reason: "generated banner" };
  }
  const anchors = tsAnchors(path, content);
  const preciseCount = anchors.filter((a) => a.kind !== "module").length;
  if (preciseCount > 0) {
    return {
      mode: "precise",
      reason: `${preciseCount} exported symbol${preciseCount === 1 ? "" : "s"}`,
    };
  }
  if (anchors.length > 0) {
    // Only the residual `<module>` backstop survived: a re-export barrel, a
    // side-effect-only module, `export =`, or namespace members — gated whole-file.
    return {
      mode: "coarse",
      reason: "no precise exports (re-export / side-effect / export= / namespace)",
    };
  }
  // No anchors at all (comments / whitespace only): nothing to gate per-symbol; the
  // coarse file hash still catches any change, so this is coarse, not an error.
  return { mode: "coarse", reason: "no anchorable content" };
}

export const tsAdapter: LanguageAdapter = {
  language: "typescript",
  // Precise for hand-written TS/TSX. `.d.ts` is a declaration/generated artifact
  // and falls through to the coarse adapter; `classifyTsFile` refines generated /
  // barrel / unsupported-export-form / parse-error classification for the gate.
  matches: (path) => /\.(ts|tsx|mts|cts)$/.test(path) && !path.endsWith(".d.ts"),
  anchors: tsAnchors,
};
