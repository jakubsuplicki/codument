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

// The precise JVM adapter — Java AND Kotlin under ONE anchor model, two
// grammars. Mixed Java/Kotlin repos are the norm in the enterprise segment
// this targets; shipping one without the other would leave those repos
// half-gated, which is worse than ungated (a false sense of coverage). So this
// is a single adapter with a per-dialect front-end feeding shared identity,
// closure, and residual machinery.
//
// Identity is the class-shaped scheme the C# adapter established: types anchor
// as `Name#` frames, members as `Name#method().` / `Name#field.`, nested types
// chain (`Outer#Inner#`). Kotlin's top-level declarations (functions,
// properties, types with no enclosing class) key by bare name — `topLevel().`,
// `MAX.`, `Point#` — exactly as Go and Rust top-level items do.
//
// Public rule — deliberately NOT identical across the two dialects, because the
// languages disagree on what "no modifier" means:
//   • Java: `public` and `protected` anchor (protected is inheritance
//     contract). Package-private (no modifier) and `private` are the closure
//     pool — Java's default is the ABSENCE of a keyword, so it reads as "not
//     yet a declared contract," unlike C#'s explicit `internal`.
//   • Kotlin: the default visibility IS public, so every non-`private`
//     declaration and member anchors; `internal` counts as public within the
//     repo (the `pub(crate)` / C# `internal` decision, restated for an explicit
//     keyword).
// Interface / annotation-type members are implicitly public in both and always
// anchor.
//
// Split calibration: a member's annotations, modifiers, name, type parameters,
// parameters, and return/declared type are contract; method/function/accessor
// BODIES and field/property initializers are ackable body. Annotations are
// contract — they are framework wiring (`@Transactional`, `@GetMapping`,
// `@Service` ARE the interface). A Kotlin data class's primary-constructor
// parameter list is contract in full (it is the equality / destructuring
// surface). Enums anchor whole: their variants are the type's surface.
// Overloads fold into one anchor per name with every overload signature hashed
// in source order.

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let javaLanguage: Language | null = null;
let kotlinLanguage: Language | null = null;

/** Load BOTH bundled JVM grammars so the sync gate path can parse either
 *  dialect. Idempotent; the command layer awaits it up front. */
export async function warmJvmAdapter(): Promise<void> {
  if (!javaLanguage) javaLanguage = await loadLanguage("java");
  if (!kotlinLanguage) kotlinLanguage = await loadLanguage("kotlin");
}

type Dialect = "java" | "kotlin";

function dialectFor(path: string): Dialect {
  return /\.java$/.test(path) ? "java" : "kotlin";
}

function requireWarm(dialect: Dialect): Language {
  const lang = dialect === "java" ? javaLanguage : kotlinLanguage;
  if (!lang) {
    throw new TreeSitterError(
      `${dialect} grammar not loaded — the command layer must warm adapters before the sync gate path runs`,
    );
  }
  return lang;
}

export type JvmAnchorKind = "type" | "method" | "property" | "variable" | "module";

interface JvmDecl {
  /** Full chain WITHOUT the trailing descriptor: `Outer#Inner`, `Foo#bar`, or
   *  a bare `topLevel` for a Kotlin top-level declaration. */
  chain: string;
  kind: "type" | "method" | "property" | "variable";
  nodes: Node[];
}

function anchorId(path: string, decl: JvmDecl): string {
  switch (decl.kind) {
    case "type":
      return `${path}::${decl.chain}#`;
    case "method":
      return `${path}::${decl.chain}().`;
    default:
      return `${path}::${decl.chain}.`;
  }
}

// A comment carries no contract in any dialect; skip every comment node type
// (Java `line_comment`/`block_comment`, Kotlin `line_comment`/
// `multiline_comment`) so a reworded doc comment never moves a fingerprint.
function isComment(node: Node): boolean {
  return node.type.includes("comment");
}

function tokenStreamHash(nodes: readonly Node[], exclude?: ReadonlySet<number>): string {
  const hash = createHash("sha256");
  const walk = (n: Node): void => {
    if (exclude?.has(n.id)) return;
    if (isComment(n)) return;
    if (n.childCount === 0) {
      if (n.text.length === 0) return;
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

// Reference names for the closure. Scope-blind on purpose: we collect every
// identifier-shaped leaf and later intersect against the private pool. Both
// grammars name references with `identifier`; the extra `simple_identifier` /
// `type_identifier` cases are harmless defensive coverage for any tree-sitter
// leaf shape. Over-collecting a builtin like `Int` matches no private
// declaration, and over-waking never launders a real change.
function collectIdentifiers(nodes: readonly Node[], exclude?: ReadonlySet<number>): Set<string> {
  const refs = new Set<string>();
  const walk = (n: Node): void => {
    if (exclude?.has(n.id)) return;
    if (n.type === "identifier" || n.type === "simple_identifier" || n.type === "type_identifier") {
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

function firstChildOfType(node: Node, type: string): Node | undefined {
  return node.namedChildren.find((c) => c.type === type);
}

function hasChildOfType(node: Node, type: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === type) return true;
  }
  return false;
}

function modifiersNode(node: Node): Node | undefined {
  return firstChildOfType(node, "modifiers");
}

// Java: public / protected anchor; package-private (no modifier) and private
// are the closure pool. The modifiers node holds visibility as bare keyword
// children (`public`, `protected`, `private`) alongside annotations.
function javaMemberIsPublic(node: Node): boolean {
  const mods = modifiersNode(node);
  if (!mods) return false;
  return hasChildOfType(mods, "public") || hasChildOfType(mods, "protected");
}

// Kotlin: default is public; only an explicit `private` visibility modifier
// drops a declaration to the closure pool. `internal`/`protected`/`public`
// all anchor (internal is the repo-audience surface).
function kotlinIsPublic(node: Node): boolean {
  const mods = modifiersNode(node);
  if (!mods) return true;
  const vis = firstChildOfType(mods, "visibility_modifier");
  return !vis || vis.text !== "private";
}

// ── Dialect-neutral shape helpers, branched by grammar where the vocabularies
// diverge. ──────────────────────────────────────────────────────────────────

const JAVA_TYPE_NODES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

function isEnumType(node: Node, dialect: Dialect): boolean {
  if (dialect === "java") return node.type === "enum_declaration";
  // The `ng` Kotlin grammar nests the `enum` keyword under `modifiers →
  // class_modifier`, so a direct-child scan for it misses every enum and drops
  // its variants into the coarse residual. The reliable, grammar-accurate
  // signal is the enum-specific body node, which IS a direct child.
  return node.type === "class_declaration" && hasChildOfType(node, "enum_class_body");
}

function isInterfaceType(node: Node, dialect: Dialect): boolean {
  if (dialect === "java") {
    return node.type === "interface_declaration" || node.type === "annotation_type_declaration";
  }
  return node.type === "class_declaration" && hasChildOfType(node, "interface");
}

function typeBodyOf(node: Node, dialect: Dialect): Node | undefined {
  if (dialect === "java") return node.childForFieldName("body") ?? undefined;
  return (
    firstChildOfType(node, "class_body") ??
    firstChildOfType(node, "enum_class_body") ??
    firstChildOfType(node, "enum_body")
  );
}

function typeName(node: Node, dialect: Dialect): string | undefined {
  // Both grammars expose the declared name through the `name` field. A Kotlin
  // `companion object { ... }` is name-less by design — it keys as `Companion`.
  const named = node.childForFieldName("name")?.text;
  if (named) return named;
  if (dialect === "kotlin" && node.type === "companion_object") return "Companion";
  return undefined;
}

// The ackable body regions of a member: bodies and initializers. Everything
// else in the declaration is contract.
function memberBodies(node: Node, dialect: Dialect): Node[] {
  const bodies: Node[] = [];
  if (dialect === "java") {
    const body = node.childForFieldName("body");
    if (body) bodies.push(body);
    if (node.type === "field_declaration") {
      for (const declr of node.namedChildren) {
        if (declr.type !== "variable_declarator") continue;
        const value = declr.childForFieldName("value");
        if (value) bodies.push(value);
      }
    }
  } else {
    if (node.type === "function_declaration") {
      const body = firstChildOfType(node, "function_body");
      if (body) bodies.push(body);
    } else if (node.type === "secondary_constructor") {
      // A secondary constructor's block is impl; its parameter list is
      // contract, so split it like a method rather than hashing whole.
      const body = firstChildOfType(node, "block");
      if (body) bodies.push(body);
    } else if (node.type === "property_declaration") {
      // A custom getter/setter body is impl; the initializer is everything
      // after the `variable_declaration` (`val x: Int = expr` → `expr`).
      const varIdx = node.namedChildren.findIndex((c) => c.type === "variable_declaration");
      node.namedChildren.forEach((child, i) => {
        if (child.type === "getter" || child.type === "setter") bodies.push(child);
        else if (varIdx !== -1 && i > varIdx) bodies.push(child);
      });
    }
  }
  return [...new Map(bodies.map((b) => [b.id, b])).values()];
}

// ── Collection ────────────────────────────────────────────────────────────

interface Collected {
  decls: JvmDecl[];
  privateByName: Map<string, Node[]>;
  residual: Node[][];
}

function javaFieldNames(node: Node): string[] {
  return node.namedChildren
    .filter((n) => n.type === "variable_declarator")
    .map((n) => n.childForFieldName("name")?.text)
    .filter((n): n is string => !!n);
}

function kotlinPropertyName(node: Node): string | undefined {
  const decl = firstChildOfType(node, "variable_declaration");
  if (!decl) return undefined;
  return firstChildOfType(decl, "identifier")?.text;
}

function collectJava(root: Node): Collected {
  const decls: JvmDecl[] = [];
  const privateByName = new Map<string, Node[]>();
  const residual: Node[][] = [];

  const addPrivate = (name: string, nodes: Node[]): void => {
    const existing = privateByName.get(name);
    if (existing) existing.push(...nodes);
    else privateByName.set(name, [...nodes]);
  };

  const walkType = (typeNode: Node, prefix: string): void => {
    const name = typeName(typeNode, "java");
    if (!name) {
      residual.push([typeNode]);
      return;
    }
    const chain = prefix ? `${prefix}#${name}` : name;
    if (javaMemberIsPublic(typeNode)) {
      decls.push({ chain, kind: "type", nodes: [typeNode] });
    } else {
      addPrivate(name, [typeNode]);
    }
    if (isEnumType(typeNode, "java")) return;
    const body = typeBodyOf(typeNode, "java");
    if (!body) return;
    walkMembers(body.namedChildren, chain, name, isInterfaceType(typeNode, "java"));
  };

  const walkMembers = (
    children: readonly Node[],
    chain: string,
    typeNm: string,
    isInterface: boolean,
  ): void => {
    for (const member of children) {
      if (isComment(member)) continue;
      if (JAVA_TYPE_NODES.has(member.type)) {
        walkType(member, chain);
        continue;
      }
      const anchored = isInterface || javaMemberIsPublic(member);
      if (member.type === "method_declaration" || member.type === "constructor_declaration") {
        const mName = member.childForFieldName("name")?.text ?? typeNm;
        if (anchored) decls.push({ chain: `${chain}#${mName}`, kind: "method", nodes: [member] });
        else addPrivate(mName, [member]);
      } else if (member.type === "field_declaration" || member.type === "constant_declaration") {
        for (const fName of javaFieldNames(member)) {
          if (anchored) decls.push({ chain: `${chain}#${fName}`, kind: "variable", nodes: [member] });
          else addPrivate(fName, [member]);
        }
      } else if (member.type === "annotation_type_element_declaration") {
        // An `@interface`'s elements are its contract surface — an element
        // rename or type change breaks every use site. Anchor them
        // method-shaped (`Route#value().`); the default value rides the
        // signature (changing it changes behavior for callers that omit it).
        const mName = member.childForFieldName("name")?.text ?? typeNm;
        if (anchored) decls.push({ chain: `${chain}#${mName}`, kind: "method", nodes: [member] });
        else addPrivate(mName, [member]);
      } else if (member.type === "enum_constant") {
        // Enum bodies are hashed whole, so a stray constant here is defensive.
        residual.push([member]);
      } else {
        residual.push([member]);
      }
    }
  };

  for (const item of root.namedChildren) {
    if (isComment(item)) continue;
    if (JAVA_TYPE_NODES.has(item.type)) {
      walkType(item, "");
      continue;
    }
    residual.push([item]);
  }
  return { decls, privateByName, residual };
}

function collectKotlin(root: Node): Collected {
  const decls: JvmDecl[] = [];
  const privateByName = new Map<string, Node[]>();
  const residual: Node[][] = [];

  const addPrivate = (name: string, nodes: Node[]): void => {
    const existing = privateByName.get(name);
    if (existing) existing.push(...nodes);
    else privateByName.set(name, [...nodes]);
  };

  const isTypeNode = (n: Node): boolean =>
    n.type === "class_declaration" ||
    n.type === "object_declaration" ||
    n.type === "companion_object";

  const walkType = (typeNode: Node, prefix: string): void => {
    const name = typeName(typeNode, "kotlin");
    if (!name) {
      residual.push([typeNode]);
      return;
    }
    const chain = prefix ? `${prefix}#${name}` : name;
    if (kotlinIsPublic(typeNode)) {
      decls.push({ chain, kind: "type", nodes: [typeNode] });
    } else {
      addPrivate(name, [typeNode]);
    }
    if (isEnumType(typeNode, "kotlin")) return;
    const body = typeBodyOf(typeNode, "kotlin");
    if (!body) return;
    walkMembers(body.namedChildren, chain, isInterfaceType(typeNode, "kotlin"));
  };

  const walkMembers = (
    children: readonly Node[],
    chain: string,
    isInterface: boolean,
  ): void => {
    for (const member of children) {
      if (isComment(member)) continue;
      if (isTypeNode(member)) {
        walkType(member, chain);
        continue;
      }
      const anchored = isInterface || kotlinIsPublic(member);
      if (member.type === "function_declaration") {
        const mName = member.childForFieldName("name")?.text;
        if (!mName) continue;
        if (anchored) decls.push({ chain: `${chain}#${mName}`, kind: "method", nodes: [member] });
        else addPrivate(mName, [member]);
      } else if (member.type === "secondary_constructor") {
        // All secondary constructors fold into one bounded identity per type.
        if (anchored) decls.push({ chain: `${chain}#constructor`, kind: "method", nodes: [member] });
        else addPrivate(`${chain}-constructor`, [member]);
      } else if (member.type === "property_declaration") {
        const mName = kotlinPropertyName(member);
        if (!mName) {
          residual.push([member]);
          continue;
        }
        if (anchored) decls.push({ chain: `${chain}#${mName}`, kind: "property", nodes: [member] });
        else addPrivate(mName, [member]);
      } else {
        residual.push([member]);
      }
    }
  };

  for (const item of root.namedChildren) {
    if (isComment(item)) continue;
    if (isTypeNode(item)) {
      walkType(item, "");
      continue;
    }
    if (item.type === "function_declaration") {
      const mName = item.childForFieldName("name")?.text;
      if (!mName) {
        residual.push([item]);
        continue;
      }
      if (kotlinIsPublic(item)) decls.push({ chain: mName, kind: "method", nodes: [item] });
      else addPrivate(mName, [item]);
      continue;
    }
    if (item.type === "property_declaration") {
      const mName = kotlinPropertyName(item);
      if (mName && kotlinIsPublic(item)) {
        decls.push({ chain: mName, kind: "property", nodes: [item] });
      } else if (mName) {
        addPrivate(mName, [item]);
      } else {
        residual.push([item]);
      }
      continue;
    }
    residual.push([item]);
  }
  return { decls, privateByName, residual };
}

// ── Fingerprinting (dialect-parameterized, shape identical to C#) ────────────

function closureFromNames(
  seeds: Iterable<string>,
  privateByName: ReadonlyMap<string, Node[]>,
): { name: string; hash: string }[] {
  const included = new Map<string, Node[]>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const ref = stack.pop();
    if (ref === undefined) continue;
    const declNodes = privateByName.get(ref);
    if (declNodes && !included.has(ref)) {
      included.set(ref, declNodes);
      for (const r of collectIdentifiers(declNodes)) stack.push(r);
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

function bodyRegions(decl: JvmDecl, dialect: Dialect): { excludeIds: Set<number>; bodies: Node[] } {
  if (decl.kind === "type") {
    const excludeIds = new Set<number>();
    for (const node of decl.nodes) {
      if (isEnumType(node, dialect)) continue; // enums hash whole; variants are surface
      const body = typeBodyOf(node, dialect);
      if (body) excludeIds.add(body.id);
    }
    return { excludeIds, bodies: [] };
  }
  return { excludeIds: new Set(), bodies: decl.nodes.flatMap((n) => memberBodies(n, dialect)) };
}

function jvmFingerprintPair(
  decl: JvmDecl,
  privateByName: ReadonlyMap<string, Node[]>,
  dialect: Dialect,
): { signature: string; fingerprint: string; closureNames: Set<string> } {
  const { excludeIds, bodies } = bodyRegions(decl, dialect);
  const bodyIds: ReadonlySet<number> = new Set([...excludeIds, ...bodies.map((b) => b.id)]);
  const sigRefs = collectIdentifiers(decl.nodes, bodyIds);
  const bodyRefs = collectIdentifiers(bodies);
  const sigMembers = closureFromNames(sigRefs, privateByName);
  const sigNames = new Set(sigMembers.map((m) => m.name));
  const bodyMembers = closureFromNames(bodyRefs, privateByName).filter((m) => !sigNames.has(m.name));
  const signature = compositeHash(tokenStreamHash(decl.nodes, bodyIds), sigMembers);
  const body = compositeHash(tokenStreamHash(bodies), bodyMembers);
  return {
    signature,
    fingerprint: sha256(`${signature}\n${body}`),
    closureNames: new Set([...sigNames, ...bodyMembers.map((m) => m.name)]),
  };
}

export function jvmAnchors(path: string, content: string): Anchor[] {
  const dialect = dialectFor(path);
  const language = requireWarm(dialect);
  const tree = parseSync(language, byteNormalize(content));
  try {
    const { decls, privateByName, residual } =
      dialect === "java" ? collectJava(tree.rootNode) : collectKotlin(tree.rootNode);

    // Overloads and same-identity fragments fold (nodes concat, source order
    // preserved by walk order).
    const byId = new Map<string, JvmDecl>();
    for (const d of decls) {
      const id = anchorId("", d);
      const existing = byId.get(id);
      if (existing) existing.nodes.push(...d.nodes);
      else byId.set(id, { ...d, nodes: [...d.nodes] });
    }

    const anchors: Anchor[] = [];
    const closureCovered = new Set<string>();
    for (const d of byId.values()) {
      const pair = jvmFingerprintPair(d, privateByName, dialect);
      for (const n of pair.closureNames) closureCovered.add(n);
      anchors.push({
        id: anchorId(path, d),
        fingerprint: pair.fingerprint,
        signature: pair.signature,
        name: d.chain,
        kind: d.kind,
      });
    }

    const residualSpans: string[] = [];
    for (const nodes of residual) residualSpans.push(tokenStreamHash(nodes));
    for (const [name, nodes] of privateByName) {
      if (closureCovered.has(name)) continue;
      residualSpans.push(tokenStreamHash(nodes));
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

export type JvmFileMode = "precise" | "coarse" | "unevaluable";

export interface JvmClassification {
  mode: JvmFileMode;
  reason: string;
}

export function classifyJvmFile(path: string, content: string): JvmClassification {
  const dialect = dialectFor(path);
  const language = requireWarm(dialect);
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
  const anchors = jvmAnchors(path, normalized);
  const preciseCount = anchors.filter((a) => a.kind !== "module").length;
  if (preciseCount > 0) {
    return {
      mode: "precise",
      reason: `${preciseCount} public symbol${preciseCount === 1 ? "" : "s"}`,
    };
  }
  if (anchors.length > 0) {
    return { mode: "coarse", reason: "no public declarations" };
  }
  return { mode: "coarse", reason: "no anchorable content" };
}

export const jvmAdapter: LanguageAdapter = {
  language: "jvm",
  matches: (path) => /\.(java|kt|kts)$/.test(path),
  anchors: jvmAnchors,
  classify: classifyJvmFile,
  warm: warmJvmAdapter,
};
