export function totalCents(lines) {
  return lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
}
