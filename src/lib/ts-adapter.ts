import { createHash } from "node:crypto";
import ts from "typescript";
import type { Anchor, LanguageAdapter } from "./fingerprint.js";
import { type CanonMap, canonicalizeDecls, renderWithCanon } from "./ts-canonicalize.js";

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
//
// Each precise anchor splits into a SIGNATURE hash and a BODY hash (composed into
// one `fingerprint`, plus the `signature` exposed for classification). The
// signature is the declaration's contract — modifiers, name, type params, params,
// return/type annotation, every overload signature, and any private helper
// reached FROM the signature; the body is the implementation an ack may still
// clear. Only an unambiguous function body splits (a function/method block or a
// directly-arrow/function-expression initializer); a class, interface, type,
// enum, plain const, and wrapped initializer are all-signature (conservative:
// over-wake, never launder a contract change). Two boundaries are by construction
// (no type checker): an inferred return type reads as body, and a class member's
// signature is inside the all-signature class body.
//
// Every span a precise anchor hashes is first rendered through the local-identifier
// canonicalizer (`ts-canonicalize.ts`): a name bound WITHIN the declaration
// (parameter, block local, destructured/catch binding, generic type parameter) is
// rewritten to a positional index before hashing, so a meaning-preserving local
// rename no longer moves the fingerprint. Free/imported/module/global references
// stay literal and still fire. The residual `<module>` backstop is NOT
// canonicalized (module-scope names are not "within a declaration").

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
// `skip` prunes one subtree from the walk — passing a declaration's body yields
// its SIGNATURE-only references (types, defaults, type params), which is how a
// signature-referenced private helper is told apart from a body-referenced one.
function collectFreeIdentifiers(root: ts.Node, skip?: ts.Node | readonly ts.Node[]): Set<string> {
  const names = new Set<string>();
  const skipSet = new Set<ts.Node>(skip ? (Array.isArray(skip) ? skip : [skip as ts.Node]) : []);
  const visit = (node: ts.Node) => {
    if (skipSet.has(node)) return;
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
  // Visit the root itself, not just its children: a body that IS a bare
  // identifier (`export = api`, `() => helper`) is a real free reference, and
  // starting at the children would silently drop it from the closure.
  visit(root);
  return names;
}

// Transitive closure of a set of referenced names over same-file non-exported
// declarations (directly or via other private declarations). Returns the
// included private names sorted, paired with their span text — sorted so the
// composite fingerprint is independent of where the helpers sit in the file.
// A private helper maps to ALL its member nodes (a private overloaded function is
// every signature plus its implementation), so a caller's closure hashes the
// helper's whole surface — an overload-signature-only change still moves the
// referencing anchor rather than reading fresh.
function closureFromNames(
  seedNames: Iterable<string>,
  content: string,
  sf: ts.SourceFile,
  privateByName: Map<string, ts.Node[]>,
): { name: string; span: string }[] {
  const included = new Map<string, ts.Node[]>();
  const stack: string[] = [...seedNames];
  while (stack.length > 0) {
    const ref = stack.pop();
    if (ref === undefined) continue;
    const decls = privateByName.get(ref);
    if (decls && !included.has(ref)) {
      included.set(ref, decls);
      for (const decl of decls) for (const next of collectFreeIdentifiers(decl)) stack.push(next);
    }
  }
  return [...included.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => {
      // A helper canonicalizes its OWN locals, independently of the caller (a
      // separate declaration → its own binding scope), so renaming a private
      // helper's parameter does not move a caller that closes over it either.
      const decls = included.get(name) as ts.Node[];
      const canon = canonicalizeDecls(sf, decls);
      return {
        name,
        // Concatenate the member spans in source order — degenerates to the single
        // span for the common (non-overloaded) helper, so ordinary fingerprints are
        // unchanged; only a private overloaded helper folds more than one span.
        span: decls
          .map((n) => renderWithCanon(content, n.getStart(sf), n.getEnd(), canon))
          .join("\n"),
      };
    });
}

// The composite hash of a token span plus — when it references same-file private
// helpers — each helper's token stream keyed by name. With no members this is
// exactly the bare span hash. Used for BOTH the signature side and the body side
// of a declaration, so the two halves are computed by one deterministic rule.
function compositeHash(ownSpan: string, members: { name: string; span: string }[]): string {
  const own = tokenStreamHash(ownSpan);
  if (members.length === 0) return own;
  const parts = [own];
  for (const m of members) parts.push(`${m.name} ${tokenStreamHash(m.span)}`);
  return sha256(parts.join("\n"));
}

// The splittable body region(s) of a declaration — what an ack MAY still clear
// as an implementation-only move — or empty when the whole declaration is
// signature (its contract). An UNAMBIGUOUS function body splits: a function/
// method declaration's block, or a variable whose initializer is DIRECTLY an
// arrow or function expression. A class, interface, type alias, enum, and plain
// (non-function) const are all-signature: any change to them is a contract
// change (never launderable). A wrapped initializer like `memoize(() => {})` is
// a CallExpression, so it is all-signature too. This is conservative by
// construction — it over-wakes but never under-wakes a real signature change.
//
// `export default <expr>` / `export = <expr>` split deliberately (ADR 014): a
// module whose single value export is an expression is the shape of virtually
// every modern config file, and reading it all-signature would make every
// config edit a non-ackable contract change. When the expression is a call
// (`defineNuxtConfig({...})`), the callee stays signature — swapping the
// producer is contract-grade — and the arguments are the body; any other
// expression is wholly body under the `export default` frame.
function bodiesOf(node: ts.Node): readonly ts.Node[] {
  if (ts.isFunctionDeclaration(node)) return node.body ? [node.body] : [];
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer;
    if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) {
      return [init.body];
    }
  }
  if (ts.isExportAssignment(node)) {
    const expr = node.expression;
    if (ts.isCallExpression(expr)) return [...expr.arguments];
    return [expr];
  }
  return [];
}

// The signature span text of a declaration: everything from its start up to the
// first body region when it has a splittable body, else the whole declaration —
// rendered through the canonicalizer so parameter and type-parameter names are
// positional.
function signatureSpan(
  content: string,
  sf: ts.SourceFile,
  node: ts.Node,
  bodies: readonly ts.Node[],
  canon: CanonMap,
): string {
  const start = node.getStart(sf);
  const end = bodies.length > 0 ? bodies[0].getStart(sf) : node.getEnd();
  return renderWithCanon(content, start, end, canon);
}

// Compute the {signature, fingerprint} pair for one anchor from its member
// declaration nodes (one node normally; several for an overload run — every
// overload signature plus the implementation). The signature hash folds every
// member's signature span in SOURCE ORDER (overload resolution priority is part
// of the contract, so reordering must move it) plus the private helpers those
// signatures reference; the body hash folds every body-bearing member (normally
// the single implementation) plus the helpers referenced ONLY from the body (sig
// wins ties, so a helper referenced from the signature can never be laundered into
// a body-only move). The composite binds both, so it moves on any real change.
function fingerprintPair(
  nodes: ts.Node[],
  content: string,
  sf: ts.SourceFile,
  privateByName: Map<string, ts.Node[]>,
): { signature: string; fingerprint: string; closureNames: Set<string> } {
  const sigRefs = new Set<string>();
  const bodyRefs = new Set<string>();
  const sigSpans: string[] = [];
  // Fold EVERY body-bearing member (normally one; a malformed run with two
  // implementations has several) so no body's tokens are dropped — degenerates to
  // the single implementation body for a valid function or overload set.
  const bodySpans: string[] = [];
  // One canonical rewrite map over all member nodes: a parameter in the signature
  // and its use in the body share an index, so both sides stay consistent under a
  // rename. Computed once here and applied to whichever sub-span each render covers.
  const canon = canonicalizeDecls(sf, nodes);
  for (const node of nodes) {
    const bodies = bodiesOf(node);
    sigSpans.push(signatureSpan(content, sf, node, bodies, canon));
    for (const r of collectFreeIdentifiers(node, bodies)) sigRefs.add(r);
    for (const body of bodies) {
      bodySpans.push(renderWithCanon(content, body.getStart(sf), body.getEnd(), canon));
      for (const r of collectFreeIdentifiers(body)) bodyRefs.add(r);
    }
  }
  const sigMembers = closureFromNames(sigRefs, content, sf, privateByName);
  const sigNames = new Set(sigMembers.map((m) => m.name));
  // Body closure minus the signature closure: a helper reachable from the
  // signature is contract, so it never dilutes into the ackable body side.
  const bodyMembers = closureFromNames(bodyRefs, content, sf, privateByName).filter(
    (m) => !sigNames.has(m.name),
  );
  const signature = compositeHash(sigSpans.join("\n"), sigMembers);
  const body = compositeHash(bodySpans.join("\n"), bodyMembers);
  return {
    signature,
    fingerprint: sha256(`${signature}\n${body}`),
    closureNames: new Set([...sigNames, ...bodyMembers.map((m) => m.name)]),
  };
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

  // Group consecutive same-name function declarations into overload runs: TS
  // requires an overload set's signatures to immediately precede their single
  // implementation, so a maximal run of adjacent same-name `function f` statements
  // IS one function's full surface. A normal function is a run of one. Anonymous
  // (default) functions cannot overload and are handled individually below.
  const stmtToRun = new Map<ts.FunctionDeclaration, ts.FunctionDeclaration[]>();
  {
    const stmts = sf.statements;
    let i = 0;
    while (i < stmts.length) {
      const stmt = stmts[i];
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        const run: ts.FunctionDeclaration[] = [stmt];
        let j = i + 1;
        while (j < stmts.length) {
          const next = stmts[j];
          if (!ts.isFunctionDeclaration(next) || next.name?.text !== name) break;
          run.push(next);
          j++;
        }
        for (const m of run) stmtToRun.set(m, run);
        i = j;
      } else {
        i++;
      }
    }
  }
  const runExported = (run: ts.FunctionDeclaration[]): boolean =>
    run.some((m) => hasModifier(m, ts.SyntaxKind.ExportKeyword));

  // Index every non-exported top-level declaration by name, so closures can pull
  // in the exact span of a referenced private helper (per-declarator for
  // multi-declarator variable statements). A function that is part of an EXPORTED
  // overload run is not private — its unexported overload signatures belong to the
  // exported anchor, never to `privateByName`.
  const privateByName = new Map<string, ts.Node[]>();
  for (const stmt of sf.statements) {
    if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const run = stmtToRun.get(stmt);
      if (run && runExported(run)) continue; // part of an exported anchor
      // Store the whole private run (every overload signature + the impl), not just
      // the implementation, so a closure over this helper hashes its full surface.
      privateByName.set(stmt.name.text, run ?? [stmt]);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) privateByName.set(decl.name.text, [decl]);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      privateByName.set(stmt.name.text, [stmt]);
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      privateByName.set(stmt.name.text, [stmt]);
    }
  }

  // Private names pulled into some export's closure: those declarations are
  // covered by a precise anchor and are excluded from the residual backstop.
  const closureCovered = new Set<string>();
  // Statements that produced at least one precise anchor (excluded from residual).
  const anchoredStmts = new Set<ts.Statement>();

  // Emit one anchor from a declaration's member nodes (one normally; every
  // overload signature plus the implementation for a run). The signature/body
  // split lives in `fingerprintPair`; here we record the composite + signature,
  // mark every contributing statement anchored, and fold covered privates.
  const push = (
    name: string,
    kind: TsAnchorKind,
    nodes: ts.Node[],
    stmts: ts.Statement[],
  ) => {
    const { signature, fingerprint, closureNames } = fingerprintPair(
      nodes,
      content,
      sf,
      privateByName,
    );
    for (const n of closureNames) closureCovered.add(n);
    anchors.push({ id: anchorId(path, name, kind), fingerprint, signature, name, kind });
    for (const s of stmts) anchoredStmts.add(s);
  };

  const processedRuns = new Set<ts.FunctionDeclaration[]>();
  for (const stmt of sf.statements) {
    // Named function declarations resolve through their overload run so an
    // overload-signature-only change (even an unexported one) is never shadowed.
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const run = stmtToRun.get(stmt);
      if (!run || processedRuns.has(run)) continue;
      processedRuns.add(run);
      if (!runExported(run)) continue; // private run → closure/residual
      const isDefault = run.some((m) => hasModifier(m, ts.SyntaxKind.DefaultKeyword));
      push(isDefault ? "default" : stmt.name.text, isDefault ? "default" : "function", run, run);
      continue;
    }

    // `export default <expr>` / `export = <expr>` is an ExportAssignment, which
    // carries NO modifiers — it must be recognized before the isExported guard
    // or it silently degrades the whole file to coarse (the exact hole that made
    // every `export default defineNuxtConfig({...})` config file fire on any
    // byte). One `default.` anchor; the call-aware signature/body split lives in
    // `bodiesOf` (ADR 014).
    if (ts.isExportAssignment(stmt)) {
      push("default", "default", [stmt], [stmt]);
      continue;
    }

    const isExported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      push(isDefault ? "default" : stmt.name.text, isDefault ? "default" : "class", [stmt], [stmt]);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      push(stmt.name.text, "interface", [stmt], [stmt]);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      push(stmt.name.text, "type", [stmt], [stmt]);
    } else if (ts.isEnumDeclaration(stmt)) {
      push(stmt.name.text, "enum", [stmt], [stmt]);
    } else if (ts.isVariableStatement(stmt)) {
      // `export const a = 1, b = 2;` yields one anchor per declared name. Each
      // anchor's span is the individual declaration so editing `a` leaves `b`'s
      // fingerprint untouched.
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) push(decl.name.text, "variable", [decl], [stmt]);
      }
    } else if (isDefault) {
      // Anonymous `export default function(){}`/`export default class{}` (no name,
      // so not caught above) or `export default <expression>`. `fingerprintPair`
      // body-splits a default function via `bodyOf`; a plain expression is all-sig.
      push("default", "default", [stmt], [stmt]);
    }
    // Re-exports (`export { ... }`, `export * from`) and namespace members
    // produce no precise anchor here; the residual backstop below still covers
    // them (never silently un-gated). Phase 2e classifies such files.
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
  if (/\.d\.(ts|mts|cts)$/.test(path)) {
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
      reason: "no precise exports (re-export / side-effect / namespace)",
    };
  }
  // No anchors at all (comments / whitespace only): nothing to gate per-symbol; the
  // coarse file hash still catches any change, so this is coarse, not an error.
  return { mode: "coarse", reason: "no anchorable content" };
}

export const tsAdapter: LanguageAdapter = {
  language: "typescript",
  // Precise for hand-written TS/TSX (`.mts`/`.cts` included). A declaration
  // artifact (`.d.ts`/`.d.mts`/`.d.cts`) falls through to the coarse adapter;
  // `classifyTsFile` refines generated / barrel / unsupported-export-form /
  // parse-error classification for the gate.
  matches: (path) => /\.(ts|tsx|mts|cts)$/.test(path) && !/\.d\.(ts|mts|cts)$/.test(path),
  anchors: tsAnchors,
};
