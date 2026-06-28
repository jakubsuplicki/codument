import {
  mkdirSync,
  existsSync,
  cpSync,
  readFileSync,
  statSync,
  lstatSync,
} from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER_START, MARKER_END } from "./markers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function packageRoot(): string {
  const root = join(__dirname, "..");
  if (!existsSync(join(root, "package.json"))) {
    throw new Error(
      `codument: expected package.json at ${root} — bundle output structure may have changed`,
    );
  }
  return root;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * The first ancestor of `absPath` that exists but cannot be written beneath
 * (i.e. is not a usable directory), else null. A genuine symlink-to-directory is
 * fine and reported as null, so it is written through exactly as before. A plain
 * file, a symlink-to-file, or a broken/dangling symlink sitting where a directory
 * must be is returned as a blocker, since writing beneath it would throw
 * ENOTDIR/ENOENT and abort the caller. Missing ancestors are not blockers — they
 * get created. Lets a writer skip blockers with a warning and keep going.
 */
export function nonDirectoryAncestor(absPath: string): string | null {
  let cur = dirname(absPath);
  let prev = "";
  while (cur !== prev) {
    let link;
    try {
      link = lstatSync(cur); // inspect the entry itself, not its symlink target
    } catch {
      // does not exist (ENOENT) → an ancestor we'll create; keep walking up
      prev = cur;
      cur = dirname(cur);
      continue;
    }
    if (link.isDirectory()) return null; // real directory — writable
    if (link.isSymbolicLink()) {
      // a symlink is only usable if it resolves to a directory (statSync follows)
      try {
        return statSync(cur).isDirectory() ? null : cur;
      } catch {
        return cur; // broken/dangling symlink — cannot write beneath it
      }
    }
    return cur; // a plain file (e.g. a pointer-file) where a directory is required
  }
  return null;
}

export function templatePath(name: string): string {
  return join(packageRoot(), "templates", name);
}

export function readTemplate(name: string): string {
  return readFileSync(templatePath(name), "utf-8");
}

export function copyTemplate(name: string, dest: string): void {
  ensureDir(dirname(dest));
  cpSync(templatePath(name), dest);
}

export function skillsDir(): string {
  return join(packageRoot(), "skills");
}

export function agentsDir(): string {
  return join(packageRoot(), "agents");
}

export function rulesDir(): string {
  return join(packageRoot(), "rules");
}

export function buildManagedSection(): string {
  return `## Codument Delivery Workflow

### Core loop
Use Codument as the durable control plane for agent-led engineering work:

1. Grill the request against existing docs, code, ADRs, and project language.
2. Plan the feature in docs before changing source code.
3. Wait for explicit user approval before implementation.
4. Implement one planned step at a time.
5. Build the strongest practical feedback loop, preferring red-green-refactor when it fits.
6. Update the mapped docs + \`docs/.registry.json\` as part of the same step: materialize each new source file with \`codument map materialize\`; when a symbol moved, update its doc at intent altitude if a contract changed, or \`codument ack\` a pure-internal refactor (never a junk mirror edit to clear the gate).
7. Review the diff against the approved plan, tests, docs, and architecture.
8. Commit focused work with a conventional commit, authored as the user with no AI \`Co-Authored-By\` trailer.
9. Move to the next unchecked step.

### Quality bar
Aim for the best-effort, durable solution, not the first plausible one. Before calling a plan or a step done, zoom out and check it adversarially — where is this half-baked, what did I assume, what would break it. Resolve issues yourself; pull the user in only for a genuinely load-bearing, unconfirmed call (the assumption gate below), not for work that should just happen.

### Intent routing
Use these routing rules at the start of each user request. Do not wait for the user to name a skill when their intent is clear.

- Charter gate (runs before the normal grill, once per project): if no \`docs/charter.md\` exists AND the user's message is real-work intent — building or changing something (a feature, the app, "let's make X"), not a pure question or read-only request — run \`establish-charter\` first. It sets the project's seriousness (demo vs. serious) and walks the core tech/architecture choices recommendation-first, then writes \`docs/charter.md\` and proceeds with the original request. A pure question or read-only request on an uncharted project does not trip it; a project that already has a charter skips it. Do not ask the user's experience level.
- Before editing source, name the one assumption the change depends on and run the assumption gate below. If a load-bearing assumption is unconfirmed, or the request is a rough idea / concept / "before we code" discussion, use \`grill-with-docs\` first — load the smallest relevant docs and source, surface the assumption with your recommended reading, ask one sharp question at a time, and do not edit source. If every load-bearing assumption is confirmed or cheap to reverse, go straight to implementation.
- Settled scope with enough answers for implementation design: use \`plan-with-docs\`. Write or update the durable feature/concept plan, mark it awaiting approval, show its delivery-plan checklist inline in the chat (the steps themselves, never just a doc link), and stop for explicit user approval.
- Approved plan or user says to continue an approved plan: use \`work-step\`. Implement only the first unchecked step.
- Any source edit, in or out of the delivery-plan loop, gets reviewed before commit — review is owed to the edit, not to a plan step. Scale it: a trivial edit (rename, comment, typo, pure-config) gets a one-pass self-review of the diff; a behavior change — public interface, data shape, deletion, or anything that tripped the assumption gate — gets the full \`review-work\` / \`code-reviewer\` pass. An ad-hoc bug fix is a behavior change: review it even though no plan step produced it.
- Clean review, or review findings explicitly fixed/deferred by the user: offer \`commit-work\` as the next gated action and wait for the user to ask for it.
- Domain skills are advisory, not loop gates: when a step's work clearly fits a domain, consult the matching skill for craft depth. Backend/API/DB/auth -> \`senior-backend\`; system or architecture decisions -> \`senior-architect\`; UI components, state, or performance -> \`senior-frontend\`; visual or aesthetic polish -> \`frontend-design\`; animation, gesture, or motion -> \`motion-craft\`; reviewing a diff -> \`code-reviewer\`. They inform the implementation and review; they never replace \`work-step\` or \`review-work\`.

### Assumption gate (before any source edit)
Default is to proceed. Stop to confirm only when a choice is BOTH load-bearing AND unconfirmed — never on ambiguity alone.

Load-bearing = wrong makes the work wrong, wasted, or hard to undo: it changes a public interface, data shape, migration, a deletion, security/auth behavior, the chosen approach, or behavior other callers depend on.

It is unconfirmed (and load-bearing) when one of these holds and you cannot settle it from the request, docs, or code:
- Two readings: the request admits two materially different readings and you had to pick one.
- Inferred "correct": you are inferring intended behavior the user never stated — including which behavior is the right one for a bug fix.
- Unverified property: you are relying on an unconfirmed claim about the code or domain ("X is always non-null / sorted / unique / present").

Route:
1. Confirmed, or trivial: just do it. No preamble.
2. A guess but cheap to reverse (wrong = a quick local follow-up edit): declare the assumption inline in one line and proceed. Do not wait.
3. Load-bearing AND unconfirmed: do not edit. State your recommended reading and the one sharpest question in a single line, then wait (\`grill-with-docs\` if it needs docs/source to resolve).

When unsure between 2 and 3, the test is reversibility, not difficulty: reversible-with-a-follow-up is tier 2 (declare), not tier 3 (ask). One line, recommendation-first — never a questionnaire.

### Step gates
At the end of each implementation step, stop and offer review options. Do not ask to start the next plan step yet.

Required sequence for every delivery-plan step:

1. \`work-step\` implements and verifies one step, then offers \`review-work\`, correction, or pause.
2. \`review-work\` reviews that step, then waits for the user to approve all fixes, select fixes, defer findings with a reason, or pause. It must not fix findings automatically.
3. \`commit-work\` commits that reviewed step, then offers the next \`work-step\`, plan review, compact context, or pause.

When the user chooses compact context after a commit, use the active agent's native context-compaction command if one is available. If no native command is available, provide a concise restart note grounded in \`AGENTS.md\`, the active plan doc, \`docs/.registry.json\`, and \`git status\`, then pause.

Outside an explicitly opted-in autopilot run, never move from one implementation step directly into the next without review and commit in between.
Outside autopilot, only the user can decide to fix, select, or defer review findings; in an autopilot run the agent may auto-apply only safe, obvious fixes and must pause for any judgment-call finding.

### Autopilot (opt-in per run)
Autopilot is off by default and applies to one run only; never assume it from a prior turn.

- Trigger: only when the user explicitly says "codument, run the plan" (also "run the plan", "codument this plan", "autopilot", or a best-effort \`/work-step --auto\` hint). The \`--auto\` flag is a convenience hint your host may ignore; the phrase is the reliable trigger.
- Precondition: never start autopilot before the plan is approved. Confirm the active plan shows \`Status: approved\` (not draft or awaiting approval). If you cannot confirm approval, do not start; say so and ask the user to approve the plan.
- While active, for each remaining delivery-plan step run \`work-step\` -> \`review-work\` -> \`commit-work\` without stopping for routine confirmations. Each gate still runs; you simply do not wait for the user to say continue. Commit per step with a focused conventional commit, attributed to the user only.
- Step-sync gate: before \`commit-work\` checks a step off, \`codument review --strict\` must pass. It exits nonzero while the step left a new source unmapped or a mapped doc stale — materialize the file(s) (\`codument map materialize\`) and update the stale doc(s), then re-run until clean. A persistently red gate is a hard-pause condition; never check off or commit a step while it is red.
- During \`review-work\` in autopilot, auto-apply only safe, obvious fixes, then proceed to \`commit-work\`. Always pause for any finding that needs a judgment call or that touches public interfaces, security, data loss or deletions, or dependency changes.
- Hard pause conditions (stop the run, report a compact summary, wait for the user): a judgment-call review finding, a verification failure, or any change that falls outside the approved plan.
- Interrupt: if the user says "pause" or "stop autopilot", immediately return to the manual one-step-at-a-time gated loop.
- Show progress at every step boundary: before starting each step, post a short checklist inline in the chat — the step just completed, the step now starting, and what remains. Autopilot suppresses the approval and option prompts and the waiting between steps, not the progress reporting; never advance from one step to the next silently.
- On any pause or on plan completion, report a compact summary of steps done, commits made, and why it stopped.

The Codument CLI does not run your coding agent. There is no \`codument run\` command; autopilot lives entirely in these instructions, which your agent follows.

### Definition of Done
A task is NOT complete until:
1. Code works and tests pass
2. The approved plan step is complete and no extra scope was added
3. \`docs/.registry.json\` is checked for affected source files
4. New source files are registered in \`docs/.registry.json\`
5. Corresponding feature docs are created or updated at intent altitude (contract/why, never a symbol mirror); a contract-neutral symbol move is acknowledged (\`codument ack\`), not papered over with mirror prose
6. Dependent features are flagged if an interface changed
7. Review findings are resolved or explicitly deferred
8. \`codument review --strict\` passes for the step — no new source left unmapped, no mapped doc left stale

### Planning and approval
Do not move from a rough idea into source edits automatically. First use the docs-backed grilling and planning workflow to resolve scope, non-goals, acceptance criteria, verification strategy, and implementation steps. Begin implementation only after the user approves the plan. Surface the plan's checklist inline in the chat at the approval gate, so the user approves the steps they can see rather than a link they must open.

### Documentation Registry
The file \`docs/.registry.json\` maps source files to their documentation.
Always check it before and after modifying source files.

### Documentation altitude
Docs follow a fixed standard, not a vibe. Each doc is layered — \`## In plain terms\` -> \`## How it works\` -> \`## Decisions\` -> \`## Key files\` + a machine block — per the \`doc-audience-layers\` concept, the \`update-docs\` skill, and \`templates/feature.md\`/\`templates/concept.md\`. They are the queryable knowledge base the agent reads to link features, estimate work, and understand scope, so every layer earns its place. Write the contract, the design at guide level, and the durable why; do NOT write symbol mirrors ("readRegistry reads the registry"), exhaustive export dumps, revision history, glossaries, or vague filler — that is the overload the standard exists to prevent, as bad as staleness. When a symbol moves, make the two-way call: a documented contract changed -> update the relevant layer at intent altitude; a pure-internal refactor changed no contract -> \`codument ack <path>::<symbol> --reason "<what stayed constant>"\`, never a mirror edit to clear the gate. Default to updating the doc; ack only when you can name the preserved contract in one clause.

### Documentation Structure
- Feature docs: \`docs/features/{name}.md\`
- Concept docs: \`docs/concepts/{name}.md\`
- ADRs: \`docs/architecture/decisions/{NNN}-{title}.md\`
- All filenames: lowercase kebab-case`;
}

export async function upsertManagedSection(
  filePath: string,
  content: string,
): Promise<void> {
  const managed = `${MARKER_START}\n${content}\n${MARKER_END}`;

  if (!existsSync(filePath)) {
    await writeFile(filePath, managed + "\n");
    return;
  }

  const existing = await readFile(filePath, "utf-8");
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const updated =
      existing.slice(0, startIdx) +
      managed +
      existing.slice(endIdx + MARKER_END.length);
    await writeFile(filePath, updated);
  } else {
    await writeFile(filePath, existing.trimEnd() + "\n\n" + managed + "\n");
  }
}
