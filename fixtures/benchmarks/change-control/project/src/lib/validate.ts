// Planted scenario: this file exists on disk and is imported by tasks logic,
// but it is NOT listed in any registry entry's sources. `doctor` should flag it
// as an unmapped in-scope source file (it lowers ownership coverage).

export function nonEmpty(value: string, field: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

export function maxLength(value: string, n: number, field: string): void {
  if (value.length > n) {
    throw new Error(`${field} must be at most ${n} characters`);
  }
}
