// Parse a user-supplied amount string into a number.

export function parseAmount(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`invalid amount: ${input}`);
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid amount: ${input}`);
  }
  return value;
}
