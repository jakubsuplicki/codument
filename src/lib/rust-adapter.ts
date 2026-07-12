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

// The precise Rust adapter: visibility-literal anchors for the most
// contract-conscious ecosystem. ANY `pub` form (`pub`, `pub(crate)`,
// `pub(super)`, `pub(in …)`) makes an anchor — conservative on purpose:
// `pub(crate)` is invisible outside the crate but load-bearing inside the
// repo, which is the audience docs serve. Non-pub items form the closure pool.
//
// Descriptors: `fn` → `name().`; `struct`/`enum`/`trait`/`type`/`union` →
// `Name#`; `const`/`static` → `name.`; inherent-impl members →
// `Type#method().`; trait-impl members → `Type#Trait::method().` so a
// trait-impl swap is its own identity. Attributes — `#[derive(...)]` above
// all — are SIGNATURE: derives are contract.
//
// Honest bounds, stated: no macro expansion (a `macro_rules!` definition is
// one all-signature anchor — a macro IS contract — while item-position macro
// INVOCATIONS land in the residual, since expansion without rustc is
// fiction); `#[cfg(...)]` variants of one item fold into one anchor in source
// order; inline `mod { … }` blocks ride the residual whole (idiomatic crates
// put modules in files, where the gate already judges them).

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let rustLanguage: Language | null = null;

/** Load the bundled Rust grammar so the sync gate path can parse. Idempotent. */
export async function warmRustAdapter(): Promise<void> {
  if (!rustLanguage) rustLanguage = await loadLanguage("rust");
}

function requireWarm(): Language {
  if (!rustLanguage) {
    throw new TreeSitterError(
      "rust grammar not loaded — the command layer must warm adapters before the sync gate path runs",
    );
  }
  return rustLanguage;
}

export type RustAnchorKind =
  | "function"
  | "method"
  | "type"
  | "variable"
  | "macro"
  | "module";

interface RustDecl {
  name: string;
  kind: "function" | "method" | "type" | "variable" | "macro";
  /** `Type` for an inherent-impl member; `Type#Trait::` folds into the id. */
  qualifier?: string;
  nodes: Node[];
}

function anchorId(path: string, decl: RustDecl): string {
  switch (decl.kind) {
    case "function":
      return `${path}::${decl.name}().`;
    case "method":
      return `${path}::${decl.qualifier}${decl.name}().`;
    case "type":
      return `${path}::${decl.name}#`;
    case "macro":
      return `${path}::${decl.name}().`;
    default:
      return `${path}::${decl.name}.`;
  }
}

function tokenStreamHash(nodes: readonly Node[], exclude?: ReadonlySet<number>): string {
  const hash = createHash("sha256");
  const walk = (n: Node): void => {
    if (exclude?.has(n.id)) return;
    if (n.childCount === 0) {
      if (n.type === "line_comment" || n.type === "block_comment" || n.text.length === 0) return;
      hash.update(`${Buffer.byteLength(n.text, "utf8")}:`);
      hash.update(n.text, "utf8");
      return;
    }
    // Comments can be interior nodes with children in this grammar (doc
    // comments); fold them wholesale.
    if (n.type === "line_comment" || n.type === "block_comment") return;
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
    if (n.type === "identifier" || n.type === "type_identifier" || n.type === "field_identifier") {
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

function hasVisibility(item: Node): boolean {
  return item.namedChildren.some((n) => n.type === "visibility_modifier");
}

// The impl target's base name: `Server`, `Server<T>` → `Server`.
function implTypeBase(typeNode: Node | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "generic_type") {
    const inner = typeNode.childForFieldName("type");
    return inner?.type === "type_identifier" ? inner.text : (inner?.text ?? null);
  }
  return typeNode.text.split("<")[0] || null;
}

const ITEM_KINDS: Record<string, RustDecl["kind"]> = {
  function_item: "function",
  struct_item: "type",
  enum_item: "type",
  trait_item: "type",
  type_item: "type",
  union_item: "type",
  const_item: "variable",
  static_item: "variable",
  macro_definition: "macro",
};

// Walk a declaration list, attaching each run of preceding `attribute_item`s
// to the item that follows (derives are part of the item's surface).
function itemsWithAttributes(children: readonly Node[]): { item: Node; nodes: Node[] }[] {
  const out: { item: Node; nodes: Node[] }[] = [];
  let pending: Node[] = [];
  for (const child of children) {
    if (child.type === "attribute_item") {
      pending.push(child);
      continue;
    }
    if (child.type === "line_comment" || child.type === "block_comment") continue;
    out.push({ item: child, nodes: [...pending, child] });
    pending = [];
  }
  return out;
}

export function rustAnchors(path: string, content: string): Anchor[] {
  const language = requireWarm();
  const tree = parseSync(language, byteNormalize(content));
  try {
    const entries = itemsWithAttributes(tree.rootNode.namedChildren);
    const decls: RustDecl[] = [];
    const privateByName = new Map<string, Node[]>();
    const residualEntries: Node[][] = [];

    const addPrivate = (name: string, nodes: Node[]): void => {
      const existing = privateByName.get(name);
      if (existing) existing.push(...nodes);
      else privateByName.set(name, [...nodes]);
    };

    for (const { item, nodes } of entries) {
      const kind = ITEM_KINDS[item.type];
      if (kind) {
        const name = item.childForFieldName("name")?.text;
        if (!name) {
          residualEntries.push(nodes);
          continue;
        }
        // A macro definition is crate-reachable contract regardless of `pub`
        // (`#[macro_export]` widens it further); everything else follows the
        // visibility literal.
        if (kind === "macro" || hasVisibility(item)) {
          decls.push({ name, kind, nodes });
        } else {
          // Non-pub item: closure pool; if nothing public reaches it, the
          // uncovered-privates pass below folds it into the residual.
          addPrivate(name, nodes);
        }
        continue;
      }
      if (item.type === "impl_item") {
        const typeBase = implTypeBase(item.childForFieldName("type"));
        const traitText = item.childForFieldName("trait")?.text ?? null;
        const body = item.childForFieldName("body");
        if (!typeBase || !body) {
          residualEntries.push(nodes);
          continue;
        }
        for (const member of itemsWithAttributes(body.namedChildren)) {
          const mKind = ITEM_KINDS[member.item.type];
          const mName = member.item.childForFieldName("name")?.text;
          if (!mKind || !mName) continue;
          if (traitText) {
            // Trait-impl members ARE the trait's contract for this type —
            // all of them anchor, under a trait-qualified identity.
            decls.push({
              name: mName,
              kind: "method",
              qualifier: `${typeBase}#${traitText}::`,
              nodes: member.nodes,
            });
          } else if (hasVisibility(member.item)) {
            decls.push({
              name: mName,
              kind: "method",
              qualifier: `${typeBase}#`,
              nodes: member.nodes,
            });
          } else {
            addPrivate(mName, member.nodes);
          }
        }
        continue;
      }
      // use declarations, macro invocations at item position, inline mods,
      // inner attributes, stray expressions: residual.
      residualEntries.push(nodes);
    }

    // Merge same-identity decls (cfg variants of one item fold in source order).
    const byId = new Map<string, RustDecl>();
    for (const d of decls) {
      const id = anchorId(path, d);
      const existing = byId.get(id);
      if (existing) existing.nodes.push(...d.nodes);
      else byId.set(id, d);
    }

    const anchors: Anchor[] = [];
    const closureCovered = new Set<string>();
    for (const d of byId.values()) {
      const pair = rustFingerprintPair(d, privateByName);
      for (const n of pair.closureNames) closureCovered.add(n);
      anchors.push({
        id: anchorId(path, d),
        fingerprint: pair.fingerprint,
        signature: pair.signature,
        name: d.qualifier ? `${d.qualifier}${d.name}` : d.name,
        kind: d.kind,
      });
    }

    const residualSpans: string[] = [];
    for (const nodes of residualEntries) {
      if (nodes.length === 0) continue;
      residualSpans.push(tokenStreamHash(nodes));
    }
    // Uncovered private items stay visible through the residual.
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

// The ackable body regions. fn: the block. struct: NON-pub named fields
// (private representation), while pub fields, attributes, generics, and
// where-clauses stay contract. enum: variants are all signature (they are the
// type's surface). const/static: the value (the settings calibration). Macro
// definitions: all signature — a macro is contract.
function bodyRegionsOf(decl: RustDecl): Node[] {
  const bodies: Node[] = [];
  for (const node of decl.nodes) {
    if (node.type === "function_item") {
      const b = node.childForFieldName("body");
      if (b) bodies.push(b);
    } else if (node.type === "struct_item") {
      const b = node.childForFieldName("body");
      if (b?.type === "field_declaration_list") {
        for (const f of b.namedChildren) {
          if (f.type === "field_declaration" && !hasVisibility(f)) bodies.push(f);
        }
      }
    } else if (node.type === "const_item" || node.type === "static_item") {
      const v = node.childForFieldName("value");
      if (v) bodies.push(v);
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

function rustFingerprintPair(
  decl: RustDecl,
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

export type RustFileMode = "precise" | "coarse" | "unevaluable";

export interface RustClassification {
  mode: RustFileMode;
  reason: string;
}

export function classifyRustFile(path: string, content: string): RustClassification {
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
  const anchors = rustAnchors(path, normalized);
  const preciseCount = anchors.filter((a) => a.kind !== "module").length;
  if (preciseCount > 0) {
    return {
      mode: "precise",
      reason: `${preciseCount} public item${preciseCount === 1 ? "" : "s"}`,
    };
  }
  if (anchors.length > 0) {
    return { mode: "coarse", reason: "no public items" };
  }
  return { mode: "coarse", reason: "no anchorable content" };
}

export const rustAdapter: LanguageAdapter = {
  language: "rust",
  matches: (path) => /\.rs$/.test(path),
  anchors: rustAnchors,
  classify: classifyRustFile,
  warm: warmRustAdapter,
};
