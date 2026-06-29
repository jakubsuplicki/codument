// Pure classification of a detector subprocess result, kept dependency-free so
// it can be reasoned about (and unit-tested) in isolation from the I/O-heavy
// scorer that spawns the process.

export type DetectorOutcome = "caught" | "survived";

/**
 * Turn a detector's process result into a verdict. A clean non-zero exit means
 * the bug is still present (survived); a clean zero exit means it is fixed
 * (caught). A run that did NOT complete — timeout, kill, or spawn failure
 * (status null, a signal, or an error) — carries no information about the bug,
 * so it throws rather than being silently miscounted as an uncaught bug. This
 * keeps the catch rate a function of the file state, never of machine load.
 */
export function classifyDetectorRun(
  result: {
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  },
  bugId: string,
): DetectorOutcome {
  if (result.error || result.signal !== null || result.status === null) {
    const cause = result.error?.message ?? result.signal ?? "no exit code";
    throw new Error(
      `detector for "${bugId}" did not complete (timeout or termination: ${cause}) — cannot score reliably`,
    );
  }
  return result.status === 0 ? "caught" : "survived";
}
