---
status: draft
---

# Plan 02: State-file integrity — stop destroying user state

Adopt one rule everywhere: **a state file that exists but does not parse is a loud error, never an
empty default** — and no codument write may replace content it did not read first.

## Why

Verified findings this plan fixes (all confirmed against source; several reproduced live):

1. **Corrupt registry reads as empty; the next write destroys it.** `readRegistry`/`readRegistrySync`
   swallow parse errors and return `{features:{}}` (`src/lib/registry.ts:58-62,69-73`); doctor/review
   then silently read greener (everything unmapped, zero staleness). `updateRegistryEntry`
   (`registry.ts:85-95`) starts from that empty object and writes back only the new entry.
   Reproduced: registry with one real feature + one trailing comma, then `codument map materialize`
   → exit 0, "✓ created", original feature gone.
2. **`init --force` wipes `.claude/settings.json`** down to just the codument hook — permissions,
   other hooks, env all destroyed (`src/commands/init.ts:202-217`: existing settings are read only
   when `existsSync(settingsPath) && !force`). It also resets a populated `docs/.registry.json`
   (`init.ts:85-90`). Reproduced live.
3. **`codument update` on an unparseable settings.json rewrites it to just the hook**
   (`src/commands/update.ts:353-369`: `catch { current = {} }` then writes
   `ensureClaudeDocsHook({})`). Trailing comma / JSONC comment / conflict marker → routine update
   silently destroys the user's agent configuration.
4. **Plain `init` re-run clobbers `.codument-meta.json`** (`init.ts:110-123`, no read-merge),
   dropping `fileHashes`/`lastScan`/charter that `adopt` preserves (`src/commands/adopt.ts:63-70`) —
   which degrades `update`'s three-way merge to overwrite-with-backup for customized managed files.
5. **`scan` can overwrite a human-authored doc and replace a registry entry.** When an entry exists
   but its doc file is missing, `src/commands/scan.ts:53-79` writes a scaffold and replaces the whole
   entry with a fresh literal, losing `depends_on`/`risk`/`related_sources`/`status`; a dir-derived
   name collision can overwrite an existing doc's content via the unconditional write at `scan.ts:68`.
6. **Registry writes are non-atomic and unlocked** while `watch` polls every 2s and the Claude hook
   reads concurrently. A torn read parses as empty (finding 1) and the next write finalizes the
   loss. A correct `atomicWriteFileSync` (tmp + fsync + rename) already exists in
   `src/lib/events.ts:74-90` but protects only events.jsonl. Same plain-write pattern:
   `review-artifact.ts:270`, `acknowledgment.ts:111`, `doctor.ts:53`.
7. **`detect.ts:27` is the one unguarded state-file parse**: a malformed target-project
   `package.json` crashes `init`/`scan` with a raw SyntaxError stack on the very first onboarding
   command.

## Scope

- `src/lib/registry.ts`
- `src/lib/events.ts`
- `src/lib/state-io.ts` (new, optional — see feature map)
- `src/commands/init.ts`
- `src/commands/update.ts`
- `src/commands/scan.ts`
- `src/commands/adopt.ts`
- `src/lib/detect.ts`
- `src/lib/acknowledgment.ts`
- `src/lib/review-artifact.ts`
- `src/commands/doctor.ts`
- `src/lib/claude-settings.ts`
- `tests/registry.test.ts`
- `tests/init.test.ts`
- `tests/update.test.ts`
- `tests/scan.test.ts`

```feature-map
src/lib/state-io.ts | lib | concept | shared atomic write + fail-loud parse helpers for state files
```

(Only if Step 2 extracts a new module; re-exporting from `events.ts` is equally acceptable — then no
new file and no map row. If created, run `codument map materialize src/lib/state-io.ts`.)

## Non-goals

- No file locking / multi-process coordination beyond atomic single-file writes.
- No registry schema change; ADR 001's v2 model is untouched.
- No auto-repair of corrupt JSON — fail loud and tell the human, never guess.

## Decisions (settled; adjust only at approval)

- **`--force` scope**: `--force` means "overwrite codument-managed *files*". It must never discard
  non-codument keys in `.claude/settings.json` (always read-merge, upsert only the hook), and it
  must never reset a non-empty `docs/.registry.json` (registry contains human-authored fields;
  drop the reset behavior — re-scaffolding a registry requires deleting the file deliberately).
- **Unparseable-but-present** config on any write path: refuse the write, exit non-zero, name the
  file and the parse error. On read-only paths (doctor/review/watch): surface a red diagnostic and
  fail the gate rather than reading as empty (aligns with Plan 03's fail-closed stance).

## Delivery Plan

- [ ] Step 1: Registry fail-loud. In `registry.ts`, distinguish file-missing (→ empty registry, OK)
      from file-unparseable (→ throw a typed error carrying path + cause). Update every caller:
      review/watch/doctor/map/scan/ack render a red "registry unreadable — fix or restore
      docs/.registry.json" and exit 1; `updateRegistryEntry` refuses to write when an existing
      registry does not parse. Tests: trailing-comma registry → materialize exits 1 and the file is
      byte-identical afterwards; doctor/review exit 1 with the diagnostic.
- [ ] Step 2: Atomic state writes. Export the existing `atomicWriteFileSync` (from `events.ts` or a
      new `state-io.ts`) and route registry, `.codument-meta.json`, acks, review artifacts, and the
      doctor artifact through it. Test: the tmp-then-rename behavior (no partial file visible under
      a simulated crash between write and rename is hard to test directly; assert the helper is used
      and that a write never truncates-then-writes in place).
- [ ] Step 3: `init` preservation. Always read-merge existing `.claude/settings.json` (upsert only
      the codument hook, `--force` included); read-merge `.codument-meta.json` preserving
      `fileHashes`/`lastScan`/charter (mirror `adopt.ts:63-70`, and make adopt preserve charter
      too); remove the registry reset from the `--force` path. Tests: settings with
      permissions/env/other-hooks survive `init --force`; meta hashes survive plain re-init;
      populated registry survives `init --force`.
- [ ] Step 4: `update` refuses on corrupt settings. Unparseable settings.json → exit 1 naming the
      file, no write, no backup-then-replace. Test with a JSONC-style file.
- [ ] Step 5: `scan` merges, never clobbers. Existing registry entry → update machine fields only
      (sources), preserve `depends_on`/`risk`/`related_sources`/`docs`/`status`; never write a
      scaffold over an existing doc file (skip + note in output). Tests: entry-with-missing-doc keeps
      its human fields; name-collision case leaves the existing doc content untouched.
- [ ] Step 6: Guard `detect.ts:27` (try/catch → framework null + one-line warning naming the file),
      matching every sibling reader. Test: malformed package.json → `init` proceeds with the warning.

## Outcome

No codument command can destroy user state it did not read: corrupt state files stop the tool loudly
instead of being silently rebuilt from empty; `init`/`update` preserve everything they don't own;
`scan` is re-runnable on a real project without loss; all state writes are atomic so a concurrent
`watch` or a crash can no longer produce the corrupt file that triggers the loss chain. What it does
NOT do: repair corrupt files, or coordinate concurrent codument *writers* beyond last-write-wins on
whole files.

## Acceptance criteria

Every reproduction in "Why" now fails safe: trailing-comma registry → exit 1 + file untouched;
`init --force` → settings keys preserved; corrupt settings + `update` → exit 1 + file untouched;
re-init preserves meta; scan preserves human-authored fields and doc content; malformed target
package.json → warning, not a stack trace.

## Verification

`npm test` green (new tests included); `npm run typecheck`; live re-run of each reproduction from
"Why" in a scratch repo.
