---
status: shipped
---

# Plan 25: the language-support matrix — presented properly, and mechanically unable to lie

Run this LAST, after whichever of plans 19–24 actually shipped. Its job is to make language
support a first-class, visible, honest claim everywhere a user meets codument: the README, the
CLI, and the docs — presented as a proper matrix with per-language grain badges, not a paragraph
someone has to find. The website carries the same matrix; its work is tracked in the website
repo's own plan so each repo's plans stay executable in place.

## Why

- Support claims are marketing surface AND trust surface. An out-of-date matrix (a language
  shipped but unlisted, or listed but unshipped) is exactly the class of doc drift codument
  exists to catch — so the matrix must be enforced by the repo's own machinery, not by memory.
- This was explicitly requested so it cannot be forgotten once the adapter work lands: the plan
  file IS the reminder, and the parity test makes forgetting impossible.

## Scope

- `README.md` (the "Language support" paragraph from plan 17's era becomes a matrix table near
  the top, with the paragraph's honest bounds kept beneath it)
- `src/lib/fingerprint.ts` (a tiny exported adapter manifest the surfaces read: language id,
  display name, extensions, grain)
- `src/commands/hooks.ts` is untouched; `src/cli.ts` gains nothing — but `codument doctor` gains
  one info line ("gate languages: …") derived from the same manifest
- `tests/language-matrix.test.ts` (new: the parity test)
- `docs/features/change-control-gate.md`, `CHANGELOG.md`, `docs/.registry.json`

## Non-goals

- No website file changes from this repo (different repository; its plan mirrors this one and
  consumes the same shipped facts).
- No roadmap promises in the matrix: it lists what IS. Unshipped languages appear only in a
  clearly separated "planned" line naming the plan numbers, never as rows.
- No new badges/shields.io network calls (README stays static text/emoji-free tables; the
  zero-third-party stance holds).

## Decisions (settled)

- **One source of truth:** the adapter registry exports a `LANGUAGE_MATRIX` manifest —
  `{ language, extensions, grain: "per-symbol" | "file" | "blocks", since }` — derived from the
  registered adapters themselves, not hand-listed. The README table, the doctor info line, and
  the website's copy of the matrix all render from/against it.
- **The parity test is the point:** `language-matrix.test.ts` parses the README's matrix table
  and asserts row-for-row equality with `LANGUAGE_MATRIX` — a shipped-but-unlisted or
  listed-but-unshipped language is a RED TEST, so the matrix cannot drift. (The website repo's
  checks mirror this against the published package.)
- **Presentation:** a compact table under "What it is" — Language | Files | Grain | Since — with
  per-symbol rows first; beneath it, one line for file-grain JS, one for surfaced-not-judged
  registration, and one "planned:" line naming open plan numbers. The plain-prose honest-bounds
  paragraph stays (tables state, prose explains).
- **CHANGELOG discipline:** each adapter plan already logs its own entry; this plan logs only the
  matrix mechanism, and its README table is regenerated (and parity-tested) as part of shipping
  any FUTURE adapter — added to the adapter plans' Definition of Done by reference.

## Delivery Plan

- [x] Step 1: `LANGUAGE_MATRIX` manifest derived from registered adapters + doctor info line;
      unit tests.
- [x] Step 2: README matrix table rendered from the manifest (hand-written, parity-enforced) +
      the parity test proving it red on a seeded mismatch, green as shipped.
- [x] Step 3: docs — gate-doc pointer, CHANGELOG; confirm the website-repo plan consumed the
      final matrix (checklist item, no file changes here).

## Outcome

"What languages does codument support?" has one answer, rendered identically in the README, the
CLI, and the website, and a test fails the moment any of them would drift from what actually
shipped.

## Acceptance criteria

Parity test red on seeded mismatch, green at ship; doctor line matches the manifest; README table
lists exactly the shipped adapters; suite green; strict green per commit.
