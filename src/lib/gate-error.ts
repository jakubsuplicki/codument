// The gate's failure type, kept in a leaf module of its own so that the two
// layers which both raise it — the git seam and the two-ref plumbing — can
// depend on it without depending on each other. It used to live in `two-ref.ts`,
// which made the git seam import two-ref; once the seam grew workspace
// resolution that two-ref needs in turn, that would have been a cycle.

export type GateErrorKind =
  | "bad-ref"
  | "unreachable-base"
  | "ambiguous-base"
  | "git-failed"
  | "wrong-root"
  | "wrong-topology";

// A gate-level failure that must fail CLOSED (red, blocking) — the gate could not
// run, which is distinct from "ran and passed." Branch protection requires the
// latter, so this is never swallowed into a green verdict.
export class GateError extends Error {
  constructor(
    message: string,
    readonly kind: GateErrorKind,
  ) {
    super(message);
    this.name = "GateError";
  }
}
