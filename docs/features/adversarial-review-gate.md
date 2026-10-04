---
title: Adversarial review gate
status: in-progress
type: feature
last_reviewed: 2026-10-04
---

# Adversarial review gate

## In plain terms

Review effort follows the evidence and risk of the selected change. An understood, local and
reversible behavior change with precise ownership and attributable tests can use recorded focused
self-review. Public contracts, declared risks, deletions, dependencies and uncertain analysis require
the stronger adversarial pass. Formatting without a contract change needs only a diff self-review.
Every required review answers the same exact boundary, invariants and acceptance evidence.
Local behavior can span existing files of one stable feature without becoming riskier merely
because of file count. Test-only work can also receive focused review when attribution stays with
that nonrisk feature; prior attribution, risk and oracle evidence remain visible.

Ordinary documentation additions with no protected contract change need only diff self-review.
This requires readable snapshot evidence and an ordinary documentation role; instructions,
executable files, registered sources, unknown inputs and declared risks retain stronger review.

On a host currently providing independent agents the adversary is a **fresh subagent** with its own context window, so it never inherits the author's reasoning — independence is a property of the host, not something we engineer. On a host currently lacking independent agents it degrades to a **same-agent adversarial pass** against the identical bundle: weaker independence, but the deterministic confirm and the diff-bound artifact still bite. The enforcement is identical on both; only the spawn differs.

A finding only **blocks** when it ships a failing test Codument can run. Findings that cannot be reduced to a test (a design concern, an untestable invariant weakening) are recorded and routed to the existing review decision point, never auto-blocked. The artifact is bound to the diff fingerprint, so editing after review auto-reopens the gate.

## Design approach

The gate splits the same way the change-control gate does: a **deterministic enforcer** that is host-neutral and LLM-free, and an **agent adversary** layered on top. Confusing the two is the failure mode.

**The enforcer is host-neutral CLI and never judges prose.** It assembles the bundle (the contract to attack), runs the confirm (executes the findings' named failing tests), records a fingerprint-bound artifact, and decides the gate. None of this needs a model, and it runs byte-identically for Claude and Codex. It reuses the change-control gate's existing spine: the change-state analyzer, the anchor/ownership/blast facts, and the acknowledgment protocol's fingerprint-binding and auto-invalidation.

For a focused review, the oracle and attestation carry the selected boundary itself. Bundle ownership,
plan, and documentation are read from that snapshot; the bundle discloses its compact projection
identity without folding unrelated worktree diagnostics into its stamp;
recording derives a compact binding from the current invocation rather than trusting review input.
Coverage then requires both the re-derived content fingerprint and an exact base, head, path, and
boundary-fingerprint match. A review from another staged set can help scope a later delta read, but it
can never clear that later gate.

The bundle supplies the documented invariants, test references, plan, and ownership facts that the reviewer attacks. It introduces no separate source of truth.

Finding-test resolution, recorded content and runner configuration use the review's selected
snapshot. Dirty working inputs are isolated for staged reproduction, without changing the user's
files. Missing environment inputs remain named limitations rather than invented test results.

Portable evidence carries every covering attestation for an explicitly reviewed complete repository
range. Reviewers can inspect the full branch through its staged endpoint before the final commit;
identical committed bytes retain that coverage in a fresh checkout. Local step receipts remain local
to their reviewed slice. The transfer contains opaque contract and finding references, repository
test references, declared attribution and dispositions; private review prose remains local.

The recipient checks the base, content, policy, approval, contracts and named test snapshots, then
reruns those tests under the existing finding policy. Attribution is self-reported, not authenticated.

**Verify, don't trust — this breaks the who-reviews-the-reviewer regress.** The adversary only produces candidate findings. A finding counts as blocking only once a deterministic step confirms it: run the cited failing test, see it red; the fix flips it green. We never trust the adversary's judgment, only the reproduction. This mirrors the change-control gate's rule that it verifies an ack's *form*, never its semantic truth. It also bounds the dominant failure mode — adversary false-positives turning into alarm fatigue — because an unconfirmed finding cannot block.

**Independence by context, degraded gracefully.** A second agent that still receives the author's transcript re-anchors to the same mental model and rubber-stamps; completion bias is why self-review fails. So the adversary gets the diff plus the bundle, never the author's chain of thought. Where the host has subagents, a fresh Task delivers that for free. Where it does not, the same-agent pass is the honest floor (option A): the independence is weaker, but the artifact and the deterministic confirm are unchanged, so it is not theater.

**Proportionality is mandatory, not optional.** Two extra agent passes on every one-line edit is how a good gate gets disabled. Bundle depth is gated on blast radius, which Codument already computes: a trivial single-symbol edit touching no documented invariant skips the heavy pass; a risk-tagged, invariant-touching, or multi-file diff gets the full adversary.

## Invariants & boundaries

- Precise contract-neutral behavior within one stable feature can receive focused review across
  existing files. Stable attributable test-only changes qualify too; unknown or changed attribution,
  prior or selected risk, public changes, deletions and renames keep the stronger floor. *(tests:
  `review-gate.test.ts`, `review-boundary.test.ts`)*

- A harmless documentation addition passes the managed hook without a required review artifact.
  Positive snapshot evidence distinguishes prose from protected contracts, instructions, executable
  files and registered sources. Missing evidence cannot grant the exception, and a covering
  reproduced failure still blocks. *(tests: `hooks-command.test.ts`, `review-bundle.test.ts`, `review-gate.test.ts`)*
- Changed structural review policy invalidates older local pass receipts even when package version
  and staged content match. Ordinary and portable artifact formats remain readable. *(tests:
  `verify.test.ts`, `review-artifact.test.ts`)*

- Review context distinguishes outcome permission from advisory source guidance. The selected
  approval model is bound into the review oracle; routing discoveries retain affected ownership
  and constraints without a false scope finding. *(tests: `work.test.ts`, `review-bundle.test.ts`)*

- Named-test execution treats a linked project root and its canonical path as the same checkout,
  while preserving containment checks against escaping test references. *(test: `review-confirm.test.ts`)*

- Review probes runner availability only when a covering finding names a test to reproduce. Missing,
  clean and judgment-only reviews do not require a local default runner. A known unavailable runner
  is named when explaining missing reproduction evidence; timeouts retain their own remedy.
  *(tests: `review.test.ts`, `review-confirm.test.ts`)*

- Portable coverage excludes only the schema-valid reserved review manifest from its own digest.
  Missing, malformed, stale, partial and wrong-base evidence cannot clear the gate. Source, policy,
  registry, documentation and test changes remain bound. *(test: `review-transfer.test.ts`)*
- Runtime runner and timeout overrides belong to review policy, and selected Git file modes belong
  to the reviewed content. Changing either invalidates portable coverage even if source text stays
  identical. *(test: `review-transfer.test.ts`)*
- Every covering review travels together. Claimed resolution and a clean sibling review cannot
  override an observed failing test; advisory and unrunnable findings remain disclosed.
  *(tests: `review-transfer.test.ts`, `review-confirm.test.ts`)*
- Review includes before/after documented contracts and registered workflow instructions, preserving
  removed invariants and their tests even when ownership is removed. Missing inputs are named and
  bound into evidence. *(tests: `review-bundle.test.ts`, `review-boundary.test.ts`)*
- Durable documentation-only changes, invariant changes, and material registered instruction changes
  require review independently of source counts. Formatting, metadata, progress and path-only Key
  files maintenance remain housekeeping. *(tests: `review-bundle.test.ts`, `review-gate.test.ts`)*

- Committed-range review uses the selected range's paths; historical owners and member-specific
  base snapshots retain prior contracts. Excluded additions and deletions cannot suppress a
  documentation-only review requirement. *(tests: `review-boundary.test.ts`, `review-bundle.test.ts`)*

- Review evidence binds the selected plan identity and approved contract alongside the documented feature contracts. Changing selection cannot reuse a covering review through either receipt reuse or ordinary verification. *(test: `work.test.ts`)*

- Default runner availability checks and test execution both prohibit package network access; a locally unavailable runner stays unavailable rather than initiating a metadata lookup. Project-declared commands keep their own network policy. *(test: `review-confirm.test.ts` "defaultCommandAvailable: no local tsx falls back to asking npx itself (hoisted/global counts)")*

These are the contracts the build commits to. Tests land with the step that builds each; until then they are marked planned. The step-4 set was hardened after a second adversarial re-verification (7 confirmed holes, all closed) — each invariant below names the test that now pins it.

- **The review fingerprint binds the reviewed sources, the tests the findings name, AND the oracle the reviewer was handed — over the FULL real-change set, auto-invalidating when any of them change.** Content is byte-normalized (BOM/CRLF) like every other hasher, so a benign line-ending flip never false-blocks; any source, config/data, or deletion edit moves the fingerprint. Binding the named tests is load-bearing: a confirmed finding cannot be **green-washed** by editing or deleting its test while leaving the buggy source unchanged — that tamper moves the fingerprint and reopens the gate. Binding the oracle closes the same gap one level up. The fingerprint bound what was reviewed and what pinned it, and said nothing about what the reviewer was told to attack, so the documented contract and the must-not-break list could be rewritten after a review was recorded and the artifact went on covering the diff. A review of invariants that no longer exist is not a review of this change — and this is the routine case, not an exotic one, since updating the owning doc in the same step is exactly what the loop asks for. The bound value is the bundle's own feature projection rather than a second reading of the docs beside it, so the thing bound is literally the thing handed over. **It is a separate component and never joins the real-change set**, and that separation is the whole difficulty: that set also counts the change's SIZE, which is what decides whether a diff is trivial enough to need no review at all. Folding docs into it would make every loop-compliant edit two real changes and retire the trivial fast-path entirely — the proportionality rule turned off by the fix for an unrelated hole. *(tests: review-artifact.test.ts — gatherReviewFingerprint moves on a named-test edit/deletion and on source/set/base change, is byte-normalized, and ignores a finding with no test; review-bundle.test.ts "the oracle is bound, and it is the oracle the bundle handed over" — a rewritten invariant and an emptied orientation layer both move it, stable and order-independent; review.test.ts "rewriting the oracle reopens the gate, without inflating the change" — a rewritten invariant voids a recorded review with no source touched, and a doc edit beside its own source stays one real change on a trivial diff)*
- **A focused artifact attests exactly the projection its bundle disclosed.** The durable record stores a
  validated compact boundary and folds its fingerprint into the review fingerprint; lookup also
  requires exact binding equality. Recording generates that metadata from the live staged invocation,
  so hand-authored review input cannot substitute another boundary. Legacy working-tree artifacts and
  focused artifacts never cover each other. *(tests: `review-boundary.test.ts` staged bundle-to-record
  flow and moved boundary; `review-artifact.test.ts` boundary parsing and exact coverage)*
- **A changed test is review evidence, even though it is not documentation-owned source.** Focused
  reviews add every staged test to the real-change fingerprint and artifact file set. An explicit
  invariant pin attributes it first; supported direct TypeScript imports are the fallback. Attributed
  features and their dependents enter the bundle oracle; a deleted test can retain a surviving pin,
  and anything those signals cannot attribute remains visible. None of these paths wakes a doc or creates registry
  work. *(tests: `test-impact.test.ts`; `review-boundary.test.ts` test-only strict/bundle/record flow;
  `review-bundle.test.ts` test-only oracle, dependents, and delta projection)*
- **A finding hard-blocks only when its named test is genuinely red, re-run by the gate at check time; a toolchain failure is never a false block.** Non-testable findings stay advisory. A nonzero exit counts as red only with evidence the runner actually executed tests (TAP); a missing runner or resolution error exits nonzero with no test output and degrades to unrunnable→advisory, so a consumer without the test toolchain is not blocked on every finding. **Evidence already on the wire is not thrown away when the clock runs out.** A run cut off by the budget normally proves nothing and stays advisory — but where the child had already reported a failing test before it was killed, the reproduction happened, and downgrading it because the file had more to do afterwards would discard a demonstrated bug. So a timeout carrying a failure is judged red like any other. The rule is deliberately **one-directional**: a timeout can become a block and never a pass, because the tests that did not get to run are precisely the ones a green reading would be making a claim about. **Honest limit:** the flip side of requiring TAP evidence is that a runner which does not emit it (vitest/jest in their default reporters) makes a *real* red test read as unrunnable→advisory (fail-open), so the blocking half assumes a TAP-emitting runner. A non-node:test project points the gate at one via `--test-command` (e.g. a TAP reporter); otherwise its findings stay advisory rather than blocking. *(tests: review-confirm.test.ts — a red test with TAP confirms (blocking); a nonzero exit with no test evidence is unrunnable; a claimed status is overridden by the reproduction; and the partial-evidence rule asked from both sides against the real runner — a failure already reported before the kill is judged red, passes alone are still never a pass)*
- **The verdict path never fetches code: default runner resolution is local-only, and "could not run" is said out loud.** The default test command refuses network resolution (a gate must not execute unpinned third-party code it just downloaded, nor hang on an install prompt in CI). When no runner is resolvable without a fetch, the review summary and `--json` carry a NAMED condition telling the human to pass `--test-command` — findings then read advisory because nothing could adjudicate them, and the output says exactly that instead of a silent always-green. **Availability is asked of the runner actually in play, not only of the built-in default.** It was only ever asked of the default, which left the project that declared its own runner with no signal at all — and that is the project most likely to have got it wrong, since the default is at least maintained here. A declared runner that does not exist produced the identical surface as one that ran and found nothing: every finding advisory, and no reason given anywhere. The two are probed differently because they are different questions. The default's `argv[0]` is `npx`, which resolves on every Node install, so the real question there is whether the runner behind it is reachable without a fetch. A declared command's `argv[0]` is the project's own binary, and the honest check is whether it EXISTS — resolved against the project's bin directory and the system PATH, in the platform's own terms, and never executed, because running an arbitrary declared command with arbitrary arguments to see whether it works is a side effect this gate has no business causing. A runner that resolves and then emits nothing is a different fact, already carried by the outcome-keyed causes, which is why the availability reason is consulted only when nothing else already explains the silence. The condition stays non-blocking, matching the fail-open stance for unverifiable claims. The runner spawn itself is platform-honest: npm-family `.cmd` shims are spawned shell-safely on Windows (post-CVE-2024-27980 Node throws EINVAL on a shim without a shell), so the confirm gate is not structurally always-green off-POSIX; POSIX spawning is byte-identical to before. The child also runs in a **verdict-pure environment** — the runner strips every ambient variable that could flip the child's exit independently of the code under test, so the verdict is a pure function of the project, never the shell the developer happens to run from. That covers `NODE_TEST_CONTEXT` (whose parent test-runner IPC context would make a *failing* `node --test` file exit 0, a red test read green when the gate runs inside another test run) and, just as load-bearingly, ambient `NODE_OPTIONS` and coverage hooks — including an IDE debugger's auto-attach injection: VS Code's *Auto Attach* sets `NODE_OPTIONS=--require <js-debug bootloader>`, which crashes the spawned child before it emits any TAP, so a genuinely red test would read `unrunnable` and the editor would silently decide the gate's verdict. A project that truly needs a Node flag passes it in the test command, never via the ambient environment. **Honest boundary:** the same Windows shell that keeps the gate from being structurally green leaks a process when the budget expires — Node kills `cmd.exe` and the test child it started is reparented and runs on, one survivor per timeout (measured, not assumed). Reaping the tree would need an asynchronous spawn holding a job object, which would trade the runner's synchronous purity for a symptom that a budget the project can set makes rare; POSIX has no shell in the path and so no orphan. *(tests: review-confirm.test.ts "default command is local-only (no network on the verdict path)", "win32-safe spawning", "strips NODE_TEST_CONTEXT so a spawned node:test child reports its TRUE exit", "an ambient NODE_OPTIONS debugger injection cannot flip a real red test to unrunnable", and the cleanNodeTestEnv env-purity unit tests; "runner availability is asked of the runner in play" — a declared runner named when missing, accepted when it resolves without being executed, found in the project's own bin directory, and the default still probed for its own runner; review.test.ts "--require-review names the could-not-run condition" and "a declared runner that does not exist reaches the verdict")*
- **The adversary is never on the gate's certification path beyond producing candidate findings.** Pass/fail is decided by running tests, with no model call in the verdict. *(test: review-confirm.test.ts — the classifier is a pure function of test outcomes)*
- **A clean pass must enumerate the invariants the adversary checked; silence is not a pass.** The artifact schema rejects an empty bill of health. *(test: review-artifact.test.ts — parseReviewArtifact rejects an empty/whitespace invariantsChecked)*
- **An attestation says what it was grounded in, or says that it says nothing — and either way it is disclosed, never refused.** An artifact recorded a verdict and nothing about the oracle behind it: which invariants the reviewer was shown, which tests it was pointed at, which files it was told to attack all went unrecorded, so a review of a stale or empty contract was indistinguishable from a review of a full one. The bundle therefore stamps what it handed over — a digest of its own content, reproducible from the same repo state and impossible for a reviewer to mint — and the record carries the stamp it answers. Absence is recorded as absence: "this review said nothing about its oracle" and "this artifact predates stamps" are different facts, and folding them together would let the first hide inside the second forever. A present-but-malformed stamp is corruption and refused, because accepting it as unstamped would let a broken writer read as an honest one. **Missing is disclosed, not refused**, and the objection that decided it is worth keeping: refusing would dead-end the first review of any diff, whose own printed route never mentions `--bundle` at all, and it would be walked past by anyone willing to omit one field — a guard that binds only the honest actor is not a guard. So an unstamped review clears the gate and says so, on the verdict line a pipe keeps and above it with the route that fixes it. The stamp is part of what the artifact attests: two reviews of one change set that answered different oracles are two different claims about it. *(tests: review-bundle.test.ts "the bundle stamps what it handed over" — identical content stamps identically, the stamp moves when the file set or the invariants shown move, and it is the digest of the body it ships; review-artifact.test.ts "an artifact records the oracle it answered, or records that it had none" — the three states kept distinct, a malformed stamp refused, the stamp part of the attestation key; review.test.ts "an unstamped review is disclosed, never refused" — clears the gate and rides the last line, silent once stamped, malformed refused with nothing written)*
- **An attestation is identified by what it attests, so no review is ever silently destroyed by another.** The stored file was named after the diff fingerprint alone — a claim the artifact never made. The fingerprint says which change set was reviewed; it says nothing about who reviewed it, what they enumerated as checked, or what they found, so a second review of one change set overwrote the first with no diagnostic and no trace. Keying on the findings would not have saved it either, and the field's own loss says why: a finding's named test is already folded into the fingerprint, so what collided was precisely the part that was not — the invariants and the signer. What went missing there was ten CHECKED INVARIANTS, not ten findings, and losing the record of what an independent reviewer verified is worse than losing a finding, because a finding leaves a bug behind while this leaves a false account of how carefully the change was examined. The name is now a digest of the whole attestation, so re-recording an identical review is still idempotent and overwrites in place, while two genuinely different reviews of one change set are two files that both stand. The per-file hashes are excluded, because they scope the next bundle and attest nothing — including them would split one review in two whenever the change set moved beneath an unchanged verdict. And because two attestations can now coexist, the gate enforces EVERY covering artifact rather than the first it finds: an arbitrary pick is a verdict, and it is the lenient one, since the finding raised by the review that lost the toss would go unenforced. Claims raised identically by two reviewers fold into one — otherwise its test runs twice and the adjudicated tallies count how many people looked rather than what they found — and anything differing in any field survives as the distinct claim it is. `--record` says when a recording joined an existing one instead of replacing it, because a reader expecting a replacement is owed the difference. *(tests: review-artifact.test.ts "reviewFileName is keyed on what the artifact attests" — idempotent for an identical attestation, separated by signer / invariants / findings, unmoved by `files`; "keeps two reviews of one change set, and returns both"; "mergeCoveringFindings"; review.test.ts "two reviews of one change set both stand, and both are enforced" — two `--record` runs leave two files, the notice fires, and the gate blocks naming both signers' findings)*
- **Re-confirmation runs only an in-tree test; a reference that escapes the repo is refused, by realpath not just lexically.** A `../../` ref and a symlink under root whose target leaves the tree both fail to resolve, so the gate never spawns the runner on out-of-tree code. *(test: review-confirm.test.ts — resolveTestPath rejects a `../../` ref and a symlink escaping root, still resolves an in-root symlink)*
- **The fingerprint base is a resolved object name, never the literal `HEAD`.** It is the HEAD sha, the `--base` merge-base sha, or the empty-tree sha before the first commit, so a fresh-repo/first-commit boundary cannot flip the base under an unchanged tree, and the step-5 writer records exactly this value. *(test: two-ref.test.ts — resolveBase single-base/empty-tree + the EMPTY_TREE_SHA constant; the `getHeadSha ?? EMPTY_TREE_SHA` fallback wiring in review.ts is covered by construction, not yet unit-tested)*
- **Enforcement is host-neutral; only the spawn differs.** The bundle, confirm, artifact, and gate run identically for Claude and Codex — a fresh subagent on a subagent-capable host, a same-agent adversarial pass otherwise. No profile *requires* subagents. *(honest boundary — the spawn is host orchestration in the `review-work` skill, not codument code; the CLI it calls (`--bundle`/`--record`/`--require-review`) is identical on both)*
- **The artifact writer shares one fingerprint contract with the gate.** `review --record` computes `diffFingerprint` and `base` with the same `gatherReviewFingerprint`/`effectiveBase` the gate uses, so a hand-authored or drifted writer cannot produce a passing-but-mismatched artifact, and a malformed findings file is rejected before anything is written. *(test: review.test.ts — record then `--require-review` covers the diff; an edit reopens it; an empty `invariantsChecked` is rejected)*
- **Review effort is a conservative structural floor.** A focused candidate needs precise existing source ownership, unchanged signatures and attributable changed tests. Public-surface changes, protected contracts, risks on either side, deletions, configuration, dependencies, module residuals, missing evidence and uncertain analysis require adversarial review. Original facts remain bound even after documentation repair or acknowledgment. The host raises effort for substantial or uncertain behavior; the classifier cannot authenticate independence or semantic safety. *(tests: `review-gate.test.ts`, `review-boundary.test.ts`, `review-bundle.test.ts`)*
- **Required review confirms every covering finding, including when no new worksheet is required.** The compact staged verifier enforces review by default; the separate diagnostic review command retains its explicit required-review option. A finding blocks only when its named test reproduces a failure; unavailable reproduction and untestable concerns remain disclosed. Empty findings cannot prove a thorough review, and the host remains responsible for judgment calls. *(tests: `review-gate.test.ts`, `review-boundary.test.ts`, `verify.test.ts`)*
- **The bundle adds no new source of truth.** It is derived purely from committed docs and the deterministic change-state (diff, ownership, blast). *(test: review-bundle.test.ts — pure projection of change-state + docs)*
- **Scoping the oracle never widens the gate.** After a fix, `--bundle` narrows to the files that moved since the last recorded review (`scope: "delta"`), carrying the rest as `alreadyReviewed` and that review's `priorFindings` for context; `--full` forces the whole set, and an AMBIGUOUS prior (two artifacts for one base sharing an mtime — a coarse filesystem, a copied reviews directory) falls back to full scope rather than picking arbitrarily, since a wrong pick would report a file as already attacked when a different review attacked it. Coverage is untouched: it remains equality against an artifact's whole-change-set fingerprint, so a narrow read can never buy a broad pass, and the per-file hashes an artifact now records are scoping information the gate never reads. Refusing to make coverage COMPOSABLE is the load-bearing half — `--record` fingerprints the whole change set regardless of which files a delta handed the reviewer, so composable artifacts would mint a durable pass for files nobody attacked. That independence is about SCOPE only; what the artifact is bound to now includes the oracle's content ([021](../architecture/decisions/021-an-attestation-binds-and-discloses-what-it-was-grounded-in.md)). **Honest limit:** a fix in file A can weaken file B; B's bytes did not move, so a delta bundle will not re-attack it. `alreadyReviewed` gives the reviewer what it needs to notice; the gate does not promise to catch it — the same class of limit as the empty-findings one below. *(tests: review-artifact.test.ts — an artifact carrying `files[]` still voids on any edit, plus `reviewedDelta` and `findLatestReviewForBase`; review-bundle.test.ts — delta scope narrows `changedSources` but never the per-feature contract block; review.test.ts — record, fix one file, get a one-file delta carrying the prior findings, and the gate still exits 1)*
- **The verdict never claims to cover a diff it adjudicated nothing in.** "Does a review exist for this diff" and "was anything in it checked" are two questions, and one line used to answer both: a passing gate printed *covers this diff* whenever a fingerprint-matching artifact was found, whatever running its findings had produced. In the field they came apart completely — five delivery steps, every finding recorded with a named test, a runner that resolved to nothing, and a covering verdict every time. Twelve real bugs were fixed that session because the author fixed them, not because the gate held. The condition line above the verdict was correct throughout and centrally worded, which is exactly the shape the release's other findings take: the fact was reachable only where the reader was not looking. So the gate now carries what it adjudicated as a first-class part of its result, and a run with anything unjudged says it is *on record for* the diff rather than covering it, names how many of how many went unchecked, and repeats that on the verdict line a pipe keeps. Unjudged counts a finding that OFFERED a reproduction the gate could not perform — a named test whose run failed at the toolchain — and deliberately not one that named no test at all. That second kind is a judgment call, which this gate has always kept advisory by design; nothing was ever going to reproduce it, so counting it would put the warning on nearly every honest review and teach the reader to skip the line, which is the cries-wolf failure arriving through the fix for a different one. The rule is that the warning marks something the reader can act on: a broken runner is actionable, an untestable claim is not. Nothing about blocking moved either — an unverifiable claim still never blocks (the documented fail-open stance), and a review that found nothing still covers the diff, because zero of zero is not an unjudged claim. *(tests: review-gate.test.ts "what it adjudicated is not what it covers" — a run test against an unrunnable one, a finding that named no test staying uncounted, the field's all-unrun shape, and the empty review claiming nothing; review.test.ts "a review that adjudicated nothing says so" — the verdict refuses the word and the last line carries the count — and "a review of judgment calls alone still covers the diff")*
- **The confirm step says how many claims went UNJUDGED, whatever the reason.** The condition is keyed on outcomes, not on which flag was passed: any finding whose named test comes back unrunnable is counted and named. Keying it on flag-absence meant that supplying any command silenced it — so a project pointed at a runner emitting no TAP had every finding quietly downgraded to advisory with nothing on screen, the silent always-green this gate exists to prevent. A refused declaration and an unadjudicated count are usually ONE incident, and the builder takes every refusal the resolvers produced rather than a single one — a slotless `testCommand` falls back to a default that cannot emit evidence — so both are said, never one instead of the other: reporting only the count names the symptom and drops the cause, advising a TAP reporter when the declared runner was fine and only its `{file}` slot was missing. The default-runner probe survives only as the last resort, for a project that declared no runner and has no other explanation. **Each cause carries its own remedy, and only the remedies that apply are offered.** One route stapled to the end of every cause is how this line came to tell a reader whose test command was perfect to go and rewrite their test command: their tests had simply run out of codument's clock, which is not a fact about their project at all — the runner was present, the command was right, the test was running. A route offered where nothing it names can work is the failure [020](../architecture/decisions/020-a-block-must-be-provable.md) removed from the change-control gate, and this is the same rule in the other gate. So a timeout is counted apart from a toolchain gap, named as itself with the budget that expired (never as the shell it happened to spawn), and routed to the clock; a run that hit both says both and offers both. The count is a typed cause on the result, not a phrase grepped out of the diagnostic — a routing decision must never rest on sniffing prose. One shared builder words the line for every surface that runs tests, `doctor --verify-invariants` included (its `--json` carries it too), so the two consumers of one runner cannot describe a toolchain gap differently — building it per call site is exactly how they diverged. *(tests: review-confirm.test.ts "confirmCondition" — cause and count together, the probe only as a last resort, both numbers and both nouns, and the per-cause routes asked from both directions so naming both can never satisfy the split; review.test.ts — a configured runner producing no test evidence names the unadjudicated count and the no-local-tsx fallback still fires for an undeclared runner; adversarial-review-testcommand-parity.test.ts — the two surfaces agree, including once a covering review exists)*
- **How one test file is run — the command AND the clock — is project config, not a per-run flag.** `testCommand` and `testTimeoutSeconds` in `.codument-meta.json`, both resolved inside `makeTestRunner` so a caller that omits either still gets the project's, never codument's own; `--test-command` and `--test-timeout` override them. How a suite is run and how slow it is are both facts about the project, and the budget is the half that was missing: it existed only as a constant no surface reached, so the one way to change it was to edit codument. A declaration that cannot mean what its author intended is REFUSED and reported rather than silently obeyed — a command with no literal `{file}` slot would run the whole suite once per finding, reading as a working gate while adjudicating nothing; a budget of zero or less would make every test unrunnable, which is a silently green gate. Both refusals degrade to the default rather than throwing, because the meta file is read on nearly every command path and a typo here must not break `scan`, and every refusal present is carried — a project can get both wrong at once, and reporting one sends the reader to fix a setting that was never the problem. The default budget is a **measurement, not a round number**: it is set above this repository's own slowest test file, because a tool whose gate cannot adjudicate a finding naming its own largest suite cannot gate itself. The unit lives in the key name for the same reason the refusals are loud — a millisecond value read as seconds expires instantly and turns every finding advisory. *(test: review-confirm.test.ts — precedence and refusals for both declarations, the unreadable-meta degrade, the pinned default, and `makeTestRunner` resolving each from config with nothing passed, proven against a real hanging process; review.test.ts — a declared runner suppresses the nag, a slotless one is refused out loud)*
- **The bundle names the governed files no adapter can judge, because a file that gates the commit must not be missing from the oracle.** A file the registry owns that no adapter recognizes is watched and reported at file grain ([017](../architecture/decisions/017-registration-is-governance.md)) — a locale pack, registered config, a content file. Whether it BLOCKS is the project's own declaration and not the tool's guess: only where an owning entry carries a `risk` tag does it gate on a content change ([020](../architecture/decisions/020-a-block-must-be-provable.md)), and then it can block a step while carrying no symbol diff at all. Its deletion gates either way. It is named in its own bundle field because the reviewer must read it differently: there is nothing to reason about structurally, so the only question is whether the file's content still matches what its owning doc promises — which the stale-doc facts in the same bundle pair it with. The field names every governed file in the change, so under a delta a governed file that moved is named there and in the attack list both; the field says what kind of file this is, not whose turn it is to be attacked. *(test: review-bundle.test.ts — a governed registered change rides the bundle)*
- **The bundle's dependents list is the ranked summary, not the raw edge pairs.** One entry per dependent feature with its edges collapsed, features depending on a changed FEATURE before ones riding only a concept umbrella. The bundle exists to hand the adversary a bounded contract; dozens of unranked reason-less pairs is the opposite of bounded, and it is a section a real warning can appear in. *(test: review-bundle.test.ts — the bundle carries `dependentsSummary`)*

## Decisions

- Deferred: remote review enforcement needs private artifact transport and a review identity matching the exact CI change range before enabling a required-review gate. Local ignored receipts do not travel with a checkout or establish review of an aggregate pull request. A zero-finding record alone does not demonstrate reviewer independence.
- Adversarial review is independent by context and degrades without subagents (option A: same-agent pass on Codex) — honors the [agent-delivery-workflow.md](agent-delivery-workflow.md) non-goal that no profile may *require* subagents. To be recorded in a future ADR when step 6 lands (011 and 012 were since taken by the plan adversary and file-grain acks).
- A finding blocks only when confirmed by a runnable failing test; judgment findings stay advisory — the deterministic-not-judge line of [008](../architecture/decisions/008-benchmark-proof-deterministic-not-judge.md) and the detect-test-verify line of [010](../architecture/decisions/010-freshness-resolution-detect-test-verify-agent-driven.md), applied to implementation review. To be recorded in the same future ADR.

## Key files

- `src/lib/review-bundle.ts` — assembles the adversary's contract bundle from the selected change-state plus the owning/blast docs' invariants-and-tests, attributed test evidence and dependency impact, plan slice, ownership facts, and compact focused-boundary binding.
- `src/lib/review-artifact.ts` — the fingerprint- and optional boundary-bound review record: parse/validate, coverage, auto-invalidation. Its `gatherReviewFingerprint` binds the reviewed sources together with the findings' named tests and the selected boundary, so a test tamper or projection move invalidates the review. Sibling to `acknowledgment.ts`.
- `src/lib/review-confirm.ts` — runs each finding's named failing test and marks it confirmed (blocking) or advisory, distinguishing a red test from a toolchain failure (no false block) and refusing an out-of-tree test path.
- `src/lib/review-gate.ts` — the pure gate decision: the proportionality predicate and the verdict over a covering artifact's re-derived findings.
- `src/commands/review.ts` + `src/cli.ts` — the command surface: `--bundle` emits the oracle, `--record` writes the fingerprint-bound artifact (sharing the gate's fingerprint contract via one `computeRealChange`), and `--require-review` assembles the real-change set, finds the covering artifact, re-confirms its findings, and folds the verdict into the exit code.
- `src/lib/git.ts` + `src/lib/two-ref.ts` — `getWorkingTreeDeletions` / `worktreeDeletionsSince`: the deletion view the change-state path deliberately drops, so the gate counts deletions toward proportionality and moves the fingerprint on a deletion.
- `skills/review-work/SKILL.md` + `agents/adversarial-reviewer.md` — the spawn/degrade orchestration: the skill feeds the bundle to a fresh `adversarial-reviewer` subagent (Claude) or runs the same-agent pass (Codex); the agent attacks the invariants, writes failing tests, and emits findings. Installed into a subagent-capable profile via `AGENT_DEFINITIONS` (`init.ts`/`update.ts`/`agent-profiles.ts`).

## Delivery plan

Status: approved (2026-06-30). Implementing manually, one gated step at a time. This section is transient scaffolding and compacts out when the feature ships; surviving decisions move to the Decisions layer and ADRs.

- [x] **Step 1 — Review bundle assembler.** From a diff + base, assemble `{diff hunks, owning+blast docs' Invariants & boundaries + their test pointers, plan slice, ownership/blast facts}`. Pure and deterministic; reuses the change-state analyzer and ownership. Register `src/lib/review-bundle.ts` and bump this feature to `in-progress`. *(`src/lib/review-bundle.ts` + `tests/review-bundle.test.ts`, registered.)*
- [x] **Step 2 — Review artifact + fingerprint binding.** Define `.codument/reviews/<id>.json` (verdict, invariants-checked, findings[citation, failing-test, status], diff fingerprint). Reuse the acknowledgment fingerprint-binding so any edit after review auto-reopens the gate. Reject an empty invariants-checked list. *(`src/lib/review-artifact.ts` + `tests/review-artifact.test.ts`: parse/validate, `diffFingerprint`, `reviewCoversDiff`/`findCoveringReview` auto-invalidation, loose `.codument/reviews/` files.)*
- [x] **Step 3 — Confirm step.** Run the findings' named failing tests, mark confirmed vs advisory. Deterministic, no arbitrary-code execution beyond the project's own test runner. *(`src/lib/review-confirm.ts` + `tests/review-confirm.test.ts`: pure `confirmFindings` classifier — red→confirmed/blocking, green→resolved, unrunnable/no-test→advisory, claim overridden by the reproduction — plus a thin `makeTestRunner` shelling out to the project runner.)*
- [x] **Step 4 — Gate wiring (gate core), hardened after a multi-lens adversarial review.** Add the opt-in `--require-review` gate: fingerprint the diff, find the covering artifact, evaluate proportionality + verdict, fold into the exit code. Shipped as a **distinct opt-in flag rather than folded into `--strict`** (folding it in would break autopilot's step-sync gate and dogfooding on every multi-file change); default-on flip is soak-deferred. A multi-agent adversarial workflow (7 confirmed findings) drove the final shape: the gate **re-derives** finding statuses by re-running each named test (never trusts a claimed status); proportionality and the fingerprint cover the **full real-change set** (sources + config/data + deletions), so deletions, config edits, coarse/non-TS, and new unmapped files no longer read as trivial; the fingerprint is **byte-normalized** (no CRLF/BOM false-blocks). *(`src/lib/review-gate.ts` + `tests/review-gate.test.ts`; `review.ts`/`cli.ts` wiring; deletion helpers in `git.ts`/`two-ref.ts`; round-trip + re-derivation proven live.)* **Re-scoped:** the `watch` surfacing and the impact-ledger `review` event move to step 6 — both are display/telemetry, and the event needs an impact-ledger schema decision (new type vs. reuse) that shouldn't bloat the gate step.
- [x] **Step 4a — Re-verification hardening.** A second adversarial workflow (five skeptics, each break independently re-verified) found **7 confirmed holes** in the step-4 "done" state — proving the thesis recursively. All closed: **(high)** a confirmed finding could be green-washed by editing its named test (fingerprint omitted tests) → the review fingerprint now binds named-test content (`gatherReviewFingerprint`); **(high)** a shared-file edit with an unassigned co-moved symbol read trivial → an ownership lint now forces a review; **(med)** a `<module>`-residual-only edit read trivial → excluded from the trivial count (`countResolvedMovedSymbols`); **(med)** a toolchain failure false-blocked every finding → the runner now requires TAP evidence to call a nonzero exit `failed`, and the test command is overridable; **(low)** base could be the literal `HEAD` → resolved to a real/empty-tree sha; **(low)** a symlinked test escaped the lexical guard → realpath containment; **(low)** doc front-matter omitted two sources. *(11 new regression tests across review-artifact/-gate/-confirm; 660 tests green.)*
- [x] **Step 4b — Re-verifying the fixes themselves.** A second workflow attacked the step-4a fixes and found a **high-severity false-negative I had introduced**: excluding the `<module>` residual from the symbol count only handled the residual-ALONE case, so a behavior edit PLUS a new side-effecting import / registered global handler (residual + one symbol) landed on count 1 and read trivial — skipping review. Closed with a `moduleResidualMoved` gate trigger (any residual move requires a review). Two lows also closed: the `--test-command` override was unreachable from the CLI (added the flag); a realpath TOCTOU (resolveTestPath now returns the canonical path the runner spawns on). One honest limit documented, not "fixed": the TAP-evidence runner fail-opens on a non-TAP runner (vitest/jest default reporters) — the `--test-command` flag is the escape, else findings stay advisory. *(tests updated; full suite green.)*
- [x] **Step 5 — Spawn + degrade.** The orchestration: `codument review --bundle` emits the oracle JSON; the `review-work` skill spawns a fresh `adversarial-reviewer` subagent fed ONLY the bundle (Claude) or runs the same-agent adversarial pass against it (Codex); the reviewer emits a findings JSON; `codument review --record <file>` writes the fingerprint-bound artifact; `--require-review` enforces. **The writer is a CLI command, not agent-hand-computed** — `--record` computes `diffFingerprint` via `gatherReviewFingerprint` (same base, full real-change set, named tests) and records `base` as the gate's `effectiveBase`, so the writer cannot drift from the gate's contract (an agent cannot reproduce a sha256). *(`review --bundle`/`--record` in `review.ts` + `cli.ts`; `agents/adversarial-reviewer.md`; `skills/review-work/SKILL.md`; `AGENT_DEFINITIONS` install in `init.ts`/`update.ts`; bundle+record+auto-invalidation proven end-to-end in `review.test.ts`.)*
- [ ] **Step 6 — Docs + ADR + tests + deferred surfacing.** Write the ADR(s) for the decisions, fill remaining Invariants test pointers, finalize the registry entry, cover both profiles, and land the step-4-deferred `watch` surfacing + impact-ledger `review` event.

### Acceptance criteria

- The bundle is reproducible from committed docs + change-state, with no model call and no new source of truth.
- The gate blocks a behavior-change diff that lacks a current, diff-bound artifact, and passes once the artifact exists with all confirmed findings resolved.
- A confirmed finding (failing test) blocks; a judgment finding is recorded and routed to the user decision point, never auto-blocking.
- Editing the diff after a review auto-invalidates the artifact and re-opens the gate.
- Trivial diffs (no invariant touched, single-symbol, existing owner) pass without an artifact.
- Enforcement behaves identically across Claude and Codex profiles; only the spawn path differs.

### Verification strategy

- Unit tests for the bundle assembler (deterministic output from a fixed change-state), the artifact parse/validate/coverage/auto-invalidation, and the confirm step.
- Gate tests proving block-without-artifact, pass-with-artifact, auto-invalidation on re-edit, and the proportionality skip.
- Profile tests proving host-neutral enforcement and the two spawn paths.
- `npm run typecheck`, `npm run build`, `npm test` on any source-touching step.

### Non-goals

- No autonomous fixing: judgment findings still hit the user decision point.
- No requiring subagents anywhere — Codex degrades to the same-agent pass.
- No running agent-authored code beyond the project's own test runner.
- The **plan adversary** (contesting the plan before work) is a sequenced follow-up, out of scope here.

### Open questions

- The feature's registry entry was added in step 1 alongside its first source file (a registered feature with empty `primary_sources` would read as undocumented).

## Delivery Plan — proportionate review and 0.21.0

Plan-ID: proportionate-review-0-21-0
Status: approved
Approval-Model: outcome-v1

- [x] Step 1: Remove unnecessary review for harmless documentation additions and restore the portable test baseline.
- [x] Step 2: Use focused review for well-grounded changes within one feature, preserving risks and attribution from both snapshots.
- [ ] Step 3: Compare real agent delivery against 0.20.1 and retain working-output and administration evidence.
- [ ] Step 4: Finish the verified 0.21.0 release with a local commit and tag.

### Outcome

Routine work spends less effort satisfying Codument without losing its working deliverables.
Harmless documentation additions need diff self-review rather than a recorded adversarial pass.
Precise, contract-neutral edits to existing files within one stable feature, and attributable
changes to that feature's tests, can use recorded focused self-review. Real risks, protected
contracts and meaningful uncertainty retain stronger review. The release includes observed agent
output and administration evidence, then leaves npm publishing to the user.

### Constraints & non-goals

- Positive snapshot evidence determines the structural floor. A filename, missing contract record,
  file count or informal low-risk label alone does not establish safety. The host still raises
  effort for substantial behavior or semantic uncertainty.
- Documentation housekeeping must be positively established from readable selected and base inputs
  where present. Material protected layers, instructions, declared risks, deletions and renames
  retain stronger review. New durable contracts and executable or instruction inputs cannot pass
  as harmless prose merely because their extension is Markdown.
- Existing-source focused candidates have precise unchanged signatures, one stable owner and
  attributable test evidence. New production sources, new or removed exports, changed signatures,
  residual or unknown analysis, changed ownership, cross-feature behavior, configuration and
  dependency changes retain stronger review.
- Test-only focused candidates retain stable attribution to one nonrisk feature. Existing evidence
  is checked against both base and selected snapshots; new tests require selected attribution.
  Lost, changed, unknown or cross-feature attribution and removed or renamed tests retain the
  stronger pass. Removing an import, invariant pin or risk declaration cannot erase the old oracle.
- Preserve staged isolation, documentation synchronization, source mapping, approval boundaries,
  reproduced-red findings, exact artifact/receipt binding and independent branch/portable review.
  Policy changes invalidate incompatible cached evidence; old artifact formats remain readable.
- Add no dependency, bypass flag, universal risk score, permanent timer or autonomous agent runner.
  The existing explicit-root alias limitation is outside scope; normalize fixture paths without
  changing runtime containment rules. Preserve explicit pauses and gated mode.
- Keep release actions local. No npm publication, push or remote release. The old test-only release
  proposal is replaced on approval; its prepared metadata is retained for the final release slice.

### Acceptance evidence

1. A real managed hook accepts a harmless new documentation note without a required review artifact.
   The same staged gate still requires stronger review for a new protected contract or instruction,
   declared risk, unreadable analysis and control-plane/configuration changes. Existing covering
   reproduced failures still block even when the structural minimum is none.
2. Representative body-only edits across two existing files owned by one feature, and stable
   attributable test-only changes, receive focused review. Unknown or changed attribution, old or
   selected risk, cross-feature changes, source additions, signatures, deletions and renames receive
   adversarial review. Changing a staged snapshot or covering evidence reopens the verdict.
3. Four fresh agent attempts form two matched pairs on the same small working-CLI repair. Released
   0.20.1 and the frozen candidate get identical code, documented behavior, approved task scope,
   host/model settings and no-commit endpoint. Every attempt retains its status and evidence,
   including failure or timeout. Candidate attempts must deliver the promised valid/invalid CLI
   behavior and verified staged readiness with fewer unnecessary adversarial-review handoffs than
   their matched controls and no unnecessary human approval stops. Missing output or no reduction
   leaves acceptance open. Operator-observed reviewer starts establish the handoff count; common
   CLI observations and elapsed time are reported separately rather than assumed to fall.
   Protected-case regression checks remain green. Measured elapsed time is reported as observed,
   including noise; unavailable token usage is explicit. A bounded fixture does not establish
   universal speed, token savings or higher output across all projects.
4. Package and scaffold versions agree on 0.21.0. The full suite, typecheck, build, lint, strict
   documentation health, exact staged verification and npm packing lifecycle pass before the local
   release commit and tag. The package contains its CLI, library and managed workflow assets.

### Verification

Run red/green cases in review policy, bundle, test-impact, boundary, verifier and managed-hook suites.
Exercise source-count independence, both-snapshot attribution/risk, instruction and configuration
controls, missing inputs, artifact invalidation and covering reproduced failures through the CLI.
Normalize the two work fixtures that currently mix macOS temporary-directory spellings; keep their
containment and delivery assertions intact. Run the project checks for each source slice and record
independent staged review before its focused commit.

For agent evidence, derive a small dependency-free CLI fixture from the existing milestone example,
using precisely analyzed TypeScript sources under one owner, broken behavior and unchanged
documented contracts. Use the same already-installed compiler in both conditions and exercise its
emitted CLI; no dependency installation is needed. Preflight the exact representative staged change
as adversarial on the baseline and focused on the candidate before spending the live-attempt budget.
The identical task requires repairs within existing function bodies and regression-test changes
attributable to that owner; it preserves exported signatures and module-level initialization.
Freeze the same legacy scoped approval in both conditions to avoid an approval-model confound.
An immutable external grader exercises actual output, tests and staged blobs, checks authorized
changes, and requires verified readiness for the first milestone of the same two-step plan.
The future milestone stays untouched. Both conditions prohibit commits and edits to locked task
inputs. Final-plan compaction is outside this step-level comparison: it would add approval-state
configuration changes and measure a different review boundary. This trial establishes real working
output and staged step readiness, not complete plan finalization.
Use a common external invocation record for both versions; candidate-only timing cannot serve as
a matched baseline. Record actual observed CLI actions, reviewer starts and attempt elapsed time rather than infer time
from ledger gaps. Give both versions the same delegation capability; required adversarial review
uses a fresh reviewer, and its work is included in the attempt's observed administration. Focused
self-review remains available only where the policy and understood behavior permit it. Run the
attempts serially, in two pairs with order reversed, each attempt capped at ten minutes. Keep all
four observations and provenance outside agent-controlled result claims. Stop at the cap, retain
failures, and leave missing evidence open rather than silently substitute a scripted replay.
No public benchmark API or permanent runner is needed; retain compact reproducible fixture and
observation artifacts under the existing benchmark area, with scope and limitations in its docs.

Finish with the complete suite and package lifecycle, review the exact final release boundary,
compact this plan through the tracked final-delivery binding and commit/tag locally.

### Scope

Routing guidance; outcome permission does not depend on this initial file list:

- `src/lib/review-gate.ts`, `src/lib/review-bundle.ts` — proportional structural review and positive contract grounding.
- `src/commands/review.ts`, `src/lib/test-impact.ts` — selected/base evidence and risk retained consistently.
- `src/commands/verify.ts` — existing worksheet and exact receipt path if compatibility needs adjustment.
- `tests/review-gate.test.ts`, `tests/review-bundle.test.ts`, `tests/test-impact.test.ts`,
  `tests/review-boundary.test.ts`, `tests/verify.test.ts`, `tests/hooks-command.test.ts`,
  `tests/work.test.ts` — policy, boundary and portable fixture evidence.
- `docs/features/adversarial-review-gate.md`, `docs/features/change-control-gate.md`,
  `docs/features/step-verification.md`, `docs/features/proof-benchmarks.md`, `docs/concepts/lib.md`
  — mapped intent, compatibility and evidence limits.
- `fixtures/benchmarks/` — small matched-delivery fixture and recorded observations, without a new runtime benchmark command.
- `package.json`, `package-lock.json`, `.codument-meta.json`, `CHANGELOG.md`, `README.md`,
  `docs/guides/releasing.md`, `docs/.approvals.json` — final local release preparation and approval evidence.

No new runtime source files are required. Tests and benchmark fixture files are evidence rather
than runtime source ownership; materialize genuine new source discoveries if routing changes.

### Effort & cheapest useful experiment

Two source slices, four ten-minute-capped agent attempts and final release checks. The harmless-note
hook failure already supplies the cheapest counterexample to the current policy; first prove its
lighter treatment together with protected counterexamples before broadening focused candidates.

### Resume checkpoint

Step 1 is committed. Step 2 implementation and CLI protection checks pass. The full suite's two
subprocess timeouts passed isolated rechecks without source changes; all remaining cases passed.
Independent staged review is pending before the second commit. Prepared 0.21.0 release metadata
remains outside the source slices and is reserved for Step 4.

### Grounding limitations

Tests, release metadata and benchmark fixtures are outside runtime source ownership and require
direct inspection. The existing owner docs cover the runtime policy, staged boundary and evidence
contracts. A missing Feature Map is expected because this plan adds no runtime source. Existing
session fixtures have a different locked endpoint; the small comparison fixture defines equal
milestone readiness inputs and cannot weaken those existing controls.

### Open questions

No product boundary is left open in this proposal. The recommended choice is the three bounded
routine exceptions above, unchanged stronger checks, and a matched output/administration trial
before local release. Independent plan review checked the grounded contracts and evidence
feasibility; no material objections were found.
