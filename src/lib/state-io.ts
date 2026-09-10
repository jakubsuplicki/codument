import { existsSync, readFileSync, openSync, closeSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

// A present-but-unparseable state or config file is a loud error, never a silent
// default. Writers that read-modify-write a shared file (`.claude/settings.json`,
// `.codument-meta.json`, a target `package.json`) must refuse rather than start
// from empty and overwrite content they could not first read — the same fail-loud
// stance the registry takes. Callers surface this red and fail closed.
export class StateFileError extends Error {
  constructor(
    readonly path: string,
    readonly kind: string,
    cause?: unknown,
  ) {
    super(
      `${kind} unreadable: ${path} exists but does not parse` +
        (cause instanceof Error ? ` (${cause.message})` : ""),
    );
    this.name = "StateFileError";
  }
}

// The sibling of StateFileError for a file that parses but says something
// invalid. Separated because the two failures need different user actions: an
// unparseable file is corrupt, while an invalid value is a typo the user can see
// and fix — so this message names the offending value rather than the file alone.
// Silently ignoring an invalid value is the failure mode this class exists to
// prevent: a typo'd exclusion that no-ops looks exactly like a correct one.
export class ConfigValueError extends Error {
  constructor(
    readonly path: string,
    readonly field: string,
    readonly problem: string,
  ) {
    super(`${path}: invalid ${field} — ${problem}`);
    this.name = "ConfigValueError";
  }
}

// Missing file → undefined (a valid "not present yet" state). Present-but-
// unparseable → StateFileError. `kind` names the file for the user's diagnostic
// (e.g. "settings", "project metadata").
export function readJsonFileOrThrow<T>(path: string, kind: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    throw new StateFileError(path, kind, err);
  }
}

/** Do not repair an unreadable or oversized control file by replacing it. */
export function readBoundedState(path: string, maxBytes = 2 * 1024 * 1024): string | null {
  try {
    if (statSync(path).size > maxBytes) throw new Error(`exceeds ${maxBytes} bytes`);
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw) > maxBytes) throw new Error(`exceeds ${maxBytes} bytes`);
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StateFileError(path, "control state", error);
  }
}

/** An interrupted writer leaves a visible lock; never guess that it is safe to steal. */
export function withStateLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (error) { throw new StateFileError(lock, "exclusive writer lock; check the other writer before retrying", error); }
  try { return operation(); }
  finally { closeSync(fd); unlinkSync(lock); }
}
