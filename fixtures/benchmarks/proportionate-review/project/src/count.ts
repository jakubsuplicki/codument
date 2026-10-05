export function parseCount(raw: string): number | null {
  const count = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) return null;
  return count;
}
