export function normalizeTimezone(timezone: string | null | undefined): string {
  const value = timezone?.trim();
  return value && value.includes("/") ? value : "UTC";
}
