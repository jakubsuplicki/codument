import { dirname, normalize } from "node:path/posix";
import ts from "typescript";

// First-party import harvesting from the same syntactic parse the anchors use.
// Two consumers: seeding shared-file symbol ownership (a shared-file symbol that
// references feature X's exclusively-owned files is attributed to X), and the
// facts/graph data contract (feature -> file -> file edges). Resolution is
// best-effort and first-party only: relative specifiers map their compiled
// extension back to source (`.js` -> `.ts`); bare/`node:`/package specifiers are
// external (resolved = null). The caller intersects `resolved` with the real file
// set — this module never touches the filesystem (deterministic, pure).

export interface ImportBinding {
  /** Local name the import introduces into the importing module's scope. */
  local: string;
  /** The raw module specifier as written. */
  specifier: string;
  /** Repo-relative source path the specifier resolves to, or null when the
   *  specifier is external/bare/unresolvable. */
  resolved: string | null;
}

// ESM output extensions mapped back to their TypeScript source extension.
const EXT_TO_SOURCE: Record<string, string> = {
  js: "ts",
  jsx: "tsx",
  mjs: "mts",
  cjs: "cts",
};
const SOURCE_EXTS = new Set(["ts", "tsx", "mts", "cts"]);

// Resolves a module specifier to a repo-relative source path, or null when it is
// not a first-party relative import. `.js`-style specifiers (ESM output) map back
// to `.ts` source; an already-source or extensionless specifier is best-effort.
export function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const joined = normalize(`${dirname(fromPath)}/${specifier}`);
  const m = /\.([a-z]+)$/.exec(joined);
  if (m) {
    const ext = m[1];
    if (EXT_TO_SOURCE[ext]) return `${joined.slice(0, -ext.length)}${EXT_TO_SOURCE[ext]}`;
    if (SOURCE_EXTS.has(ext)) return joined;
  }
  return `${joined}.ts`;
}

// Every named/default/namespace import binding in a file, with its resolved
// first-party source path. Side-effect imports (`import "./x.js"`) introduce no
// local name and so produce no binding (use `importedFiles` for the raw edges).
export function harvestImports(path: string, content: string): ImportBinding[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /* setParentNodes */ false);
  const bindings: ImportBinding[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const resolved = resolveSpecifier(path, specifier);
    const clause = stmt.importClause;
    if (!clause) continue; // side-effect import
    if (clause.name) bindings.push({ local: clause.name.text, specifier, resolved });
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      bindings.push({ local: nb.name.text, specifier, resolved });
    } else if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        bindings.push({ local: el.name.text, specifier, resolved });
      }
    }
  }
  return bindings;
}

// The deduped, sorted set of first-party source files a file imports — the
// outgoing edges in the import graph (side-effect imports included).
export function importedFiles(path: string, content: string): string[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /* setParentNodes */ false);
  const files = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const resolved = resolveSpecifier(path, stmt.moduleSpecifier.text);
    if (resolved) files.add(resolved);
  }
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
