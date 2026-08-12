---
status: superseded-in-part
date: 2026-08-08
---

> **Superseded in part by [020](020-a-block-must-be-provable.md) (2026-08-12).** Registration is still a claim of governance, and a claimed file is still watched and reported. What no longer follows is the BLOCK: nothing here can be read, so the only artifact a gate could demand is a signature over content nobody looked at. A blind file gates when an owner declares a risk, and its deletion gates unconditionally — a removal needs no reading to be proven. Everything below still describes the wake, the grain, and the resolution vocabulary correctly; read "governed" as "governed where risk is declared".

# 017 — Registration is governance: an owned file no adapter can judge is gated at file grain

## Context

The source-extension spec bounds what the gate can **judge**: a file whose extension no adapter recognizes has no anchors, so it cannot be evaluated per symbol. [Plan 17](../../plans/17-config-grain-calibration.md) made such a file *visible* when the registry claimed it — the "Registered but ungated" notice — and deliberately stopped there: "blocking on files the gate cannot evaluate would manufacture noise; the notice plus the ledger measure first."

A 2026-08-07 field probe showed what that stance costs where the registry claims ownership. On an Expo app, twenty English locale packs were `primary_sources` of the i18n concept, whose own doc names raw-key rendering as an invariant. Rewriting one of them to a completely different contract reported "0 source, 1 other", printed a grey advisory, and exited **0** under `--strict`. Deleting one was worse: it exited 0 with no line at all, because the notice is built from the *changed* set and deletions never enter it. That file class is the application's entire user-visible string surface, edited constantly across six delivery steps, and the gate never once had an opinion about any of it. The only net that caught the deletion was a test the agent happened to write inside the change.

This is the same structural failure as the workspace false green ([016](016-nested-repo-workspace-aggregation.md)) in a different dimension: a green verdict over content the gate declined to look at. The difference from plan 17's framing is that a **registration is not the gate's guess — it is an explicit human claim** that this file is load-bearing to a named doc. Staying silent about a claimed file is not conservatism; it is answering a question nobody asked ("can I judge this precisely?") in place of the one that matters ("did something someone declared load-bearing move without its doc?").

## Decision

**A registration is a claim of governance.** A changed or deleted file that a feature or concept **owns** (`primary_sources`), that no adapter can judge, and that the effective exclusion spec does not drop, is governed at **file grain** — the floor every other coarse governed file already stands on.

1. **The grain is the honest one, and it is not new machinery.** Any content move wakes every primary owner (feature and concept); doc attention or a file-grain acknowledgment clears it; the ack binds the file's content transition and auto-invalidates on the next edit. A deletion wakes its owners with **no ack fast-path**, per [012](012-file-grain-acknowledgment-conservative-additive-residue.md)'s stance that a removal owes doc attention. This is precisely the existing coarse fallback — the one an unadapted language or a re-export barrel already takes, never the parse-error class, which stays deliberately un-ackable — pointed at a file class that was previously exempt from it. No new verdict kind, no new resolution to learn.

2. **`related_sources` still never wakes.** Related claims *impact*, not ownership ([004](004-symbol-grained-derived-first-ownership.md)), and that rule is not weakened for unjudgeable files. A project that wants its locale packs gated names them as primary of the owning entry — one registry line, explicit and reversible.

3. **Exclusion still overrides registration, and now says so.** A declared or built-in exclusion keeps a file ungoverned even when an entry names it; that contradiction is surfaced as a lint ("un-map it, or narrow the declaration") rather than as "verify their docs by hand", matching the refusal already given when a *new* registration names an excluded path.

4. **The info-only surface survives for what is genuinely ungoverned.** Two classes keep it, and they are different things: an *impact-only* registration (related, never owning), and an *excluded* one. Both stay outside every strict input.

5. **Registration widens the gate's scope, never its judgment.** The grain stays coarse because no adapter exists; when one ships, it upgrades the grain in place and the file leaves this path — exactly how the SFC adapter retired `.vue` from the plan-17 notice.

This supersedes plan 17's info-only stance **for owned files only**. Plan 17's reasoning was right about the noise risk and remains right for the residue; what it did not weigh is that ownership is a declaration, and a declaration the gate ignores is a false green rather than a quiet one.

## Consequences

**Good:** the field false green is closed at the root, for changes and deletions alike; the files a project explicitly claims are the files it gets protection on; the resolution vocabulary is unchanged (doc update or file ack), so nothing new is learned to clear it; and a project can still opt any file out through the mechanism that already exists (`exclude`, or demoting it to `related_sources`).

**Bad / accepted:** a project that registered non-source files expecting a purely informational notice will see them gate after upgrading — an intended, named behavior change, and the reason this is an ADR rather than a patch. Grain is coarse, so a one-character edit to a governed file wakes its doc as loudly as a rewrite; the file-grain ack is the designed absorber, and its cost is the same one every coarse source already pays. The gate still cannot say *what* changed inside such a file — only that it moved while its doc did not.

**Rejected alternatives:** *content-aware judgment* (diffing JSON keys) — that is a language adapter, and it belongs on the [015](015-wasm-only-bundled-parser-determinism.md) substrate with a conformance battery, not smuggled into the change-state; *governing every unregistered non-source file* — the registry and the exclusion block are the two explicit intents, and gating on neither would manufacture exactly the noise plan 17 rightly refused; *governing `related_sources` too* — it would dissolve the impact/ownership distinction the whole ownership model rests on; *a new opt-in flag per entry* — ownership already IS the opt-in, and a second switch would let a registration mean two different things.
