import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Language, Tree } from "web-tree-sitter";
import { ownPackageRoot } from "./version.js";

// The parsing substrate behind every precise language adapter after TypeScript.
// The determinism contract decides the mechanism: a parse must be a pure
// function of (content bytes, grammar bytes, runtime bytes), all three pinned
// by the installed package version — never a function of whatever toolchain the
// machine happens to have. So grammars are tree-sitter binaries compiled to
// WASM, bundled under `grammars/` at the package root, and loaded through the
// pinned `web-tree-sitter` runtime; shelling out to an ambient interpreter is
// forbidden on the verdict path (the ADR-013 lineage).
//
// Everything here is lazy: importing this module evaluates no WASM — the
// runtime initializes on the first grammar load, so a TypeScript-only repo
// (whose adapter rides the bundled TS compiler) never pays a WASM init.
//
// Everything here fails LOUD. A missing or corrupt grammar binary raises
// TreeSitterError; it never degrades into a coarse whole-file verdict, because
// silent coarsening is exactly the false-fresh hole the classification work
// closed for TS. Whether a file is precise, coarse, or unevaluable stays an
// ADAPTER decision; the substrate only refuses to lie about being able to
// parse.

export class TreeSitterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TreeSitterError";
  }
}

export interface BundledGrammar {
  /** Adapter language id, e.g. "python" — the key `loadLanguage` accepts. */
  readonly language: string;
  /** Grammar binary filename under `grammars/` at the package root. */
  readonly file: string;
}

// One row per shipped adapter. Empty until the first adapter plan vendors its
// grammar; each language becomes "source" only in the plan that makes it
// judgeable, so this list and the extension spec grow together.
export const BUNDLED_GRAMMARS: readonly BundledGrammar[] = [];

export function grammarsDir(): string {
  return join(ownPackageRoot(), "grammars");
}

// The lazy runtime singleton. The emscripten module is imported dynamically so
// module evaluation costs nothing until a grammar is actually needed; the wasm
// binary is resolved from the pinned dependency, never fetched. A failed init
// is not cached as success: the promise is cleared so the error stays loud on
// every attempt instead of wedging into a half-initialized state.
type Runtime = typeof import("web-tree-sitter");
let runtimePromise: Promise<Runtime> | null = null;
let runtimeReady = false;

function runtime(): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const wts = await import("web-tree-sitter");
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
      await wts.Parser.init({ locateFile: () => wasmPath });
      runtimeReady = true;
      return wts;
    })();
    // A failed init must stay loud AND retryable: the promise is cleared so the
    // next call re-attempts instead of serving a cached rejection. Safe because
    // the pinned runtime only caches its emscripten module on SUCCESSFUL init
    // (verified at web-tree-sitter 0.26.10) — re-verify this on any bump.
    runtimePromise.catch(() => {
      runtimePromise = null;
    });
  }
  return runtimePromise;
}

/** True once the WASM runtime has initialized — the lazy-load observable. */
export function runtimeInitialized(): boolean {
  return runtimeReady;
}

const languageCache = new Map<string, Promise<Language>>();

/** The bundled grammar for a language id, loaded lazily and cached. */
export function loadLanguage(language: string): Promise<Language> {
  const cached = languageCache.get(language);
  if (cached) return cached;
  const bundled = BUNDLED_GRAMMARS.find((g) => g.language === language);
  if (!bundled) {
    return Promise.reject(
      new TreeSitterError(
        `no bundled grammar for language "${language}" — a language is judgeable only once its adapter ships a grammar under grammars/`,
      ),
    );
  }
  const loading = loadLanguageFromFile(join(grammarsDir(), bundled.file));
  languageCache.set(language, loading);
  loading.catch(() => {
    languageCache.delete(language);
  });
  return loading;
}

/** Load a grammar binary from an absolute path. Each call is a fresh load. */
export async function loadLanguageFromFile(absPath: string): Promise<Language> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absPath);
  } catch (err) {
    throw new TreeSitterError(
      `grammar binary unreadable at ${absPath} — the package is incomplete; refusing to fall back to a coarse verdict`,
      { cause: err },
    );
  }
  const { Language } = await runtime();
  try {
    return await Language.load(bytes);
  } catch (err) {
    throw new TreeSitterError(
      `grammar at ${absPath} failed to load — corrupt or ABI-incompatible binary; refusing to fall back to a coarse verdict`,
      { cause: err },
    );
  }
}

/** Parse content with a loaded grammar. The returned tree lives on the WASM
 *  heap until the caller deletes it or the process exits — fine for a one-shot
 *  CLI verdict; a long-lived caller (watch) must `tree.delete()` per tick. */
export async function parseWith(language: Language, content: string): Promise<Tree> {
  const { Parser } = await runtime();
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) {
      throw new TreeSitterError("tree-sitter returned no tree for the given content");
    }
    return tree;
  } finally {
    parser.delete();
  }
}

export interface GrammarManifestEntry {
  language: string;
  sha256: string;
}

/** The manifest over an explicit grammar set — the testable core. Sorted by
 *  language (codepoint order, locale-independent); a missing binary is a loud
 *  packaging error, never a silently shorter manifest. */
export function manifestFor(
  entries: readonly BundledGrammar[],
  dir: string,
): GrammarManifestEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.language)) {
      throw new TreeSitterError(
        `duplicate bundled grammar for language "${entry.language}" — the registry must map each language to exactly one binary`,
      );
    }
    seen.add(entry.language);
  }
  return [...entries]
    .sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0))
    .map((entry) => {
      const path = join(dir, entry.file);
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (err) {
        throw new TreeSitterError(
          `grammar binary for "${entry.language}" unreadable at ${path} — the manifest cannot omit a bundled language`,
          { cause: err },
        );
      }
      return {
        language: entry.language,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
}

let manifestCache: GrammarManifestEntry[] | null = null;

/** The bundled-grammar manifest: language → grammar content hash. This is the
 *  adapter segment of the determinism identity — a grammar upgrade changes it
 *  exactly like a TS version bump changes the compiler segment. */
export function grammarManifest(): readonly GrammarManifestEntry[] {
  if (!manifestCache) {
    manifestCache = manifestFor(BUNDLED_GRAMMARS, grammarsDir());
  }
  return manifestCache;
}

export type { Language, Node, Tree } from "web-tree-sitter";
