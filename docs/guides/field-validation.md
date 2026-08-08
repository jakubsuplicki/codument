---
title: Interrogating a field run
status: current
type: guide
last_reviewed: 2026-08-08
---

# Interrogating a field run

How to get usable feedback out of an agent that has just built something real under the gate.

The first Expo-app report produced six plans (36–41), but not from its own conclusions — from its
**artifacts**. Its headline complaint about exit codes dissolved on inspection: `--strict` had
returned 1 correctly the whole time, and the reporter's `$?`-after-a-pipe reading was the bug. Two
of the three false greens it never mentioned were found by asking it to run experiments it had not
thought to run. So the whole method reduces to one rule.

**Ask for evidence, never for a verdict.** An agent asked "was the gate annoying?" will produce a
fluent, agreeable, unfalsifiable paragraph. An agent asked "paste `codument ack --list`" produces
342 acks with 52 auto-invalidated, which is a plan. Every question below is shaped to return
something you can check.

## 1 · Pull the artifacts first, before any discussion

Ask for these verbatim, with no commentary attached. Read them yourself before asking anything
else — half the real findings are visible here and the agent will not have noticed them.

1. `docs/.registry.json` in full. You are looking for: how many features claim the same file; how
   many entries carry `owned_symbols` at all; whether `related_sources` is used by anything; and
   any `status` that has been sitting at `needs-review` since scaffolding.
2. `codument ack --list` in full. The ratio of auto-invalidated to total is the honest cost of the
   ack loop in that repo.
3. The last three `codument review --strict` outputs in full, including the ones that passed.
4. `codument doctor --strict`, whole output.
5. `git log --oneline` for the session, and `.codument-meta.json`.

## 2 · Get the counts

Numbers survive an agent's self-narrative; adjectives do not.

- How many times did you run each codument command? (Transcript grep, not memory.)
- How many acknowledgments did you record, and how many cleared the finding you recorded them for?
- How many times did the gate go red, and what was the median number of attempts to clear it?
- How many docs did one source edit wake, at worst? Which file?
- How many source files did you write that the gate never had an opinion about?

## 3 · The narrative questions

Each of these must come back with a **quoted command and its exact output**. An answer with no
transcript in it is an opinion; treat it as a hypothesis to probe in section 4, not a finding.

1. Name the single worst moment of working under the gate. Quote the exact output you were looking
   at and the exact command you ran next.
2. Name every time you wrote prose into a doc mainly to make the gate green. Quote the prose.
   *(This is the highest-yield question in the set. It finds the mirror edits the whole ack
   protocol exists to prevent, and an agent will volunteer it honestly because it does not know it
   is confessing.)*
3. Name every command codument printed that you pasted and that then failed or refused. Quote both.
4. Was there guidance you read past more than once before acting on it? Quote it, and say where on
   the screen it was. *(Placement, not wording, was the defect behind plan 36 — the resolution had
   been printing 25 times below the blocking line.)*
5. What did you have to work out for yourself that you think the tool should have told you?
6. Which of your source files went ungoverned, and was that a decision or an accident of file
   extension?
7. What did you invoke the CLI with, and did every command's arguments arrive intact?

## 4 · The probes

The most valuable findings come from states the agent never happened to enter. Ask it to construct
each of these deliberately, and to report **expected vs actual** — not whether it "worked".

Each probe below has found a real defect at least once.

1. **Rewrite a registered file no adapter can judge.** Take a registered `.json`/`.yaml`/locale
   file and change what it *means*, not just its formatting. Run `codument review --strict`.
   *(Found the ADR-017 false green: exit 0 over a rewritten contract.)*
2. **Delete one.** Same file kind, `git rm` it, leave the registry alone. *(Found the deletion
   blind spot: no line at all.)*
3. **`git mv` a registered source**, then register the new path and resolve the doc. Check whether
   anything ever names the vanished origin. *(Found the dangling-pointer ghost: fully green run,
   permanent lie in `primary_sources`.)*
4. **Edit one line of a file two or more features claim as primary**, with no `owned_symbols`
   entry. Then try to clear the gate using only what it printed. *(Found the churn cluster.)*
5. **Add a symbol to that same shared file**, rather than changing one, and try the printed ack.
   *(Different `changeKind`, different clearing rules — a surface that treats them alike is wrong
   in one direction or the other.)*
6. **Rename a file to differ only in case**, and rename one whose extension changes.
7. **Run every command through the launcher you actually use**, with a multi-word quoted argument:
   `--reason "one two three"`. Compare `npx`, the package's local bin, and whatever the project
   uses. *(Found the bunx argument split.)*
8. **Pipe a red run**: `codument review --strict | tail -1`, and separately check `$?`. Then do the
   same on an ungated `codument review`. *(Both halves of the verdict-line contract.)*

## 5 · What not to ask

- Anything answerable with "yes, that was frustrating." Leading questions get agreement, and
  agreement is not data.
- "What would you change about codument?" — invites feature design from something with one
  project's worth of context. Ask what it *did*; decide the change yourself.
- Anything that names the mechanism you suspect. Ask for the artifact and check the mechanism
  yourself, or you will get your own hypothesis reflected back.
- Do not ask a second round of questions before reading the first round's artifacts. The second
  interrogation is where the sharp questions come from, and they are always about something in the
  paste that the agent did not comment on.

## 6 · Turning answers into plans

- **Verify every claim against source before planning against it.** One report in three has a
  mechanism wrong even when the experience it describes is real; plan against the experience, not
  the diagnosis. The Expo report's exit-code claim was false and its ack-churn claim was
  understated.
- **Separate the wake from the routing.** "The gate fired too much" is usually the gate working and
  the resolution being unreachable. Ask what the reader was supposed to do next, and whether it was
  printed where they were looking.
- **A false green outranks every friction complaint**, however loudly the friction is reported. It
  is the only class of finding that costs trust in every other verdict the tool gives.
- **Anything the report is silent about is worth a probe.** Every false green in 0.15.0 was found
  in silence, not in the complaints.
