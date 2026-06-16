// New file, IN the approved plan's scope (src/lib/ratelimit.ts). New files have
// no registry entry yet, so `review` should note it as unmapped-but-in-plan.

const hits = new Map<string, number>();

export function rateLimited(key: string, max: number): boolean {
  const n = (hits.get(key) ?? 0) + 1;
  hits.set(key, n);
  return n > max;
}
