import ts from "typescript";

// ── Local-identifier canonicalization ───────────────────────────────────────
//
// The precise TS anchor fingerprints a declaration's token stream, so renaming a
// purely-local name — a parameter, a `const`/`let`, a destructured binding, a
// generic type parameter — moves the fingerprint and fires the gate even though
// the refactor preserves meaning. That local-variable rename was the single
// false-fire the soak demo measured across four common refactors. This pass
// removes the class STRUCTURALLY: every identifier that resolves to a binding
// introduced WITHIN the anchored declaration is rewritten to a positional index
// (`$0`, `$1`, …) assigned in collection order (name-independent), so two
// declarations that differ only by local renames hash identically, while any real
// change — a free / imported / global name, a structural edit, or a use that
// points at a different binding — is preserved.
//
// Two safety properties hold the fingerprint's meaning; the first is the reason
// this can touch the determinism core at all:
//
//   * SOUNDNESS (no false negatives / no laundering). An identifier is rewritten
//     ONLY when it certainly resolves to a binding this pass collected inside the
//     declaration. Every scope is built strictly within the declaration, so a
//     free name (module scope, an import, a global) is never in the chain and
//     stays literal — a change to it still fires. Block scoping is respected, so
//     an inner binding never leaks to an OUTER use of the same name (which would
//     let two distinct free references collide into one canonical form). Only real
//     binding names are ever collected — never a use — so a free reference can
//     never be mistaken for a local.
//
//   * COMPLETENESS is best-effort, not required. A binding form this pass does not
//     model simply leaves its identifiers literal and the gate behaves exactly as
//     before (fires on that rename). Under-canonicalizing is safe; over-
//     canonicalizing is the only hazard, and soundness forbids it. So the hoisting-
//     ambiguous forms — `var`, and nested function / class DECLARATION names — are
//     deliberately left literal rather than modelled imprecisely.
//
// Namespaces (value vs type) are separated so a type parameter and a value local
// of the same name never cross-resolve. Contract-relevant names that happen to be
// (or coincide with) a local are held literal: property names, object-literal keys,
// object-literal AND object-binding SHORTHAND (`{ port }` selects a named member),
// constructor parameter PROPERTIES (`public port` declares a member), enum members,
// labels, and the right side of a qualified name — renaming any of them is a real
// change that must still fire. The `$N` output namespace is also kept disjoint from
// real identifiers (a source name literally spelled `$0` is escaped), so a
// canonicalized local can never collide with a free reference that looks like it.

// A rewrite: replace the source in [start, end) with `text` (a `$N` index). Keyed
// by the identifier's absolute start offset so a span renderer can splice only the
// rewrites that fall inside the span it hashes.
export type CanonMap = Map<number, { end: number; text: string }>;

interface Scope {
  parent: Scope | null;
  value: Map<string, number>;
  type: Map<string, number>;
}

// Canonicalize every anchored declaration node in `nodes` (one for a normal
// declaration; several for an overload run — each independent). Returns the map of
// identifier rewrites; the caller renders spans through it. A fresh, parentless
// scope per node means one node never sees another's bindings (separate
// signatures), while a shared counter numbers bindings deterministically across
// the whole call. The nodes' OWN top-level names are never collected (they are the
// anchor's identity / contract), so they always stay literal.
export function canonicalizeDecls(sf: ts.SourceFile, nodes: ts.Node[]): CanonMap {
  const out: CanonMap = new Map();
  let counter = 0;

  const record = (id: ts.Identifier, idx: number): void => {
    out.set(id.getStart(sf), { end: id.getEnd(), text: `$${idx}` });
  };
  const newScope = (parent: Scope | null): Scope => ({
    parent,
    value: new Map(),
    type: new Map(),
  });
  const lookup = (scope: Scope, ns: "value" | "type", name: string): number | undefined => {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const idx = (ns === "value" ? s.value : s.type).get(name);
      if (idx !== undefined) return idx;
    }
    return undefined;
  };

  // Collect the value bindings a BindingName introduces, recording each. Property
  // keys stay literal; object-destructuring SHORTHAND (`{ port }`, no explicit
  // local) stays literal because the identifier IS the selected member name; only
  // an explicit `{ key: local }` local, an array element, or a rest binds. Default
  // values and computed keys inside the pattern are USES, walked by the caller.
  const bindName = (name: ts.BindingName, scope: Scope): void => {
    if (ts.isIdentifier(name)) {
      const idx = counter++;
      scope.value.set(name.text, idx);
      record(name, idx);
    } else if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) bindName(el.name, scope);
      }
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        if (el.propertyName) bindName(el.name, scope); // explicit `{ key: local }` only
      }
    }
  };

  const bindTypeParams = (params: ts.NodeArray<ts.TypeParameterDeclaration> | undefined, scope: Scope): void => {
    for (const tp of params ?? []) {
      const idx = counter++;
      scope.type.set(tp.name.text, idx);
      record(tp.name, idx);
    }
  };

  // A block-scoped variable statement (`let`/`const`/`using`/`await using`, never
  // `var` — its hoisting to the function scope is not modelled, so it stays literal)
  // declared directly in a block contributes its bindings to that block's scope.
  const collectBlockBindings = (stmt: ts.Statement, scope: Scope): void => {
    if (ts.isVariableStatement(stmt) && isBlockScopedList(stmt.declarationList)) {
      for (const d of stmt.declarationList.declarations) bindName(d.name, scope);
    }
  };

  // Is this identifier a NON-canonicalizable name position (a binding site handled
  // at collection, a member/key/label name, or a decl's own name)? Every such case
  // stays literal. A use that is none of these is resolved against the scope chain.
  const isLiteralName = (id: ts.Identifier): boolean => {
    const p = id.parent;
    if (ts.isPropertyAccessExpression(p)) return id === p.name;
    if (ts.isQualifiedName(p)) return id === p.right;
    if (ts.isPropertyAssignment(p)) return id === p.name; // object-literal key
    // Object-literal SHORTHAND (`{ port }`) is at once a value use AND the emitted
    // property KEY, so it is contract-relevant: renaming the referenced local
    // renames the key and changes the object's shape. Leave it literal so that
    // change still fires (the binding itself still canonicalizes, so `{ port }`
    // then reads a `$N` binding by its literal key — harmless for hashing, and a
    // key rename stays visible).
    if (ts.isShorthandPropertyAssignment(p)) return id === p.name;
    if (
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)
    ) {
      return id === p.name; // member name (a computed name is a ComputedPropertyName, not this id)
    }
    if (ts.isBindingElement(p)) return id === p.propertyName || id === p.name;
    if (ts.isParameter(p) || ts.isVariableDeclaration(p)) return id === p.name;
    if (ts.isTypeParameterDeclaration(p)) return id === p.name;
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p)
    ) {
      return id === p.name; // the declaration's own name — its contract identity
    }
    if (ts.isLabeledStatement(p)) return id === p.label;
    if (ts.isBreakStatement(p) || ts.isContinueStatement(p)) return id === p.label;
    return false;
  };

  // A type-position use: the bare-identifier name of a type reference (`: T`,
  // `Array<T>`, `T extends …`). `typeof x` is a VALUE reference, so it is not here.
  const isTypeUse = (id: ts.Identifier): boolean =>
    ts.isTypeReferenceNode(id.parent) && id === id.parent.typeName;

  const walk = (node: ts.Node, scope: Scope): void => {
    if (isFunctionLike(node)) {
      walkFunctionLike(node, scope);
    } else if (ts.isBlock(node)) {
      walkBlock(node, scope);
    } else if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      walkFor(node, scope);
    } else if (ts.isCatchClause(node)) {
      walkCatch(node, scope);
    } else if (ts.isCaseBlock(node)) {
      walkCaseBlock(node, scope);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      walkClass(node, scope);
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      walkTypeDecl(node, scope);
    } else if (ts.isIdentifier(node)) {
      if (isLiteralName(node)) return;
      const idx = lookup(scope, isTypeUse(node) ? "type" : "value", node.text);
      if (idx !== undefined) record(node, idx);
    } else {
      ts.forEachChild(node, (c) => walk(c, scope));
    }
  };

  // A function-like introduces one scope holding its type parameters and
  // parameters; its OWN name (a named function expression) is left literal. The
  // body is walked as a normal child — a block body becomes its own child scope
  // (so a param and a body `let` of the same name do not collide), an expression
  // body resolves directly in the param scope. Param defaults / annotations / the
  // return type resolve in the param scope only (they cannot see body locals),
  // which the child-scope split gives for free.
  function walkFunctionLike(node: ts.Node, parent: Scope): void {
    const fn = node as ts.FunctionLikeDeclaration;
    const scope = newScope(parent);
    bindTypeParams(fn.typeParameters, scope);
    for (const param of fn.parameters) {
      // A constructor PARAMETER PROPERTY (a param carrying public/private/protected/
      // readonly/override) also DECLARES a class member of that name — a contract-
      // relevant name, exactly like a property key. Leave it literal so a member
      // rename still fires; a plain parameter binds and canonicalizes as usual.
      if (isParameterProperty(param)) continue;
      bindName(param.name, scope);
    }
    ts.forEachChild(node, (c) => walk(c, scope));
  }

  function walkBlock(node: ts.Block, parent: Scope): void {
    const scope = newScope(parent);
    for (const stmt of node.statements) collectBlockBindings(stmt, scope);
    for (const stmt of node.statements) walk(stmt, scope);
  }

  function walkFor(
    node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement,
    parent: Scope,
  ): void {
    const scope = newScope(parent);
    const init = node.initializer;
    if (init && ts.isVariableDeclarationList(init) && isBlockScopedList(init)) {
      for (const d of init.declarations) bindName(d.name, scope);
    }
    ts.forEachChild(node, (c) => walk(c, scope));
  }

  function walkCatch(node: ts.CatchClause, parent: Scope): void {
    const scope = newScope(parent);
    if (node.variableDeclaration) bindName(node.variableDeclaration.name, scope);
    ts.forEachChild(node, (c) => walk(c, scope));
  }

  // A switch body is ONE lexical block scope shared across all case/default clauses
  // (a `let` in `case 1:` is in scope in `case 2:`), and — unlike a `{ }` block — its
  // clauses are not `ts.Block`s, so their direct `let`/`const` would otherwise be
  // uncollected and a use would leak to an outer binding of the same name.
  function walkCaseBlock(node: ts.CaseBlock, parent: Scope): void {
    const scope = newScope(parent);
    for (const clause of node.clauses) {
      for (const stmt of clause.statements) collectBlockBindings(stmt, scope);
    }
    ts.forEachChild(node, (c) => walk(c, scope));
  }

  // A class introduces a scope for its type parameters (visible to members and
  // heritage clauses); its own name stays literal, members are function-like with
  // their own child scopes, and property initializers resolve in the class scope.
  function walkClass(node: ts.ClassLikeDeclaration, parent: Scope): void {
    const scope = newScope(parent);
    bindTypeParams(node.typeParameters, scope);
    ts.forEachChild(node, (c) => walk(c, scope));
  }

  function walkTypeDecl(
    node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
    parent: Scope,
  ): void {
    const scope = newScope(parent);
    bindTypeParams(node.typeParameters, scope);
    ts.forEachChild(node, (c) => walk(c, scope));
  }

  for (const node of nodes) walk(node, newScope(null));

  // Keep the `$N` output namespace disjoint from real source. A canonical index is
  // exactly one `$` then digits; a LITERAL identifier already spelled that way (a
  // free/global/imported `$0`, a key, a declaration name) would otherwise render as
  // the byte-identical `$0` and collide with a canonicalized local — laundering a
  // real change. Escape every such literal by prepending one `$` (`$0` → `$$0`),
  // which is injective and, having two-or-more leading `$`, can never equal a
  // canonical index. Positions already canonicalized (in `out`) are left untouched.
  const escapeSentinels = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const start = node.getStart(sf);
      if (!out.has(start) && /^\$+\d/.test(node.text)) {
        out.set(start, { end: node.getEnd(), text: `$${node.text}` });
      }
      return;
    }
    ts.forEachChild(node, escapeSentinels);
  };
  for (const node of nodes) escapeSentinels(node);

  return out;
}

// A block-scoped variable declaration list whose bindings canonicalize: `let`,
// `const`, and `using`/`await using` (ES2023 explicit resource management, also
// block-scoped). `var` is excluded — its hoisting to the function scope is not
// modelled, so it stays literal. `await using` sets Const|Using, so testing
// Let|Const|Using catches all four block-scoped forms while `var` (no bits) is out.
const BLOCK_SCOPED_FLAGS = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using;
function isBlockScopedList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & BLOCK_SCOPED_FLAGS) !== 0;
}

// A constructor parameter property (public/private/protected/readonly/override on
// the parameter) declares a class member of that name, so its identifier is a
// contract-relevant name, not a private local.
function isParameterProperty(param: ts.ParameterDeclaration): boolean {
  return (ts.getModifiers(param) ?? []).some(
    (m) =>
      m.kind === ts.SyntaxKind.PublicKeyword ||
      m.kind === ts.SyntaxKind.PrivateKeyword ||
      m.kind === ts.SyntaxKind.ProtectedKeyword ||
      m.kind === ts.SyntaxKind.ReadonlyKeyword ||
      m.kind === ts.SyntaxKind.OverrideKeyword,
  );
}

// The function-like declarations that introduce a value scope (params + type
// params). Method / accessor SIGNATURES with no body still bind their params, so
// they canonicalize their own parameter names.
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isFunctionTypeNode(node)
  );
}

// Render `content[start, end)` with every canonical rewrite whose identifier
// starts inside the span spliced in. Rewrites never straddle a span boundary (an
// identifier lies wholly within one declaration sub-span), so a simple
// sorted-splice reproduces the span text with locals replaced by their `$N` index.
export function renderWithCanon(
  content: string,
  start: number,
  end: number,
  canon: CanonMap,
): string {
  const points = [...canon.entries()]
    .filter(([s]) => s >= start && s < end)
    .sort((a, b) => a[0] - b[0]);
  if (points.length === 0) return content.slice(start, end);
  let outText = "";
  let cursor = start;
  for (const [s, { end: e, text }] of points) {
    outText += content.slice(cursor, s);
    outText += text;
    cursor = e;
  }
  outText += content.slice(cursor, end);
  return outText;
}
