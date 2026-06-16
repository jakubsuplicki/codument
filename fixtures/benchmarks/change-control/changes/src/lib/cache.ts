// New file, OUT of the approved plan's scope and unmapped in the registry.
// `review` should flag it as both unmapped and out-of-plan.

const store = new Map<string, unknown>();

export function cacheGet<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function cacheSet(key: string, value: unknown): void {
  store.set(key, value);
}
