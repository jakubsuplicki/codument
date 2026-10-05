import { parseCount } from "./count.js";

export function renderCount(count: number): string {
  return `Pieces: ${count + 1}`;
}

const count = parseCount(process.argv[2] ?? "");
if (count === null) {
  console.error("Count must contain only decimal digits and be between 1 and 20.");
  process.exitCode = 1;
} else {
  console.log(renderCount(count));
}
