---
status: shipped
---

# Plan 28: nested-repo workspaces — aggregate git truth across member repos

The field monorepo (`enrol/`: no root repo; `applications-service/` and `apply-exp/` are each git
repos) is a topology codument currently cannot see, and in one configuration it produces the worst
failure codument can have: **a false green from the gate**. All verified live against 0.9.0:

1. Every git helper answers from exactly one work tree. Under the field layout, `isGitRepo(root)`
   is false, so `listIgnoredPaths`/`listTrackedFiles`/`getWorkingTreeChanges` degrade and `review`
   fails closed — the layout is unusable, not just noisy. Plan 26 makes the degradation loud; it
   does not make the layout work.
2. Making the root a repo does NOT fix it: nested work trees are opaque to the outer repo
   (`git ls-files` reports a gitlink, `ls-files --ignored` reports nothing inside members —
   reproduced in a control repo).
3. The gate false-green (worst finding, not in the original report): with a root repo containing a
   nested member, changing an owned `primary_source` inside the member (`def hello` → new public
   function) yields `review`: "0 source, 1 other" and `review --strict` **exit 0**, while the
   identical change in a flat control repo yields per-symbol drift findings and exit 1. Root git
   reports the change as `M child` — a gitlink path with no extension — so `isSourceFile` rejects
   it into `otherChanged` and the stale-doc verdict never fires. The same mechanism blinds the gate
   under git *submodules* (the super-repo is a valid toplevel, every guard passes). This violates
   ADR-003's core promise: the gate ran and answered over a tree it could not see.

## Why

- Monorepos of nested repos, and submodule super-repos, are real layouts (the field report is one);
  today codument either refuses them or — strictly worse — gates them wrongly. ADR-013 makes CI/
  hooks the enforcement arms; an enforcement arm that answers green over invisible changes is a
  contract-launderer at the product's core.
- The root fix is one seam: a workspace resolver in `git.ts` that every existing helper routes
  through, aggregating per-member git truth with path prefixing. Per-caller patches (teach review
  about gitlinks, teach analyze about nested ignores, …) would leave sibling callers broken —
  exactly what the contract forbids.

## Scope

- `src/lib/git.ts` (workspace discovery + member aggregation + `repoFor` path routing;
  `assertRootIsRepoToplevel` workspace rule; gitlink entries replaced by member expansion)
- `src/lib/fingerprint.ts` + `src/lib/two-ref.ts` (worktree-mode blob reads routed to the owning
  member; ref-ranged guard)
- `src/commands/review.ts` (workspace-aware entry; ref-ranged refusal message; per-member base line)
- `src/commands/ack.ts` (added in step 4 after review: `--base` ack refused, the one ref-ranged
  entry point the drafted sweep missed — it resolved an outer-repo sha no member knows, so a symbol
  that genuinely moved read as "nothing to ack" and exited 1 with a misleading message)
- `src/commands/doctor.ts`, `src/commands/scan.ts` (workspace note: "N member repositories —
  ignore rules aggregated"), `src/commands/watch.ts` (rides the seam), `src/commands/audit.ts` +
  `src/commands/report.ts` (workspace refusal/notes), `src/lib/git-hooks.ts` (workspace refusal)
- `tests/git.test.ts` (workspace fixtures + aggregation goldens), `tests/gate-wiring.test.ts`,
  `tests/review.test.ts` (the false-green repro as THE regression), `tests/doctor.test.ts`,
  `tests/scan.test.ts`
- `docs/features/change-control-gate.md`, `docs/features/commands.md`, `docs/concepts/lib.md`,
  `docs/architecture/decisions/016-nested-repo-workspace-aggregation.md` (new), `README.md`
  (monorepo section), `CHANGELOG.md`

No new source files (the workspace layer lives in `git.ts`, already owned by lib/change-control-gate
in the registry); no `map materialize` needed. Run after Plan 26 (rides its typed
`{ok:false,reason}` seam) — Plan 27 is independent of this one.

## Non-goals

- **No ref-ranged review across a workspace** (`--base`, `--ci`, `audit <range>`): a single ref
  cannot name a state of multiple repositories, and inventing a convention (per-member ref maps,
  gitlink-sha diffing) would put a guess on the verdict path. Fail closed with `GateError`
  ("wrong-topology": a ref names one repository; run ref-ranged review inside the member"). The
  accepted consequence — CI enforcement for nested-member monorepos is doctor + the worktree gate,
  not the two-ref PR gate — is recorded in ADR-016.
- **No pre-commit hook install into member repos** in this plan: a member-repo hook would run the
  workspace gate and block member A's commit on member B's unrelated staleness — member-scoped
  review is its own design. `hooks install` at a workspace root refuses with that reason; follow-up
  plan when demanded.
- No `.gitignore` file parsing (the report's suggestion 3): shelling to each member's own `git` is
  the only way ignore semantics stay exactly git's (`core.excludesFile`, `.git/info/exclude`,
  precedence); a reimplementation would drift. Rejected.
- No `git worktree` special-casing — tested clean (a linked worktree IS a normal work tree); the
  report's claim there was unsupported.
- Uninitialized submodules (gitlink with no work tree) contribute nothing and print a note; their
  registry-owned sources fall out as `missing-source` lint naturally — never fabricated.

## Decisions (settled)

- **Discovery**: members = every directory under root containing `.git` (dir or file — submodules
  and linked worktrees use a `.git` file), found by a full-depth walk pruned by the resolved
  exclusion dirs, deterministic sorted order, computed once per invocation. The root repo, when it
  is one, is a member. Workspace mode = any member exists besides a root-only repo. A classic
  single-repo root takes today's exact code paths — byte-identical goldens are the safety rail.
- **Aggregation**: tracked/ignored/changed/deleted = union over members of the member-repo result,
  prefixed with the member's workspace-relative path. The outer repo's gitlink status entries for
  member dirs are dropped in favor of the member's own expansion (this alone kills the `M child` →
  "other" false green). One member failing git is `{ok:false}` naming the member — never a partial
  result presented as whole (Plan 26's typed seam).
- **Path routing**: `repoFor(relPath)` maps a workspace path to `(memberRoot, memberRelPath)`;
  worktree-mode blob reads (`readBlobAtRef(root, "HEAD", path)`, fingerprint.ts:263/366/446) route
  to the owning member, where `HEAD` means *that member's* HEAD. Registry paths, docs, acks, and
  anchors stay workspace-root-relative everywhere — only git access routes.
- **Verdict purity** (ADR-003 amended by ADR-016, not contradicted): in workspace worktree mode the
  verdict is a pure function of (each member's HEAD, each member's worktree, codument version,
  algoStamp); `review` prints the per-member base shas so any run is reproducible.
- **Root assertion**: a root that is itself a repo must still be its toplevel (unchanged). A
  non-repo root with ≥1 member is a valid workspace root. A non-repo root with no members keeps
  today's per-command informational handling. (A subdirectory-of-a-repo root cannot masquerade as a
  workspace: `isGitRepo` is true there and the existing wrong-root refusal fires first.)
- **Warm** (Plan 26's contract, extended): the warm set derives from aggregated git view ∪ registry
  — so a member's `.py` warms python everywhere automatically.
- `doctor`/`scan` print the workspace shape once (`workspace: 2 member repositories (applications-
  service, apply-exp) — git scope aggregated`); `--json` extends the Plan 26 additive `scope` field
  with `members: string[]`.
- `watch` rides the aggregated seam with no watch-specific logic; `report` works at workspace roots
  (doctor-derived) with the same note; `audit` refuses in workspace mode (history is per-repo).

## Delivery Plan

- [x] Step 1: discovery + routing — member discovery (walk, prune, sort, cache), `repoFor`,
      workspace-mode predicate; unit tests over fixtures: field shape (non-repo root + 2 members),
      root repo + embedded member, submodule super-repo, single flat repo (must take the legacy
      path), uninitialized gitlink.
- [x] Step 2: aggregated scope — tracked/ignored/changed/deleted union with prefixing + gitlink
      drop, wired through the Plan 26 typed results; goldens: member `.gitignore` honored at
      workspace root, member-failure → `{ok:false}` naming the member; doctor/scan workspace note +
      `--json` members field; the 378-artifact field scenario as e2e (scan proposes none of it).
- [x] Step 3: the gate — worktree-mode blob reads routed via `repoFor` (HEAD = owning member's
      HEAD); per-member base lines printed; THE regression: the false-green repro (owned member
      `.py` contract change) now yields per-symbol drift findings and `--strict` exit 1, identical
      to its flat-repo control; submodule variant of the same test.
- [x] Step 4: honest refusals — ref-ranged (`--base`/`--ci`) GateError("wrong-topology") in
      workspace mode with the run-inside-the-member pointer (SARIF/`--json` discriminants
      included), `audit` refusal, `hooks install` refusal; tests pin exit codes and shapes.
- [x] Step 5: docs — ADR-016 (aggregate-and-prefix; worktree-gate-only; ref-ranged refused;
      enforcement consequence), change-control-gate.md invariants (+ test pointers), commands.md,
      lib.md, README monorepo section, CHANGELOG.

## Outcome

The field monorepo becomes a first-class layout: scan and doctor see exactly what each member's git
sees, the worktree gate resolves per-symbol drift across members with per-member bases printed, and
the two topologies that silently blinded the gate (nested members, submodules) are the subject of
pinned regression tests. What codument cannot honestly answer in a workspace — ref-ranged review,
history audit, per-member hooks — it now refuses by name instead of guessing.

## Acceptance criteria

The false-green repro is a red-then-green pinned test (workspace verdict ≡ flat-repo control);
single-repo goldens byte-identical; the field TAFE shape end-to-end (scan proposes no gitignored
artifacts, doctor honest, review resolves member drift); every refusal has a pinned exit code and
machine shape; full suite green; `codument review --strict` green at every commit of this plan.
