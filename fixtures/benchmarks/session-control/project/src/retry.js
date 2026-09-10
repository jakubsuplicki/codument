export function retryDelay(attempt) {
  return 1000 * 2 ** attempt;
}
