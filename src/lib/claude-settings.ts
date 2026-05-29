export const CLAUDE_DOCS_HOOK_COMMAND =
  "node node_modules/codument/dist/hooks/check-docs.js";
export const CLAUDE_DOCS_HOOK_MATCHER = "Write|Edit|MultiEdit";

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

  if (entry.command === CLAUDE_DOCS_HOOK_COMMAND) {
    return { cleanedEntry: null, containedCodumentHook: true };
  }

  if (!Array.isArray(entry.hooks)) {
    return { cleanedEntry: entry, containedCodumentHook: false };
  }

  const cleanedHooks = entry.hooks.filter(
    (hook) => !isObject(hook) || hook.command !== CLAUDE_DOCS_HOOK_COMMAND,
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
