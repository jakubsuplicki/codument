/** The hook target, relative to the project root (the cwd hooks run from). */
export const CLAUDE_DOCS_HOOK_TARGET = "node_modules/codument/dist/hooks/check-docs.js";
// Guarded invocation: a nudge hook must NEVER break the editor loop. The bare
// `node <target>` form stacked MODULE_NOT_FOUND + exit 1 on every Write/Edit
// when codument was not in local node_modules (npx-cache-only or global
// installs). The guard exits 0 silently when the target is absent; a
// same-process dynamic import keeps stdin available to the hook script, and the
// file URL form resolves on Windows paths too.
export const CLAUDE_DOCS_HOOK_COMMAND =
  `node -e "const p='${CLAUDE_DOCS_HOOK_TARGET}';if(!require('fs').existsSync(p))process.exit(0);import(require('url').pathToFileURL(p).href).catch(()=>process.exit(0))"`;
export const CLAUDE_DOCS_HOOK_MATCHER = "Write|Edit|MultiEdit";

// Recognize OUR hook by its stable target path rather than exact command
// equality, so an older install's command form (e.g. the unguarded `node
// <target>`) is still recognized and replaced by the canonical one instead of
// accumulating beside it.
function isCodumentHookCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(CLAUDE_DOCS_HOOK_TARGET);
}

type JsonObject = Record<string, unknown>;

export interface ClaudeSettingsHookResult {
  settings: JsonObject;
  changed: boolean;
  foundExistingHook: boolean;
}

export function ensureClaudeDocsHook(
  input: JsonObject = {},
): ClaudeSettingsHookResult {
  const settings = { ...input };
  const hooks = isObject(settings.hooks) ? { ...settings.hooks } : {};
  const postToolUse = Array.isArray(hooks.PostToolUse)
    ? [...hooks.PostToolUse]
    : [];

  const nextPostToolUse: unknown[] = [];
  let foundExistingHook = false;
  let insertedCanonicalHook = false;

  for (const entry of postToolUse) {
    const { cleanedEntry, containedCodumentHook } = removeCodumentHook(entry);

    if (containedCodumentHook) {
      foundExistingHook = true;
      if (cleanedEntry) {
        nextPostToolUse.push(cleanedEntry);
      }
      if (!insertedCanonicalHook) {
        nextPostToolUse.push(buildClaudeDocsHook());
        insertedCanonicalHook = true;
      }
      continue;
    }

    nextPostToolUse.push(entry);
  }

  if (!insertedCanonicalHook) {
    nextPostToolUse.push(buildClaudeDocsHook());
  }

  hooks.PostToolUse = nextPostToolUse;
  settings.hooks = hooks;

  return {
    settings,
    changed: JSON.stringify(input) !== JSON.stringify(settings),
    foundExistingHook,
  };
}

function buildClaudeDocsHook(): JsonObject {
  return {
    matcher: CLAUDE_DOCS_HOOK_MATCHER,
    hooks: [
      {
        type: "command",
        command: CLAUDE_DOCS_HOOK_COMMAND,
      },
    ],
  };
}

function removeCodumentHook(entry: unknown): {
  cleanedEntry: unknown | null;
  containedCodumentHook: boolean;
} {
  if (!isObject(entry)) {
    return { cleanedEntry: entry, containedCodumentHook: false };
  }

  if (isCodumentHookCommand(entry.command)) {
    return { cleanedEntry: null, containedCodumentHook: true };
  }

  if (!Array.isArray(entry.hooks)) {
    return { cleanedEntry: entry, containedCodumentHook: false };
  }

  const cleanedHooks = entry.hooks.filter(
    (hook) => !isObject(hook) || !isCodumentHookCommand(hook.command),
  );
  if (cleanedHooks.length === entry.hooks.length) {
    return { cleanedEntry: entry, containedCodumentHook: false };
  }

  if (cleanedHooks.length === 0) {
    return { cleanedEntry: null, containedCodumentHook: true };
  }

  return {
    cleanedEntry: {
      ...entry,
      hooks: cleanedHooks,
    },
    containedCodumentHook: true,
  };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
