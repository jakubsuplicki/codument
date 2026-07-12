import { createHash } from "node:crypto";
import type { Anchor, LanguageAdapter } from "./fingerprint.js";
import { GENERATED_BANNER, MODULE_ANCHOR_NAME } from "./ts-adapter.js";
import {
  type Language,
  loadLanguage,
  type Node,
  parseSync,
  TreeSitterError,
} from "./tree-sitter.js";
import { byteNormalize } from "./two-ref.js";

// The precise Go adapter: the cleanest public-surface semantics of any target,
// because visibility is syntactic — exported = capitalized identifier, Go's own
// law, zero convention-hedging. Package-level funcs anchor as `name().`,
// methods under their receiver type as `Type#method().` (pointer and value
// receivers normalize to ONE identity — receiver kind is signature, not
// identity), types as `Name#`, and vars/consts per declarator as `name.` —
// editing one const inside a grouped `( … )` block moves only it.
//
// Split calibration: a func/method's name, receiver, type params, params, and
// results are contract; the block is ackable body. A struct's exported fields
// AND their tags are signature (tags are wire contract); unexported fields are
// body — internal representation is ackable. A var/const VALUE is body while
// its name and type are contract (the settings calibration, same as Python).
//
// `init` funcs and package-level side effects ride the `<module>` residual in
// source order. One cgo honesty carve-out: the comment block preceding
// `import "C"` is SEMANTIC (it is compiled), so those comment nodes join the
// residual hash for that import instead of folding away as trivia.

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let goLanguage: Language | null = null;

/** Load the bundled Go grammar so the sync gate path can parse. Idempotent. */
export async function warmGoAdapter(): Promise<void> {
  if (!goLanguage) goLanguage = await loadLanguage("go");
}

function requireWarm(): Language {
  if (!goLanguage) {
    throw new TreeSitterError(
      "go grammar not loaded — the command layer must warm adapters before the sync gate path runs",
    );
  }
  return goLanguage;
}

export type GoAnchorKind = "function" | "method" | "type" | "variable" | "module";

function anchorId(path: string, decl: GoDecl): string {
  switch (decl.kind) {
    case "function":
      return `${path}::${decl.name}().`;
    case "method":
      return `${path}::${decl.receiver}#${decl.name}().`;
    case "type":
      return `${path}::${decl.name}#`;
    default:
      return `${path}::${decl.name}.`;
  }
}

// Token-stream fingerprint over CST nodes — the same framing as the Python
// adapter (length-prefixed leaves, comments folded), with an optional set of
// EXTRA comment nodes to include (the cgo preamble carve-out).
function tokenStreamHash(
  nodes: readonly Node[],
  exclude?: ReadonlySet<number>,
  includeComments = false,
): string {
  const hash = createHash("sha256");
  const walk = (n: Node): void => {
    if (exclude?.has(n.id)) return;
    if (n.childCount === 0) {
      if ((n.type === "comment" && !includeComments) || n.text.length === 0) return;
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

// Identifier-ish leaves for the closure walk: plain identifiers, method/field
// selectors, and type references — scope-blind over-approximation, same stance
// as the other adapters (over-wakes, never launders).
function collectIdentifiers(nodes: readonly Node[], exclude?: ReadonlySet<number>): Set<string> {
  const refs = new Set<string>();
  const walk = (n: Node): void => {
    if (exclude?.has(n.id)) return;
    if (n.type === "identifier" || n.type === "field_identifier" || n.type === "type_identifier") {
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

interface GoDecl {
  name: string;
  kind: "function" | "method" | "type" | "variable";
  /** The receiver BASE type for a method (`*Server` and `Server` both → `Server`). */
  receiver?: string;
  nodes: Node[];
}

// The receiver's base type name: unwrap pointers and generics down to the
// leading type identifier, so pointer and value receivers share one identity.
function receiverBase(receiver: Node | null): string | null {
  if (!receiver) return null;
  const param = receiver.namedChildren.find((n) => n.type === "parameter_declaration");
  let t = param?.childForFieldName("type") ?? null;
  while (t && (t.type === "pointer_type" || t.type === "generic_type")) {
    t = t.namedChildren[0] ?? null;
  }
  return t?.type === "type_identifier" ? t.text : null;
}

// Names a spec binds (a grouped const/var spec can declare several: `a, b = …`).
function specNames(spec: Node): string[] {
  const names: string[] = [];
  for (const child of spec.namedChildren) {
    if (child.type === "identifier") names.push(child.text);
    else break; // names come first; the type/value ends the run
  }
  return names;
}

function collectDecls(statements: readonly Node[]): GoDecl[] {
  const byKey = new Map<string, GoDecl>();
  const push = (decl: Omit<GoDecl, "nodes">, node: Node): void => {
    const key = `${decl.kind}:${decl.receiver ?? ""}:${decl.name}`;
    const existing = byKey.get(key);
    if (existing) existing.nodes.push(node);
    else byKey.set(key, { ...decl, nodes: [node] });
  };
  for (const stmt of statements) {
    if (stmt.type === "function_declaration") {
      const name = stmt.childForFieldName("name")?.text;
      if (name) push({ name, kind: "function" }, stmt);
    } else if (stmt.type === "method_declaration") {
      const name = stmt.childForFieldName("name")?.text;
      const receiver = receiverBase(stmt.childForFieldName("receiver"));
      if (name && receiver) push({ name, kind: "method", receiver }, stmt);
    } else if (stmt.type === "type_declaration") {
      for (const spec of stmt.namedChildren) {
        if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
        const name = spec.childForFieldName("name")?.text;
        // Per-spec span: editing one type in a grouped block moves only it.
        if (name) push({ name, kind: "type" }, spec);
      }
    } else if (stmt.type === "const_declaration" || stmt.type === "var_declaration") {
      // An iota-style const block (any spec with NO explicit value) is
      // POSITIONAL: inserting a spec shifts every later constant's runtime
      // value without changing its own bytes. Per-spec anchoring would read
      // that as fresh — a silent miss on Go's most idiomatic enum pattern —
      // so such a block anchors every name at BLOCK grain instead
      // (over-fires within the block, never silent).
      const specs = stmt.namedChildren.filter(
        (n) => n.type === "const_spec" || n.type === "var_spec",
      );
      const iotaBlock =
        stmt.type === "const_declaration" &&
        specs.length > 1 &&
        specs.some((sp) => !sp.childForFieldName("value"));
      for (const spec of specs) {
        for (const name of specNames(spec)) {
          push({ name, kind: "variable" }, iotaBlock ? stmt : spec);
        }
      }
    }
  }
  return [...byKey.values()];
}

// Go's law: exported iff the first rune is an uppercase letter. `init` is
// never referenceable, so it stays private and (being unreferenced) rides the
// residual in source order — exactly where package side effects belong.
function isPublic(decl: GoDecl): boolean {
  const ch = decl.name[0];
  return ch !== undefined && ch !== "_" && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

// The ackable body regions of a declaration. Funcs/methods: the block. Types:
// UNEXPORTED struct fields (internal representation); exported fields and
// their tags stay contract, and an interface's method set is all contract.
// Vars/consts: the value.
function bodyRegionsOf(decl: GoDecl): Node[] {
  const bodies: Node[] = [];
  for (const node of decl.nodes) {
    if (decl.kind === "function" || decl.kind === "method") {
      const b = node.childForFieldName("body");
      if (b) bodies.push(b);
    } else if (decl.kind === "type") {
      const t = node.childForFieldName("type");
      if (t?.type === "struct_type") {
        const fields = t.namedChildren.find((n) => n.type === "field_declaration_list");
        for (const f of fields?.namedChildren ?? []) {
          if (f.type !== "field_declaration") continue;
          const names = f.namedChildren.filter((n) => n.type === "field_identifier");
          // An EMBEDDED field has no field_identifier, so it always stays on
          // the signature side regardless of the embedded type's own case —
          // deliberate: embedding changes method/field promotion, which is
          // contract even when the embedded type is unexported.
          const unexported =
            names.length > 0 &&
            names.every((n) => {
              const c = n.text[0];
              return c === "_" || c !== c.toUpperCase() || c === c.toLowerCase();
            });
          if (unexported) bodies.push(f);
        }
      }
    } else if (node.type === "const_spec" || node.type === "var_spec") {
      const v = node.childForFieldName("value");
      if (v) bodies.push(v);
    } else if (node.type === "const_declaration" || node.type === "var_declaration") {
      // Block-grain anchor (iota): every explicit value is body; the member
      // list and its ORDER are contract, so inserting or reordering a spec is
      // a signature move — exactly what a positional value shift is.
      for (const spec of node.namedChildren) {
        if (spec.type !== "const_spec" && spec.type !== "var_spec") continue;
        const v = spec.childForFieldName("value");
        if (v) bodies.push(v);
      }
    }
  }
  return bodies;
}

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

function compositeHash(own: string, members: readonly { name: string; hash: string }[]): string {
  if (members.length === 0) return own;
  return sha256([own, ...members.map((m) => `${m.name} ${m.hash}`)].join("\n"));
}

function goFingerprintPair(
  decl: GoDecl,
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

// The statement-level names for residual accounting (per top-level statement).
function goDeclaredNames(stmt: Node): string[] {
  if (stmt.type === "function_declaration") {
    const n = stmt.childForFieldName("name")?.text;
    return n ? [n] : [];
  }
  if (stmt.type === "method_declaration") {
    const n = stmt.childForFieldName("name")?.text;
    return n ? [n] : [];
  }
  if (stmt.type === "type_declaration") {
    return stmt.namedChildren
      .filter((s) => s.type === "type_spec" || s.type === "type_alias")
      .map((s) => s.childForFieldName("name")?.text)
      .filter((n): n is string => !!n);
  }
  if (stmt.type === "const_declaration" || stmt.type === "var_declaration") {
    return stmt.namedChildren
      .filter((s) => s.type === "const_spec" || s.type === "var_spec")
      .flatMap(specNames);
  }
  return [];
}

// Is this import declaration the cgo import? (`import "C"`, possibly grouped.)
function isCgoImport(stmt: Node): boolean {
  return stmt.type === "import_declaration" && /"C"/.test(stmt.text);
}

export function goAnchors(path: string, content: string): Anchor[] {
  const language = requireWarm();
  const tree = parseSync(language, byteNormalize(content));
  try {
    const statements = tree.rootNode.namedChildren;
    const decls = collectDecls(statements);
    const anchors: Anchor[] = [];
    const anchoredStmts = new Set<Node>();
    const anchoredSpecIds = new Set<number>();

    const privateByName = new Map<string, Node[]>();
    for (const decl of decls) {
      if (isPublic(decl)) continue;
      // Methods key by bare name too: a `s.helper()` selector reference pulls
      // the private method in — over-approximate, never silent.
      const existing = privateByName.get(decl.name);
      if (existing) existing.push(...decl.nodes);
      else privateByName.set(decl.name, [...decl.nodes]);
    }

    const closureCovered = new Set<string>();
    for (const decl of decls) {
      if (!isPublic(decl)) continue;
      const pair = goFingerprintPair(decl, privateByName);
      for (const n of pair.closureNames) closureCovered.add(n);
      anchors.push({
        id: anchorId(path, decl),
        fingerprint: pair.fingerprint,
        signature: pair.signature,
        name: decl.kind === "method" ? `${decl.receiver}#${decl.name}` : decl.name,
        kind: decl.kind,
      });
      for (const n of decl.nodes) {
        anchoredStmts.add(n);
        anchoredSpecIds.add(n.id);
      }
    }

    // Residual: package clause, imports (cgo preamble comments included — they
    // are compiled), init funcs, uncovered privates, and any grouped spec whose
    // siblings anchored but it did not (a private const in a public block).
    const residualSpans: string[] = [];
    for (const stmt of statements) {
      if (anchoredStmts.has(stmt)) continue;
      if (stmt.type === "comment") continue; // trivia unless cgo pulls it in below
      if (
        stmt.type === "type_declaration" ||
        stmt.type === "const_declaration" ||
        stmt.type === "var_declaration"
      ) {
        // Grouped declarations anchor per spec; hash only the UNANCHORED,
        // uncovered specs here.
        const specs = stmt.namedChildren.filter(
          (s) =>
            (s.type === "type_spec" ||
              s.type === "type_alias" ||
              s.type === "const_spec" ||
              s.type === "var_spec") &&
            !anchoredSpecIds.has(s.id),
        );
        for (const spec of specs) {
          const names = specNames(spec).length
            ? specNames(spec)
            : [spec.childForFieldName("name")?.text ?? ""].filter(Boolean);
          if (names.length > 0 && names.every((n) => closureCovered.has(n))) continue;
          residualSpans.push(tokenStreamHash([spec]));
        }
        continue;
      }
      const names = goDeclaredNames(stmt);
      if (names.length > 0 && names.every((n) => closureCovered.has(n))) continue;
      if (isCgoImport(stmt)) {
        // The preceding comment block is the cgo preamble — semantic, compiled.
        const preamble: Node[] = [];
        let prev = stmt.previousNamedSibling;
        while (prev && prev.type === "comment") {
          preamble.unshift(prev);
          prev = prev.previousNamedSibling;
        }
        residualSpans.push(tokenStreamHash([...preamble, stmt], undefined, true));
        continue;
      }
      residualSpans.push(tokenStreamHash([stmt]));
    }
    if (residualSpans.length > 0) {
      anchors.push({
        id: `${path}::${MODULE_ANCHOR_NAME}`,
        fingerprint: sha256(residualSpans.join("\n")),
        name: MODULE_ANCHOR_NAME,
        kind: "module",
      });
    }
    return anchors;
  } finally {
    tree.delete();
  }
}

export type GoFileMode = "precise" | "coarse" | "unevaluable";

export interface GoClassification {
  mode: GoFileMode;
  reason: string;
}

export function classifyGoFile(path: string, content: string): GoClassification {
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
  // Matches Go's own convention: `// Code generated … DO NOT EDIT.`
  if (GENERATED_BANNER.test(normalized.slice(0, 2000))) {
    return { mode: "coarse", reason: "generated banner" };
  }
  const anchors = goAnchors(path, normalized);
  const preciseCount = anchors.filter((a) => a.kind !== "module").length;
  if (preciseCount > 0) {
    return {
      mode: "precise",
      reason: `${preciseCount} exported symbol${preciseCount === 1 ? "" : "s"}`,
    };
  }
  if (anchors.length > 0) {
    return { mode: "coarse", reason: "no exported symbols" };
  }
  return { mode: "coarse", reason: "no anchorable content" };
}

export const goAdapter: LanguageAdapter = {
  language: "go",
  matches: (path) => /\.go$/.test(path),
  anchors: goAnchors,
  classify: classifyGoFile,
  warm: warmGoAdapter,
};
