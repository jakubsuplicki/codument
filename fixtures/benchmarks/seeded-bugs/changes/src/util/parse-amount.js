// Parse a user-supplied amount string into a number.

export function parseAmount(input) {
  const value = Number(input);
  return Number.isFinite(value) ? value : 0;
}
