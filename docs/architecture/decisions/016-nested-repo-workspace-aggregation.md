---
status: accepted
date: 2026-07-22
---

# 016 — A workspace of member repositories is one aggregated git view; ref-ranged review is refused, not guessed

## Context

A single git work tree is opaque to the one containing it. `git ls-files` in an outer repository
reports a nested repository as one gitlink — a path with no extension, no contents — and
`ls-files --ignored` reports nothing inside it. So two real layouts are invisible to a gate built
on one work tree: a monorepo whose packages are each their own repository (the field report that
prompted this), and a super-repo with git submodules.

The invisibility was not merely noisy; in one configuration it produced the worst outcome a
change-control gate can have. With a root repository containing a nested member, an owned
`primary_source` changed inside the member surfaced to the outer repo as `M child` — a gitlink with
no extension — so `isSourceFile` rejected it into the "other changed" bucket and the stale-doc
verdict never fired, while `review --strict` exited 0. The identical change in a flat control repo
flagged per-symbol drift and exited 1. The same mechanism blinds the gate under submodules (the
super-repo is a valid toplevel, every guard passes). ADR-003's promise — the gate ran and answered
over a tree it could see, and "could not run" is distinguishable from "ran and passed" — was
violated silently.

## Decision

**Aggregate, prefix, and drop the gitlink.** A `git.ts` workspace layer resolves the member
repositories under a root once (a walk pruned by the resolved exclusion dirs, deterministically
ordered, memoized because every git helper wants it). Every existing enumeration — tracked,
ignored, changed, deleted — becomes the union over members of that member's own git answer,
prefixed back to workspace-root-relative paths, with the outer repository's gitlink entry for a
member directory dropped in favor of the member's own expansion. That drop is what kills the false
green: the member reports `child/src/app.py`, not `child`, so the verdict sees a real source
change. A member whose git fails makes the whole aggregate `{ok:false}` naming the member — never a
partial result presented as whole, the same typed-unknown rule one level up.

**Route blob reads to the owning member.** `repoFor` maps a workspace path to `(member, relPath)`;
worktree-mode blob reads resolve `HEAD` inside the owning member, so an owned source is diffed
against *that member's* HEAD. Registry paths, docs, acks, and anchors stay workspace-root-relative
everywhere — only git access routes. A plain single repo resolves to one member at the root and
takes the pre-workspace code path byte-identically; that equivalence is the safety rail, pinned by
comparing a nested verdict against a flat-repo control field by field.

**A classic single repo is not a workspace.** Workspace mode is any member besides a root-only
repository. A root that is itself a repository must still be its toplevel (a subdirectory root is
refused first, loudly, and never laundered into a member). A non-repo root with at least one member
is a valid workspace root — the field layout — where before it was refused as "not a git
repository" despite every member being readable.

**Refuse what a single ref cannot name.** A workspace state is the tuple of its members' heads; a
single ref names one repository. So ref-ranged review (`--base`; the CI workflow `hooks install --ci` scaffolds runs `review --base` and inherits it), a history `audit` range,
and a pre-commit `hooks install` at a workspace root are refused by name, not answered with a
guess. Inventing a convention — a per-member ref map, diffing gitlink shas — would put a guess on
the verdict path, which is exactly what a gate must not do. The refusals carry a machine
discriminant (`kind: "wrong-topology"`) so CI can tell a refused topology from a passed gate.

## Consequences

- **Verdict purity holds, restated for a workspace (ADR-003 extended, not contradicted).** In
  workspace worktree mode the verdict is a pure function of each member's HEAD, each member's
  worktree, the codument version, and the algoStamp. `review` prints each member's base HEAD, so
  any run is reproducible from the tuple the way a single repo's is from one sha.
- **CI enforcement for a nested-member monorepo is doctor plus the worktree gate, not the two-ref
  PR gate.** This is the accepted price of refusing ref-ranged review across a workspace. A
  member-scoped PR gate is future work, taken up when demanded.
- **Uninitialized submodules contribute nothing and are named.** A gitlink with no work tree adds
  no paths — never fabricated — and its registry-owned sources fall out as `missing-source` lint
  naturally.
- **`.gitignore` semantics stay exactly git's**, because each member's own `git` is shelled to
  (`core.excludesFile`, `.git/info/exclude`, precedence all come along). Parsing `.gitignore` files
  ourselves — the field report's suggestion — was rejected: a reimplementation would drift.
- **Linked worktrees are not special-cased**, tested clean: a linked worktree is a normal work
  tree. The report's claim otherwise was unsupported.

## Alternatives rejected

- **Per-caller patches** (teach review about gitlinks, teach analyze about nested ignores): would
  leave sibling callers broken — the exact failure the root-fix rule forbids. The workspace layer
  is one seam every helper already routes through.
- **A per-member ref map for ref-ranged review**: a guess on the verdict path. Refusal is honest;
  a guess is a launderer.
- **Parsing `.gitignore` ourselves**: drifts from git's real precedence. Rejected.
