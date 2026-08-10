---
title: Cutting a release
status: current
type: guide
last_reviewed: 2026-08-11
---

# Cutting a release

The whole sequence, in order. Publishing to npm is only the last step of it — a version that reached
npm but not the tag, the GitHub release, or `.codument-meta.json` is a release that lies about
itself somewhere, and each of those has been missed at least once.

Nothing here is automated. Run it top to bottom.

## Before you start

- Every plan whose work is in this release reads `status: shipped`, and its steps are all checked.
- `git status` is clean and `main` is pushed.

## The sequence

1. **Changelog.** Move everything under `## [Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD`
   section and leave `## [Unreleased]` empty above it. Write the release's opening narrative — what
   this release is *about*, not a restatement of the entries under it. Name the plans it carries.

2. **Version, in three files.** `package.json`, and **both** places in `package-lock.json` (the
   top-level `"version"` and the one inside the `""` package entry — bumping only the first leaves
   the lockfile disagreeing with the manifest).

3. **Rebuild, then re-sync.** `npm run build`, then `codument update`. The second one writes the new
   version into `.codument-meta.json`, which is what tells an installed project its scaffolds are
   from an older package. Historically this was a separate follow-up commit; folding it in is fine,
   forgetting it is not.

4. **Verify everything, and mean it.** `npm test`, `npm run typecheck`, `npm run lint`,
   `codument review --strict`, `codument doctor --strict`. Green before the release commit exists —
   `prepublishOnly` re-runs the build and the suite at publish time, but that is a backstop, not the
   check.

   Two of those have a **recorded baseline**, and the bar is *no movement against it*, not zero:
   as of 0.17.0 the suite carries **27** known Windows path-separator failures across 14 suites,
   and `doctor --strict` exits 1 on **2** long-standing `bloated-doc` findings (`SKILL.md`
   preambles). Say what the baseline is when you check it, and treat any change to either number
   as a blocker. This step used to demand a green `doctor --strict`, which no release has ever
   met — a bar nobody can clear is not a bar, it is a step people learn to skip.

   **Re-measure both numbers and write what you measured back here.** They were 31 and 3 when
   this guide was written and neither had been touched since; a baseline nobody re-measures is
   exactly the recorded-state rot the tool exists to catch, sitting in the runbook that tells
   you to check it. The direction matters too — a stale HIGH baseline hides a real regression
   underneath it.

5. **Commit** as `chore(release): X.Y.Z`, with a body that says what the release is for.

6. **Tag it.** `git tag -a vX.Y.Z -m "X.Y.Z"` on that commit.

7. **Push the tag.** `git push origin vX.Y.Z`. Pushing `main` does *not* push tags — this is the step
   that leaves GitHub showing the previous version as latest while npm has moved on.

8. **Cut the GitHub release.** `gh release create vX.Y.Z --title "vX.Y.Z — <what changed, in a
   phrase>" --notes-file <the changelog section>`. Every prior version has one; a tag without a
   release is invisible on the releases page.

9. **Publish.** `npm publish`.

## Afterwards

- `gh release list` shows the new version as `Latest`.
- The README's test-count badge still reads true; bump it when the suite has grown past it.
