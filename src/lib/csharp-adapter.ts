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

// The precise C# adapter. Public rule: `public` and `protected` anchor, and
// `internal` counts as public WITHIN the repo (the established repo-audience
// rule — internal surface is what the repo's own docs describe); `private`
// members form the closure pool. Types anchor as `Name#` frames (attributes,
// modifiers, name, type params, base list, primary-constructor/record
// positional parameters — all contract); members anchor individually as
// `Name#member().` / `Name#property.`, nested types chain (`Outer#Inner#`).
//
// PARTIAL classes fold: every `partial class Foo` fragment in one file merges
// into that file's `Foo#` identity (the `partial` modifier itself rides the
// frame signature), and each fragment's members anchor under the same chain —
// a member moving between fragments in one file is invisible only if its
// bytes are unchanged, which is exactly the reordering-is-free rule.
//
// Split calibration: a member's attributes, modifiers, name, generics,
// parameters, and return type are contract; method/accessor BODIES and
// field/property initializers are ackable body. A property's declared
// accessor LIST (`get; set;` vs `get; init;`) is contract. Records' positional
// parameters are contract (they are the equality surface). Operators fold
// into one `Type#operator().` anchor and indexers into `Type#indexer().` —
// bounded naming, never silence. Top-level statements (minimal-hosting
// Program.cs) ride the `<module>` residual, order-hashed.

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let csLanguage: Language | null = null;

/** Load the bundled C# grammar so the sync gate path can parse. Idempotent. */
export async function warmCSharpAdapter(): Promise<void> {
  if (!csLanguage) csLanguage = await loadLanguage("c-sharp");
}

function requireWarm(): Language {
  if (!csLanguage) {
    throw new TreeSitterError(
      "c# grammar not loaded — the command layer must warm adapters before the sync gate path runs",
    );
  }
  return csLanguage;
}

export type CSharpAnchorKind = "type" | "method" | "property" | "variable" | "module";

interface CsDecl {
  /** Full chain WITHOUT the trailing descriptor: `Outer#Inner` or `Foo#Bar`. */
  chain: string;
  kind: "type" | "method" | "property" | "variable";
  nodes: Node[];
}

function anchorId(path: string, decl: CsDecl): string {
  switch (decl.kind) {
    case "type":
      return `${path}::${decl.chain}#`;
    case "method":
      return `${path}::${decl.chain}().`;
    default:
      return `${path}::${decl.chain}.`;
  }
}

function tokenStreamHash(nodes: readonly Node[], exclude?: ReadonlySet<number>): string {
  const hash = createHash("sha256");
  const walk = (n: Node): void => {
    if (exclude?.has(n.id)) return;
    if (n.type === "comment") return;
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

function modifiersOf(node: Node): string[] {
  return node.namedChildren.filter((n) => n.type === "modifier").map((n) => n.text);
}

// public / protected / internal anchor; explicit private (or no modifier —
// C#'s member default IS private) forms the closure pool.
function memberIsPublic(node: Node): boolean {
  const mods = modifiersOf(node);
  return mods.includes("public") || mods.includes("protected") || mods.includes("internal");
}

const TYPE_NODES = new Set([
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "record_declaration",
  "enum_declaration",
]);

const METHOD_NODES = new Set([
  "method_declaration",
  "constructor_declaration",
  "destructor_declaration",
]);

// The body regions of a member: block or expression body for methods and
// accessors, plus initializers. Everything else is contract.
function memberBodies(node: Node): Node[] {
  const bodies: Node[] = [];
  const direct = node.childForFieldName("body");
  if (direct && (direct.type === "block" || direct.type === "arrow_expression_clause")) {
    bodies.push(direct);
  }
  for (const child of node.namedChildren) {
    if (child.type === "arrow_expression_clause") bodies.push(child);
    if (child.type === "accessor_list") {
      for (const acc of child.namedChildren) {
        const b = acc.childForFieldName("body");
        if (b) bodies.push(b);
        for (const inner of acc.namedChildren) {
          if (inner.type === "arrow_expression_clause" || inner.type === "block") {
            bodies.push(inner);
          }
        }
      }
    }
    if (child.type === "variable_declaration") {
      for (const declr of child.namedChildren) {
        const init = declr.namedChildren.find((n) => n.type === "equals_value_clause");
        if (init) bodies.push(init);
      }
    }
    if (child.type === "equals_value_clause") bodies.push(child);
  }
  // A property initializer is a bare expression AFTER the accessor list
  // (`{ get; set; } = "localhost";` — no wrapper node): everything following
  // the accessor_list is the ackable default value.
  if (node.type === "property_declaration") {
    const accIdx = node.namedChildren.findIndex((n) => n.type === "accessor_list");
    if (accIdx !== -1) {
      for (const trailing of node.namedChildren.slice(accIdx + 1)) {
        bodies.push(trailing);
      }
    }
  }
  return [...new Map(bodies.map((b) => [b.id, b])).values()];
}

interface Collected {
  decls: CsDecl[];
  privateByName: Map<string, Node[]>;
  residual: Node[][];
}

function fieldNames(node: Node): string[] {
  const decl = node.namedChildren.find((n) => n.type === "variable_declaration");
  if (!decl) return [];
  return decl.namedChildren
    .filter((n) => n.type === "variable_declarator")
    .map((n) => n.childForFieldName("name")?.text)
    .filter((n): n is string => !!n);
}

function collect(root: Node): Collected {
  const decls: CsDecl[] = [];
  const privateByName = new Map<string, Node[]>();
  const residual: Node[][] = [];

  const addPrivate = (name: string, nodes: Node[]): void => {
    const existing = privateByName.get(name);
    if (existing) existing.push(...nodes);
    else privateByName.set(name, [...nodes]);
  };

  const walkContainer = (children: readonly Node[], prefix: string): void => {
    for (const item of children) {
      if (item.type === "comment") continue;
      if (
        item.type === "namespace_declaration" ||
        item.type === "file_scoped_namespace_declaration"
      ) {
        const body = item.childForFieldName("body");
        // File-scoped namespaces put members directly in following siblings —
        // the grammar nests them either way; walk whatever list exists.
        walkContainer((body ?? item).namedChildren, prefix);
        continue;
      }
      if (TYPE_NODES.has(item.type)) {
        walkType(item, prefix);
        continue;
      }
      if (item.type === "global_statement" || item.type === "using_directive") {
        residual.push([item]);
        continue;
      }
      residual.push([item]);
    }
  };

  const walkType = (typeNode: Node, prefix: string): void => {
    const name = typeNode.childForFieldName("name")?.text;
    if (!name) {
      residual.push([typeNode]);
      return;
    }
    const chain = prefix ? `${prefix}#${name}` : name;
    const isPublicType = memberIsPublic(typeNode);
    const body = typeNode.childForFieldName("body");

    // The type FRAME (everything but the member list) is the type's anchor:
    // attributes, modifiers, name, generics, bases, primary-ctor/record
    // parameters — csFingerprintPair excludes the member list at hash time.
    // An enum keeps its body: variants are the surface.
    if (isPublicType) {
      decls.push({ chain, kind: "type", nodes: [typeNode] });
    } else {
      addPrivate(name, [typeNode]);
    }

    if (!body || typeNode.type === "enum_declaration") return;
    for (const member of body.namedChildren) {
      if (member.type === "comment") continue;
      if (TYPE_NODES.has(member.type)) {
        walkType(member, chain);
        continue;
      }
      const isInterface = typeNode.type === "interface_declaration";
      const anchored = isInterface || memberIsPublic(member);
      if (METHOD_NODES.has(member.type)) {
        const mName = member.childForFieldName("name")?.text ?? name;
        if (anchored) decls.push({ chain: `${chain}#${mName}`, kind: "method", nodes: [member] });
        else addPrivate(mName, [member]);
      } else if (member.type === "property_declaration" || member.type === "event_declaration") {
        const mName = member.childForFieldName("name")?.text;
        if (!mName) continue;
        if (anchored) decls.push({ chain: `${chain}#${mName}`, kind: "property", nodes: [member] });
        else addPrivate(mName, [member]);
      } else if (member.type === "field_declaration" || member.type === "event_field_declaration") {
        for (const fName of fieldNames(member)) {
          if (anchored) decls.push({ chain: `${chain}#${fName}`, kind: "variable", nodes: [member] });
          else addPrivate(fName, [member]);
        }
      } else if (member.type === "operator_declaration" || member.type === "conversion_operator_declaration") {
        // All operators fold into one bounded identity per type.
        if (anchored) decls.push({ chain: `${chain}#operator`, kind: "method", nodes: [member] });
        else addPrivate(`${name}-operator`, [member]);
      } else if (member.type === "indexer_declaration") {
        if (anchored) decls.push({ chain: `${chain}#indexer`, kind: "method", nodes: [member] });
        else addPrivate(`${name}-indexer`, [member]);
      } else {
        // Unrecognized member shapes stay visible through the residual.
        residual.push([member]);
      }
    }
  };

  walkContainer(root.namedChildren, "");
  return { decls, privateByName, residual };
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

// A TYPE anchor hashes its frame only: the member list is excluded wholesale
// (members carry their own anchors; private members are reachable through
// closures or the residual). An enum hashes whole. Member anchors split on
// their bodies/initializers.
function csFingerprintPair(
  decl: CsDecl,
  privateByName: ReadonlyMap<string, Node[]>,
): { signature: string; fingerprint: string; closureNames: Set<string> } {
  let exclude: ReadonlySet<number> = new Set();
  let bodies: Node[] = [];
  if (decl.kind === "type") {
    const excluded: number[] = [];
    for (const node of decl.nodes) {
      if (node.type === "enum_declaration") continue;
      const body = node.childForFieldName("body");
      if (body) excluded.push(body.id);
    }
    exclude = new Set(excluded);
  } else {
    bodies = decl.nodes.flatMap(memberBodies);
  }
  const bodyIds: ReadonlySet<number> = new Set([...exclude, ...bodies.map((b) => b.id)]);
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

export function csharpAnchors(path: string, content: string): Anchor[] {
  const language = requireWarm();
  const tree = parseSync(language, byteNormalize(content));
  try {
    const { decls, privateByName, residual } = collect(tree.rootNode);

    // Partial fragments and same-identity members fold (nodes concat, source
    // order preserved by walk order).
    const byId = new Map<string, CsDecl>();
    for (const d of decls) {
      const id = anchorId("", d);
      const existing = byId.get(id);
      if (existing) existing.nodes.push(...d.nodes);
      else byId.set(id, { ...d, nodes: [...d.nodes] });
    }

    const anchors: Anchor[] = [];
    const closureCovered = new Set<string>();
    for (const d of byId.values()) {
      const pair = csFingerprintPair(d, privateByName);
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
    for (const nodes of residual) {
      residualSpans.push(tokenStreamHash(nodes));
    }
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

export type CSharpFileMode = "precise" | "coarse" | "unevaluable";

export interface CSharpClassification {
  mode: CSharpFileMode;
  reason: string;
}

export function classifyCSharpFile(path: string, content: string): CSharpClassification {
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
  const anchors = csharpAnchors(path, normalized);
  const preciseCount = anchors.filter((a) => a.kind !== "module").length;
  if (preciseCount > 0) {
    return {
      mode: "precise",
      reason: `${preciseCount} public member${preciseCount === 1 ? "" : "s"}`,
    };
  }
  if (anchors.length > 0) {
    return { mode: "coarse", reason: "no public members" };
  }
  return { mode: "coarse", reason: "no anchorable content" };
}

export const csharpAdapter: LanguageAdapter = {
  language: "c-sharp",
  matches: (path) => /\.cs$/.test(path),
  anchors: csharpAnchors,
  classify: classifyCSharpFile,
  warm: warmCSharpAdapter,
};
