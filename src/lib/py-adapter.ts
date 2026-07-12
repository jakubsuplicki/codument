import { createHash } from "node:crypto";
import type { Anchor, LanguageAdapter } from "./fingerprint.js";
import { MODULE_ANCHOR_NAME } from "./ts-adapter.js";
import {
  type Language,
  loadLanguage,
  type Node,
  parseSync,
  TreeSitterError,
} from "./tree-sitter.js";
import { byteNormalize } from "./two-ref.js";

// The precise Python adapter: per-symbol fingerprints for the second-biggest
// agent ecosystem, over the bundled tree-sitter grammar (ADR 015). Syntactic
// parse only — no interpreter, no import resolution — so the verdict stays a
// pure function of content and package version.
//
// The public surface follows Python's own convention, stated as convention,
// not enforcement: when a module declares a static `__all__`, that list IS the
// public surface (and the `__all__` assignment itself is contract — it rides
// the module residual's signature side); without `__all__`, every top-level
// `def`/`class`/assignment not underscore-prefixed is public. Underscore-
// prefixed declarations form the private-helper pool. A DYNAMIC `__all__`
// (computed, concatenated, or reassigned) makes the public surface statically
// unknowable, so the file classifies coarse — gated whole, never guessed at.
//
// Dynamic reality is bounded honestly: module-level executable statements
// (side effects, monkey-patching, conditional defs, imports) land in the
// `<module>` residual, hashed in source order because execution order is
// semantic. A module docstring is residual body; a comment is trivia.
//
// The grammar loads through an async warm the command layer performs before
// the synchronous gate path runs; every cold path raises TreeSitterError —
// loud, never a silent coarse fallback.

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let pythonLanguage: Language | null = null;

/** Load the bundled Python grammar so the sync gate path can parse. Idempotent. */
export async function warmPythonAdapter(): Promise<void> {
  if (!pythonLanguage) pythonLanguage = await loadLanguage("python");
}

function requireWarm(): Language {
  if (!pythonLanguage) {
    throw new TreeSitterError(
      "python grammar not loaded — the command layer must warm adapters before the sync gate path runs",
    );
  }
  return pythonLanguage;
}

export type PyAnchorKind = "function" | "class" | "variable" | "module";

// Same SCIP-descriptor discipline as the TS adapter: functions → `name().`,
// classes → `Name#`, module variables → `name.`, the residual → `<module>` —
// so acks, ownership, drift output, and SARIF stay shape-identical across
// languages.
function descriptor(name: string, kind: PyAnchorKind): string {
  switch (kind) {
    case "function":
      return `${name}().`;
    case "class":
      return `${name}#`;
    case "module":
      return MODULE_ANCHOR_NAME;
    default:
      return `${name}.`;
  }
}

function anchorId(path: string, name: string, kind: PyAnchorKind): string {
  return `${path}::${descriptor(name, kind)}`;
}

// Token-stream fingerprint of one or more CST nodes: every leaf token except
// comments, length-prefixed exactly like the TS adapter's framing (injective —
// `a b` and `"a b"` cannot collide) and indentation-free by construction (the
// leaves carry no whitespace), so reformatting and comment churn move nothing
// while `0x10` vs `16` and intra-string edits still fire. Subtrees in
// `exclude` are skipped wholesale — how a declaration's body region is carved
// out of its signature hash.
function tokenStreamHash(nodes: readonly Node[], exclude?: ReadonlySet<number>): string {
  const hash = createHash("sha256");
  const walk = (n: Node): void => {
    if (exclude?.has(n.id)) return;
    if (n.childCount === 0) {
      if (n.type === "comment" || n.text.length === 0) return;
      hash.update(`${Buffer.byteLength(n.text, "utf8")}:`);
      hash.update(n.text, "utf8");
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
  };
  for (const n of nodes) walk(n);
  return hash.digest("hex");
}

// Every identifier leaf under `nodes`, minus excluded subtrees — the raw
// material of the private-helper closure. Deliberately scope-blind (v1, like
// the plan says): a local that shadows a module-private name over-includes the
// helper, which over-wakes but never launders.
function collectIdentifiers(nodes: readonly Node[], exclude?: ReadonlySet<number>): Set<string> {
  const refs = new Set<string>();
  const walk = (n: Node): void => {
    if (exclude?.has(n.id)) return;
    if (n.type === "identifier") {
      refs.add(n.text);
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
  };
  for (const n of nodes) walk(n);
  return refs;
}

// A top-level declaration: one anchor identity plus every statement that
// contributes to its span (a multi-target assignment contributes its whole
// statement to each declared name; same-name defs merge into one run, so an
// `@overload` stack is a single anchored surface).
interface PyDecl {
  name: string;
  kind: "function" | "class" | "variable";
  nodes: Node[];
}

// The statically-evaluated `__all__` surface: `names` when it is a plain list
// or tuple of string literals; `dynamic` when any shape makes the public
// surface unknowable (computed expression, concatenation, augmented or
// repeated assignment, non-literal element).
type AllSpec = { present: false } | { present: true; dynamic: boolean; names: Set<string> };

function readDunderAll(statements: readonly Node[]): AllSpec {
  const assignments: Node[] = [];
  let dynamic = false;
  for (const stmt of statements) {
    if (stmt.type !== "expression_statement") continue;
    const inner = stmt.namedChildren[0];
    if (!inner) continue;
    if (inner.type === "assignment" || inner.type === "augmented_assignment") {
      const left = inner.childForFieldName("left");
      if (left?.type === "identifier" && left.text === "__all__") {
        if (inner.type === "augmented_assignment") dynamic = true;
        else assignments.push(inner);
      }
    }
  }
  if (assignments.length === 0 && !dynamic) return { present: false };
  if (assignments.length !== 1 || dynamic) {
    return { present: true, dynamic: true, names: new Set() };
  }
  const right = assignments[0].childForFieldName("right");
  if (!right || (right.type !== "list" && right.type !== "tuple")) {
    return { present: true, dynamic: true, names: new Set() };
  }
  const names = new Set<string>();
  for (const el of right.namedChildren) {
    if (el.type !== "string") return { present: true, dynamic: true, names: new Set() };
    const content = el.namedChildren.find((c) => c.type === "string_content");
    // An f-string or concatenation inside __all__ is not a static name.
    if (!content || el.namedChildren.some((c) => c.type === "interpolation")) {
      return { present: true, dynamic: true, names: new Set() };
    }
    names.add(content.text);
  }
  return { present: true, dynamic: false, names };
}

// Collect the module's top-level declarations. Anything that is not a
// declaration (imports, calls, control flow, docstrings, `__all__` itself)
// stays out and lands in the residual.
function collectDecls(statements: readonly Node[]): PyDecl[] {
  const byKey = new Map<string, PyDecl>();
  const push = (name: string, kind: PyDecl["kind"], node: Node): void => {
    const key = `${kind}:${name}`;
    const existing = byKey.get(key);
    if (existing) existing.nodes.push(node);
    else byKey.set(key, { name, kind, nodes: [node] });
  };
  for (const stmt of statements) {
    const node = stmt;
    if (node.type === "decorated_definition") {
      const def = node.childForFieldName("definition");
      if (!def) continue;
      const name = def.childForFieldName("name")?.text;
      if (!name) continue;
      // The span is the decorated_definition: decorators are part of the surface.
      push(name, def.type === "class_definition" ? "class" : "function", stmt);
      continue;
    }
    if (node.type === "function_definition" || node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) push(name, node.type === "class_definition" ? "class" : "function", node);
      continue;
    }
    if (node.type === "expression_statement") {
      const inner = node.namedChildren[0];
      if (inner?.type !== "assignment") continue; // augmented/call/docstring → residual
      const left = inner.childForFieldName("left");
      if (!left) continue;
      if (left.type === "identifier") {
        if (left.text !== "__all__") push(left.text, "variable", stmt);
      } else if (left.type === "pattern_list" || left.type === "tuple_pattern") {
        // `x, y = ...`: one anchor per plain identifier target, each spanning
        // the whole statement (the targets cannot be split apart).
        for (const target of left.namedChildren) {
          if (target.type === "identifier") push(target.text, "variable", stmt);
        }
      }
      // Attribute/subscript targets (`obj.attr = …`) are effects → residual.
    }
  }
  return [...byKey.values()];
}

function isPublic(decl: PyDecl, all: AllSpec): boolean {
  if (all.present) return !all.dynamic && all.names.has(decl.name);
  return !decl.name.startsWith("_");
}

function defBody(member: Node): Node | null {
  const def =
    member.type === "decorated_definition" ? member.childForFieldName("definition") : member;
  return def?.childForFieldName("body") ?? null;
}

// The body regions of a declaration — what an ack may still clear as an
// implementation-only move. A function's suite is body (decorators, name,
// parameters with defaults, and the return annotation are contract). A class
// splits per member: method suites and the class docstring are body; the class
// frame, bases, every method's signature, and class-level assignments are
// contract. A module assignment's VALUE is body while its targets and
// annotation are contract — the settings-file calibration (ADR 014's frame
// rule, restated for Python): editing `DEBUG = True` to `False` is one ackable
// finding, renaming or re-typing the setting is not.
function bodyRegionsOf(decl: PyDecl): Node[] {
  const bodies: Node[] = [];
  for (const node of decl.nodes) {
    if (decl.kind === "function") {
      const b = defBody(node);
      if (b) bodies.push(b);
    } else if (decl.kind === "class") {
      const block = defBody(node);
      if (!block) continue;
      for (const member of block.namedChildren) {
        if (member.type === "function_definition" || member.type === "decorated_definition") {
          const b = defBody(member);
          if (b) bodies.push(b);
        } else if (
          member.type === "expression_statement" &&
          member.namedChildren[0]?.type === "string"
        ) {
          bodies.push(member);
        }
      }
    } else if (node.type === "expression_statement") {
      const inner = node.namedChildren[0];
      const right = inner?.type === "assignment" ? inner.childForFieldName("right") : null;
      if (right) bodies.push(right);
    }
  }
  return bodies;
}

// Transitively include every module-private declaration reachable from the
// seed names. A helper's hash covers its WHOLE surface (all merged nodes), so
// a private change of any grain moves its public referencers. Sorted by name —
// the member order is never a function of discovery order.
function closureFromNames(
  seeds: Iterable<string>,
  privateByName: ReadonlyMap<string, Node[]>,
): { name: string; hash: string }[] {
  const included = new Map<string, Node[]>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const ref = stack.pop();
    if (ref === undefined) continue;
    const decls = privateByName.get(ref);
    if (decls && !included.has(ref)) {
      included.set(ref, decls);
      for (const r of collectIdentifiers(decls)) stack.push(r);
    }
  }
  return [...included.entries()]
    .map(([name, nodes]) => ({ name, hash: tokenStreamHash(nodes) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Same composition rule as the TS adapter: the bare hash when nothing private
// is referenced, else the own hash plus each helper's hash keyed by name.
function compositeHash(own: string, members: readonly { name: string; hash: string }[]): string {
  if (members.length === 0) return own;
  return sha256([own, ...members.map((m) => `${m.name} ${m.hash}`)].join("\n"));
}

// The {signature, fingerprint} pair for one public declaration. Helpers
// referenced from the signature side are contract (sig wins ties, so a helper
// reachable from a default value can never be laundered into a body-only
// move); helpers referenced only from the body stay ackable with it. The
// composite binds both halves, so it moves on any real change.
function pyFingerprintPair(
  decl: PyDecl,
  privateByName: ReadonlyMap<string, Node[]>,
): { signature: string; fingerprint: string; closureNames: Set<string> } {
  const bodies = bodyRegionsOf(decl);
  const bodyIds: ReadonlySet<number> = new Set(bodies.map((b) => b.id));
  const sigRefs = collectIdentifiers(decl.nodes, bodyIds);
  const bodyRefs = collectIdentifiers(bodies);
  const sigMembers = closureFromNames(sigRefs, privateByName);
  const sigNames = new Set(sigMembers.map((m) => m.name));
  const bodyMembers = closureFromNames(bodyRefs, privateByName).filter(
    (m) => !sigNames.has(m.name),
  );
  const signature = compositeHash(tokenStreamHash(decl.nodes, bodyIds), sigMembers);
  const body = compositeHash(tokenStreamHash(bodies), bodyMembers);
  return {
    signature,
    fingerprint: sha256(`${signature}\n${body}`),
    closureNames: new Set([...sigNames, ...bodyMembers.map((m) => m.name)]),
  };
}

// The top-level names a statement binds (for residual accounting).
function pyDeclaredNames(stmt: Node): string[] {
  if (stmt.type === "decorated_definition" || stmt.type === "function_definition" || stmt.type === "class_definition") {
    const def = stmt.type === "decorated_definition" ? stmt.childForFieldName("definition") : stmt;
    const name = def?.childForFieldName("name")?.text;
    return name ? [name] : [];
  }
  if (stmt.type === "expression_statement") {
    const inner = stmt.namedChildren[0];
    if (inner?.type !== "assignment") return [];
    const left = inner.childForFieldName("left");
    if (!left) return [];
    if (left.type === "identifier") return [left.text];
    if (left.type === "pattern_list" || left.type === "tuple_pattern") {
      return left.namedChildren.filter((t) => t.type === "identifier").map((t) => t.text);
    }
  }
  return [];
}

// Anchor extraction: one per public declaration, fingerprinted over the
// signature/body split and transitively closed over referenced module-private
// helpers, plus the residual backstop.
export function pyAnchors(path: string, content: string): Anchor[] {
  const language = requireWarm();
  const tree = parseSync(language, byteNormalize(content));
  try {
    const statements = tree.rootNode.namedChildren;
    const all = readDunderAll(statements);
    const decls = collectDecls(statements);
    const anchors: Anchor[] = [];
    const anchoredStmts = new Set<Node>();

    // The private-helper pool: every non-public declaration, keyed by name
    // (kinds merged — `_f = …` shadowing `def _f` is one surface).
    const privateByName = new Map<string, Node[]>();
    for (const decl of decls) {
      if (isPublic(decl, all)) continue;
      const existing = privateByName.get(decl.name);
      if (existing) existing.push(...decl.nodes);
      else privateByName.set(decl.name, [...decl.nodes]);
    }

    // Private names pulled into some public anchor's closure: those
    // declarations are covered by a precise anchor and leave the residual.
    const closureCovered = new Set<string>();

    for (const decl of decls) {
      if (!isPublic(decl, all)) continue;
      const pair = pyFingerprintPair(decl, privateByName);
      for (const n of pair.closureNames) closureCovered.add(n);
      anchors.push({
        id: anchorId(path, decl.name, decl.kind),
        fingerprint: pair.fingerprint,
        signature: pair.signature,
        name: decl.name,
        kind: decl.kind,
      });
      for (const n of decl.nodes) anchoredStmts.add(n);
    }

    // Residual backstop: every top-level statement no precise anchor covers —
    // imports, side effects, docstrings, uncovered private declarations, and
    // `__all__` itself. Hashed per-statement in source order (execution order
    // is semantic). With a static `__all__`, that assignment is the residual's
    // SIGNATURE side: editing the public list is a contract move, while
    // docstring/side-effect churn stays body-only.
    const residual = statements.filter((s) => {
      if (anchoredStmts.has(s)) return false;
      const names = pyDeclaredNames(s);
      return !(names.length > 0 && names.every((n) => closureCovered.has(n)));
    });
    if (residual.length > 0) {
      const allStmts = residual.filter((s) => {
        if (s.type !== "expression_statement") return false;
        const inner = s.namedChildren[0];
        if (inner?.type !== "assignment") return false;
        const left = inner.childForFieldName("left");
        return left?.type === "identifier" && left.text === "__all__";
      });
      anchors.push({
        id: anchorId(path, MODULE_ANCHOR_NAME, "module"),
        fingerprint: sha256(residual.map((s) => tokenStreamHash([s])).join("\n")),
        signature:
          all.present && !all.dynamic && allStmts.length > 0
            ? tokenStreamHash(allStmts)
            : undefined,
        name: MODULE_ANCHOR_NAME,
        kind: "module",
      });
    }
    return anchors;
  } finally {
    tree.delete();
  }
}

export type PyFileMode = "precise" | "coarse" | "unevaluable";

export interface PyClassification {
  mode: PyFileMode;
  reason: string;
}

// Same content-only generated-code signal the TS classifier uses.
const GENERATED_BANNER = /@generated\b|do not edit|auto-?generated/i;

// Classify a Python file for the gate: per-symbol (`precise`), whole-file
// (`coarse` — script/side-effect modules, re-export shims, dynamic `__all__`,
// generated output), or `unevaluable` (does not parse — tree-sitter is
// error-RECOVERING, so this is an explicit ERROR/MISSING check, never an
// exception path; a broken file is surfaced, not trusted).
export function classifyPyFile(path: string, content: string): PyClassification {
  const language = requireWarm();
  const normalized = byteNormalize(content);
  const tree = parseSync(language, normalized);
  try {
    if (tree.rootNode.hasError) {
      return { mode: "unevaluable", reason: "parse error" };
    }
  } finally {
    tree.delete();
  }
  if (GENERATED_BANNER.test(normalized.slice(0, 2000))) {
    return { mode: "coarse", reason: "generated banner" };
  }
  const anchors = pyAnchors(path, normalized);
  const preciseCount = anchors.filter((a) => a.kind !== "module").length;
  if (preciseCount > 0) {
    return {
      mode: "precise",
      reason: `${preciseCount} public symbol${preciseCount === 1 ? "" : "s"}`,
    };
  }
  if (anchors.length > 0) {
    return {
      mode: "coarse",
      reason: "no public symbols (script / re-export / dynamic __all__)",
    };
  }
  return { mode: "coarse", reason: "no anchorable content" };
}

export const pyAdapter: LanguageAdapter = {
  language: "python",
  // Type stubs (`.pyi`) anchor like any module — no cross-file stub matching.
  matches: (path) => /\.pyi?$/.test(path),
  anchors: pyAnchors,
  classify: classifyPyFile,
  warm: warmPythonAdapter,
};
