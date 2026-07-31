import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureDir,
  upsertManagedSection,
  buildManagedSection,
} from "../src/lib/scaffold.js";
import { MARKER_START, MARKER_END } from "../src/lib/markers.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ensureDir", () => {
  it("creates directory if it does not exist", () => {
    const dir = join(tmp, "a", "b", "c");
    assert.ok(!existsSync(dir));
    ensureDir(dir);
    assert.ok(existsSync(dir));
  });

  it("does nothing if directory already exists", () => {
    const dir = join(tmp, "existing");
    ensureDir(dir);
    // Should not throw
    ensureDir(dir);
    assert.ok(existsSync(dir));
  });
});

describe("upsertManagedSection", () => {
  it("creates new file with managed section", async () => {
    const filePath = join(tmp, "NEW.md");
    await upsertManagedSection(filePath, "managed content");

    const content = await readFile(filePath, "utf-8");
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes("managed content"));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.endsWith("\n"));
  });

  it("appends managed section to existing file without markers", async () => {
    const filePath = join(tmp, "EXISTING.md");
    await writeFile(filePath, "# My Project\n\nSome content.");

    await upsertManagedSection(filePath, "managed stuff");

    const content = await readFile(filePath, "utf-8");
    assert.ok(content.startsWith("# My Project\n\nSome content."));
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes("managed stuff"));
    assert.ok(content.includes(MARKER_END));
  });

  it("replaces existing managed section", async () => {
    const filePath = join(tmp, "REPLACE.md");
    const initial = `# Title\n\n${MARKER_START}\nold content\n${MARKER_END}\n\n# Footer`;
    await writeFile(filePath, initial);

    await upsertManagedSection(filePath, "new content");

    const content = await readFile(filePath, "utf-8");
    assert.ok(!content.includes("old content"));
    assert.ok(content.includes("new content"));
    assert.ok(content.includes("# Title"));
    assert.ok(content.includes("# Footer"));
  });

  it("preserves content before and after markers", async () => {
    const filePath = join(tmp, "PRESERVE.md");
    const before = "# Before\n\nIntro text.\n\n";
    const after = "\n\n# After\n\nOutro text.\n";
    const initial = `${before}${MARKER_START}\noriginal\n${MARKER_END}${after}`;
    await writeFile(filePath, initial);

    await upsertManagedSection(filePath, "replaced");

    const content = await readFile(filePath, "utf-8");
    assert.ok(content.startsWith(before));
    assert.ok(content.includes(`${MARKER_START}\nreplaced\n${MARKER_END}`));
    assert.ok(content.endsWith(after));
  });
});

describe("buildManagedSection", () => {
  it("returns delivery workflow section", () => {
    const section = buildManagedSection();
    assert.ok(section.includes("## Codument Delivery Workflow"));
    assert.ok(section.includes("Core loop"));
    assert.ok(section.includes("Intent routing"));
    assert.ok(section.includes("Do not wait for the user to name a skill"));
    assert.ok(section.includes("Charter gate (runs before the normal grill"));
    assert.ok(section.includes("run `establish-charter` first"));
    // the charter gate must be the FIRST routing rule, ahead of the assumption gate
    assert.ok(
      section.indexOf("Charter gate") <
        section.indexOf("Before editing source, name the one assumption"),
    );
    assert.ok(section.includes("use `grill-with-docs` first"));
    assert.ok(section.includes("use `plan-with-docs`"));
    assert.ok(section.includes("use `work-step`"));
    assert.ok(section.includes("gets reviewed before commit"));
    assert.ok(section.includes("offer `commit-work`"));
    assert.ok(section.includes("wait for the user to ask for it"));
    assert.ok(section.includes("Assumption gate (before any source edit)"));
    assert.ok(section.includes("never on ambiguity alone"));
    assert.ok(section.includes("Step gates"));
    assert.ok(section.includes("Outside an explicitly opted-in autopilot run, never move from one implementation step directly into the next"));
    // guard: the gate rule must stay mode-conditioned, never regress to the bare absolute
    assert.ok(!section.includes("Never move from one implementation step directly into the next without review and commit in between."));
    assert.ok(section.includes("It must not fix findings automatically"));
    assert.ok(section.includes("Outside autopilot, only the user can decide to fix, select, or defer review findings"));
    assert.ok(section.includes("compact context"));
    assert.ok(section.includes("native context-compaction command"));
    assert.ok(section.includes("Definition of Done"));
    assert.ok(section.includes("docs/.registry.json"));
    assert.ok(section.includes("Documentation Structure"));
    assert.ok(section.includes("docs/features/{name}.md"));
    assert.ok(section.includes("docs/concepts/{name}.md"));
  });

  it("includes opt-in autopilot routing", () => {
    const section = buildManagedSection();
    assert.ok(section.includes("Autopilot (opt-in per run)"));
    assert.ok(section.includes("off by default"));
    assert.ok(section.includes("codument, run the plan"));
    assert.ok(section.includes("Status: approved"));
    assert.ok(section.includes("stop autopilot"));
    // the binary does not run the agent; autopilot is instruction-only. A
    // signpost `codument run` command IS registered, so the guidance must not
    // claim the command doesn't exist — the literal falsehood this pin
    // previously enforced.
    assert.ok(section.includes("`codument run` is only a signpost"));
    assert.ok(!section.includes("There is no `codument run` command"));
  });

  it("commit guidance forbids an AI co-author trailer", () => {
    const section = buildManagedSection();
    assert.ok(section.includes("no AI `Co-Authored-By` trailer"));
    // the generated guidance must not embed an actual agent co-author trailer
    assert.ok(!/Co-Authored-By:\s/.test(section));
  });

  it("encodes the quality bar, the doc-altitude standard, and the ack branch", () => {
    const section = buildManagedSection();
    // quality bar: best-effort + adversarial zoom-out before "done"
    assert.ok(section.includes("Quality bar"));
    assert.ok(section.includes("zoom out and check it adversarially"));
    // doc altitude references the FIXED standard (audience layers), not a vibe
    assert.ok(section.includes("Documentation altitude"));
    assert.ok(section.includes("In plain terms"));
    assert.ok(section.includes("Design approach"));
    assert.ok(section.includes("Invariants & boundaries"));
    assert.ok(section.includes("doc-audience-layers"));
    // the one rule (survives a rename-everything refactor) and the test-pointer mandate
    assert.ok(/renames every symbol/.test(section));
    assert.ok(/link each to the test/.test(section));
    assert.ok(/symbol mirror/.test(section));
    // queryable-knowledge-base framing: link / estimate / scope
    assert.ok(section.includes("link features, estimate work, and understand scope"));
    // the two-way call lives in the contract: update at altitude OR ack
    assert.ok(section.includes("codument ack"));
    assert.ok(/pure-internal refactor/.test(section));
    // regression guard: the removed last_updated mandate must never re-enter the contract
    assert.ok(!/last_updated/.test(section));
  });

  it("encodes response altitude — answer first, evidence on request", () => {
    const section = buildManagedSection();
    assert.ok(section.includes("Response altitude"));
    // the rule itself: answer leads, reasoning does not
    assert.ok(section.includes("Lead with the answer"));
    assert.ok(/never the reasoning that produced it/.test(section));
    assert.ok(/offered, not delivered/.test(section));
    assert.ok(section.includes("One answer and one question per turn"));
    // the shape that prompted the rule is named, not merely implied
    assert.ok(/comparison table plus a numbered rationale plus a "before you answer" section/.test(section));
    // "to the point" is a distinct half — brevity alone does not satisfy it
    assert.ok(/two different failures/.test(section));
    assert.ok(/no restating the question back/.test(section));
    // the deletion test is what makes the rule checkable rather than a vibe
    assert.ok(section.includes("could be deleted without changing what the user now knows or does"));

    // it sits between the two discipline sections and the routing rules whose output it governs
    assert.ok(
      section.indexOf("### Implementation discipline") <
        section.indexOf("### Response altitude"),
    );
    assert.ok(
      section.indexOf("### Response altitude") <
        section.indexOf("### Intent routing"),
    );
  });

  it("response altitude cannot be read as permission to read less", () => {
    const section = buildManagedSection();
    // the grounding clause is load-bearing: brevity must never be bought by skipping the reading
    assert.ok(section.includes("narrated less, never performed less"));
    assert.ok(/short wrong answer costs more than a long right one/.test(section));
    // guard: the section must never collapse to a bare brevity order stripped of that clause
    const start = section.indexOf("### Response altitude");
    const end = section.indexOf("### Intent routing");
    const rule = section.slice(start, end);
    assert.ok(rule.includes("Grounding"), "brevity rule must keep its grounding clause");

    // measured-zero micro-optimizations stay banned: they cost the reader and save no tokens
    assert.ok(/Cut sentences, never words/.test(section));
    assert.ok(/Do not invent abbreviations/.test(section));
    assert.ok(/Identifiers, file paths, commands, and error strings stay verbatim/.test(section));

    // nothing is exempt — mandated formats compress inside their structure, they are not excused
    assert.ok(section.includes("Nothing is exempt"));
    assert.ok(/keep every required part/.test(section));
    assert.ok(/a line each, not a paragraph each/.test(section));
    // regression guard: an exemption list would re-license the padding this rule removes
    assert.ok(!/exempt from this rule/.test(rule));
  });
});

describe("commit-work skill", () => {
  it("forbids attributing the AI agent as co-author", () => {
    const skill = readFileSync("skills/commit-work/SKILL.md", "utf-8");
    assert.ok(/Never add a `Co-Authored-By` trailer/.test(skill));
    assert.ok(!/Co-Authored-By:\s/.test(skill));
  });
});
