import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeProseAltitude } from "../src/lib/prose-altitude.js";

const base = { feature: "auth", doc: "docs/features/auth.md", exportedSymbols: ["readRegistry", "State"] };
const run = (content: string, extra: Partial<typeof base> = {}) =>
  analyzeProseAltitude({ ...base, ...extra, content });
const ids = (content: string, extra: Partial<typeof base> = {}) => run(content, extra).map((f) => f.id);

describe("prose-altitude: symbol-mirror", () => {
  it("fires when a prose line opens with an exported identifier + a verb", () => {
    const f = run("readRegistry reads the registry file from disk.");
    assert.equal(f.length, 1);
    assert.equal(f[0].id, "symbol-mirror");
    assert.equal(f[0].line, 1);
  });

  it("fires through a leading list marker and backticks", () => {
    assert.deepEqual(ids("- `readRegistry` parses the registry."), ["symbol-mirror"]);
  });

  it("does NOT fire inside a code fence (that is code, not prose)", () => {
    const content = ["```ts", "readRegistry reads the registry.", "```"].join("\n");
    assert.deepEqual(ids(content), []);
  });

  it("does NOT fire inside a ~~~ (tilde) code fence either", () => {
    const content = ["~~~ts", "readRegistry reads the registry.", "~~~"].join("\n");
    assert.deepEqual(ids(content), []);
  });

  it("does NOT fire when the following word is a copula/preposition, not a verb", () => {
    assert.deepEqual(ids("State is the verdict the gate computes."), []);
    assert.deepEqual(ids("readRegistry and the writer share a contract."), []);
  });

  it("does NOT fire when the opening word is not an exported symbol", () => {
    assert.deepEqual(ids("Something reads the registry lazily."), []);
  });
});

describe("prose-altitude: line-anchor", () => {
  it("fires on a path.ext:NNN anchor and a README:NNN anchor", () => {
    assert.deepEqual(ids("See fingerprint.ts:313 for the split."), ["line-anchor"]);
    assert.deepEqual(ids("Honesty rests on the ack-rate (README:232)."), ["line-anchor"]);
    assert.deepEqual(ids("Resolved in src/lib/foo.ts:42 today."), ["line-anchor"]);
  });

  it("does NOT fire on versions, times, ratios, or a plain filename", () => {
    assert.deepEqual(ids("SARIF 2.1.0 ships at 10:30 with a 3:1 margin."), []);
    assert.deepEqual(ids("The test lives in foo.test.ts (no line number)."), []);
  });

  it("does NOT fire on host:port URLs (a TLD is not a source extension)", () => {
    assert.deepEqual(ids("The dev server runs at example.com:8080 in staging."), []);
    assert.deepEqual(ids("Point the client at api.service.io:443 for TLS."), []);
  });

  it("still fires on a ~~~-adjacent real anchor in prose", () => {
    assert.deepEqual(ids("The split lives in ts-adapter.ts:88 today."), ["line-anchor"]);
  });

  it("does NOT fire inside a code fence", () => {
    assert.deepEqual(ids(["```", "fingerprint.ts:313", "```"].join("\n")), []);
  });
});

describe("prose-altitude: path-enumeration", () => {
  it("fires when a prose section restates the file list (> 4 source paths)", () => {
    const content = [
      "## Design approach",
      "It wires src/a.ts, src/b.ts, src/c.ts, src/d.ts, and src/e.ts together.",
    ].join("\n");
    const f = run(content);
    assert.deepEqual(
      f.map((x) => x.id),
      ["path-enumeration"],
    );
    assert.match(f[0].message, /restates the file list/);
  });

  it("does NOT count paths inside a code fence or a markdown table (not prose)", () => {
    const fenced = [
      "## Design approach",
      "```",
      "src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts",
      "```",
    ].join("\n");
    assert.deepEqual(ids(fenced), []);
    const table = [
      "## Fixes",
      "| file | change |",
      "| src/a.ts | x |",
      "| src/b.ts | y |",
      "| src/c.ts | z |",
      "| src/d.ts | w |",
      "| src/e.ts | v |",
    ].join("\n");
    assert.deepEqual(ids(table), []);
  });

  it("exempts the Key files section from path counting, but flags an entry with no role", () => {
    const content = [
      "## Key files",
      "- `src/a.ts` — the entry point that wires the command surface.",
      "- `src/b.ts` — the coarse hashing fallback.",
      "- `src/c.ts` — the registry reader.",
      "- `src/d.ts` — the analyzer.",
      "- `src/e.ts` — the reporter.",
      "- `src/f.ts`",
    ].join("\n");
    const f = run(content);
    // Five role-annotated entries do not fire despite > 4 paths; the bare one does.
    assert.deepEqual(
      f.map((x) => x.id),
      ["path-enumeration"],
    );
    assert.match(f[0].message, /no role/);
    assert.equal(f[0].line, 7);
  });

  it("does NOT flag a Key files prose sentence that mentions a path with context", () => {
    // A descriptive sentence in Key files (not the canonical `path — role` entry form)
    // carries its role in prose, so naming a path in passing is not a violation.
    const content = [
      "## Key files",
      "- The catch-rate benchmark lives in [[proof]] (`src/lib/benchmark.ts`); this concept has no sources of its own.",
    ].join("\n");
    assert.deepEqual(run(content), []);
  });

  it("honors a custom maxPathsPerSection", () => {
    const content = ["## Design", "It uses src/a.ts and src/b.ts."].join("\n");
    assert.deepEqual(
      analyzeProseAltitude({ ...base, content }, { maxPathsPerSection: 1 }).map((x) => x.id),
      ["path-enumeration"],
    );
  });
});

describe("prose-altitude: fenced-mirror", () => {
  // The field shape: docs/concepts/types.md carried a union verbatim in a fence, and
  // the change-control gate demanded a hand-edit every time the union gained a member.
  // The three prose smells all skip fences by design, so nothing judged the purest
  // mirror in the corpus.
  it("fires on a fenced declaration of a symbol the entry owns", () => {
    const content = [
      "## Design approach",
      "```ts",
      "export type AppLanguage = 'en' | 'es' | 'fi';",
      "```",
    ].join("\n");
    const f = run(content, { exportedSymbols: ["AppLanguage"] });
    assert.deepEqual(
      f.map((x) => x.id),
      ["fenced-mirror"],
    );
    assert.equal(f[0].line, 3, "points at the declaration, not the fence marker");
    assert.equal(f[0].evidence, "AppLanguage");
  });

  it("fires on a shape declaration with no export marker (Python/Go mark visibility by convention)", () => {
    assert.deepEqual(ids(["```py", "class State:", "```"].join("\n")), ["fenced-mirror"]);
    assert.deepEqual(ids(["```go", "type State struct {", "```"].join("\n")), ["fenced-mirror"]);
  });

  it("does NOT fire on a bare value declaration — that is how every usage example opens", () => {
    assert.deepEqual(ids(["```ts", "const State = readRegistry();", "```"].join("\n")), []);
    assert.deepEqual(ids(["```ts", "let readRegistry = mock();", "```"].join("\n")), []);
  });

  it("fires on a value declaration that carries an explicit export marker", () => {
    assert.deepEqual(ids(["```ts", "export const readRegistry = () => 1;", "```"].join("\n")), [
      "fenced-mirror",
    ]);
  });

  it("does NOT fire when the declared name is not a symbol this entry owns", () => {
    assert.deepEqual(ids(["```ts", "export type Unrelated = 'a' | 'b';", "```"].join("\n")), []);
  });

  it("does NOT fire on an illustrative fence — CLI output, a command, or a config sample", () => {
    assert.deepEqual(
      ids(["```text", "codument review: BLOCKED — 2 stale doc(s)", "```"].join("\n")),
      [],
    );
    assert.deepEqual(ids(["```bash", "codument ack src/a.ts --reason \"...\"", "```"].join("\n")), []);
    assert.deepEqual(ids(["```json", '{ "State": { "doc": "docs/x.md" } }', "```"].join("\n")), []);
  });

  it("does NOT fire on a shell export, which is not a declaration keyword", () => {
    assert.deepEqual(ids(["```bash", "export State=1", "```"].join("\n")), []);
  });

  it("does NOT fire on a fence that only CALLS the symbol", () => {
    assert.deepEqual(ids(["```ts", "const r = readRegistry(path);", "```"].join("\n")), []);
  });

  it("reports one finding per fence, anchored on the first declaration in it", () => {
    const content = [
      "```ts",
      "export type State = 'a' | 'b';",
      "export const readRegistry = () => 1;",
      "```",
    ].join("\n");
    const f = run(content);
    assert.deepEqual(
      f.map((x) => x.id),
      ["fenced-mirror"],
    );
    // Anchored on the FIRST declaration: the reader deletes the fence, so the finding
    // should point at where it starts rather than wherever it happens to end.
    assert.equal(f[0].line, 2);
    assert.equal(f[0].evidence, "State");
  });

  it("fires in a ~~~ fence, and in a fence left unclosed at end of file", () => {
    assert.deepEqual(ids(["~~~ts", "export type State = 'a';", "~~~"].join("\n")), [
      "fenced-mirror",
    ]);
    assert.deepEqual(ids(["```ts", "export type State = 'a';"].join("\n")), ["fenced-mirror"]);
  });

  it("stays silent when the entry owns no symbols at all", () => {
    assert.deepEqual(
      ids(["```ts", "export type State = 'a';", "```"].join("\n"), { exportedSymbols: [] }),
      [],
    );
  });
});

describe("prose-altitude: a clean doc reads clean", () => {
  it("produces no findings for intent-altitude prose", () => {
    const content = [
      "## In plain terms",
      "The gate keeps a moved documented symbol and its owning doc in sync.",
      "## Invariants & boundaries",
      "- A signature change is never ackable; the owning doc must be updated.",
      "## Key files",
      "- `src/lib/gate.ts` — the verdict engine that resolves staleness per symbol.",
    ].join("\n");
    assert.deepEqual(run(content), []);
  });
});

describe("prose-altitude: doctor wiring (Notes channel, never a --strict fail)", () => {
  let tmp: string;
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-prose-doctor-"));
    await mkdir(join(tmp, "src", "auth"), { recursive: true });
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await writeFile(
      join(tmp, "docs", ".registry.json"),
      JSON.stringify(
        {
          features: {
            auth: {
              doc: "docs/features/auth.md",
              type: "feature",
              primary_sources: ["src/auth/login.ts"],
              related_sources: [],
              docs: [],
              depends_on: [],
              depends_on_confirmed: true, // reviewed leaf: no empty-depends-on warn confounds the test
              risk: [],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const login = () => 1;\n");
    // A doc with a line-anchor smell in prose — enough content to clear thin-doc.
    await writeFile(
      join(tmp, "docs", "features", "auth.md"),
      [
        "# auth",
        "## In plain terms",
        "The auth feature signs a user in and keeps the session honest across requests.",
        "## Design approach",
        "See login.ts:42 for the exact hand-off (this is a deliberate line-anchor smell).",
        "```ts",
        "export const login = () => 1;",
        "```",
        "## Key files",
        "- `src/auth/login.ts` — the sign-in entry point that issues the session.",
      ].join("\n"),
    );
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const doctorJson = (args: string[] = []) => {
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync("node", [CLI, "doctor", "--json", ...args], {
        cwd: tmp,
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
    }
    return { status, json: JSON.parse(stdout) };
  };

  it("surfaces the smell as an info NOTE, and --strict still exits 0 (info never fails strict)", () => {
    const { status, json } = doctorJson(["--strict"]);
    assert.equal(status, 0, "a prose-altitude info note does not fail --strict");
    const anchor = json.lint.notes.find(
      (n: { id: string }) => n.id === "line-anchor",
    );
    assert.ok(anchor, "the line-anchor smell rides the Notes channel");
    assert.equal(anchor.severity, "info");
    const mirror = json.lint.notes.find((n: { id: string }) => n.id === "fenced-mirror");
    assert.ok(mirror, "a fence reproducing an owned declaration rides the same channel");
    assert.equal(mirror.severity, "info");
    assert.equal(json.lint.count, 0, "info notes are excluded from the actionable count");
    assert.ok(
      !("line-anchor" in json.lint.byId) && !("fenced-mirror" in json.lint.byId),
      "byId stays warn-only, so the existing contract is untouched",
    );
  });

  it("a doc at intent altitude produces no prose-altitude note", async () => {
    await writeFile(
      join(tmp, "docs", "features", "auth.md"),
      [
        "# auth",
        "## In plain terms",
        "The auth feature signs a user in and keeps the session honest across requests.",
        "## Key files",
        "- `src/auth/login.ts` — the sign-in entry point that issues the session.",
      ].join("\n"),
    );
    const { json } = doctorJson();
    const proseIds = new Set(["symbol-mirror", "line-anchor", "path-enumeration"]);
    assert.ok(
      !json.lint.notes.some((n: { id: string }) => proseIds.has(n.id)),
      "clean prose yields no altitude note",
    );
  });

  // The calibration, end-to-end through the real command: a doc that does what
  // the standard demands (every invariant pinned to its enforcing test) scores
  // clean, while a genuine file-list section still fires at the same threshold.
  const writeDoc = async (body: string[]) =>
    await writeFile(
      join(tmp, "docs", "features", "auth.md"),
      ["# auth", "## In plain terms", "The auth feature signs a user in.", ...body].join("\n"),
    );

  const pathEnumerationNotes = () =>
    doctorJson().json.lint.notes.filter((n: { id: string }) => n.id === "path-enumeration");

  it("a doc pinning five invariants to five tests is clean through doctor", async () => {
    await writeDoc([
      "## Invariants & boundaries",
      "- A session cannot outlive its token. *(test: src/auth/session.spec.ts)*",
      "- A replayed nonce is refused. *(test: src/auth/nonce.spec.ts)*",
      "- A logout revokes every device. *(test: src/auth/logout.spec.ts)*",
      "- A rotated key keeps live sessions. *(test: src/auth/rotate.spec.ts)*",
      "- A locked account cannot sign in. *(test: src/auth/__tests__/lock.test.ts)*",
      "## Key files",
      "- `src/auth/login.ts` — the sign-in entry point that issues the session.",
    ]);
    assert.deepEqual(pathEnumerationNotes(), [], "compliance must not be penalized");
  });

  it("a genuine file-list section still fires at the same threshold", async () => {
    await writeDoc([
      "## Design approach",
      "It wires src/auth/a.ts, src/auth/b.ts, src/auth/c.ts, src/auth/d.ts and src/auth/e.ts.",
      "## Key files",
      "- `src/auth/login.ts` — the sign-in entry point that issues the session.",
    ]);
    const notes = pathEnumerationNotes();
    assert.equal(notes.length, 1, "genuine enumeration still fires");
    assert.match(notes[0].message, /restates the file list \(5 source paths/);
  });

  it("counts one file cited many times once", async () => {
    await writeDoc([
      "## Design approach",
      "src/auth/login.ts validates, then src/auth/login.ts issues, then src/auth/login.ts logs.",
      "It also touches src/auth/a.ts, src/auth/b.ts, src/auth/c.ts and src/auth/d.ts.",
      "## Key files",
      "- `src/auth/login.ts` — the sign-in entry point that issues the session.",
    ]);
    // 7 mentions, 5 distinct — over the threshold on distinct files, and the
    // message reports the deduped count so the number matches what fired.
    const notes = pathEnumerationNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /\(5 source paths/);
  });
});

describe("prose-altitude: path-enumeration counts distinct non-test paths", () => {
  // The standard REQUIRES each invariant to link its enforcing test. Counting
  // those links as an enumeration smell makes the metric climb as a project
  // complies — backwards, and it trains everyone to strip test links to quiet
  // doctor. The predicate mirrors the exclusion spec's test globs.
  const isTestPath = (p: string) =>
    /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[A-Za-z]+$/.test(p);
  const withTests = (content: string) =>
    analyzeProseAltitude({ ...base, content }, { isTestPath }).map((f) => f.id);

  // The field shape: five mentions of three test files. DEDUP alone clears this
  // one (three distinct paths is under the threshold) — the per-mention count was
  // what made three invariants pinned by one spec file read as three files.
  it("the field shape — five test-link mentions across three files — is clean", () => {
    const content = [
      "## Invariants & boundaries",
      "- A registry read fails loud. *(test: src/services/applicant.service.spec.ts)*",
      "- A partial write is refused. *(test: src/services/applicant.service.spec.ts)*",
      "- An expired draft is purged. *(test: src/services/applicant.service.spec.ts)*",
      "- Submission is idempotent. *(test: src/services/__tests__/submit.test.ts)*",
      "- A rejected form keeps its answers. *(test: src/forms/form.spec.ts)*",
    ].join("\n");
    assert.deepEqual(withTests(content), []);
    assert.deepEqual(ids(content), [], "dedup alone clears the three-file case");
  });

  // The EXEMPTION's own job, isolated: a doc whose invariants are each pinned by
  // a DIFFERENT test — five distinct test files, over the threshold. This is the
  // doc the standard asks for, and without the exemption it is penalized for it.
  it("a doc pinning five invariants to five different tests is clean", () => {
    const content = [
      "## Invariants & boundaries",
      "- One. *(test: src/a.spec.ts)*",
      "- Two. *(test: src/b.spec.ts)*",
      "- Three. *(test: src/c.spec.ts)*",
      "- Four. *(test: src/d.spec.ts)*",
      "- Five. *(test: src/e.spec.ts)*",
    ].join("\n");
    assert.deepEqual(withTests(content), []);
    // Precondition: WITHOUT the exemption this exact doc fires — the backwards
    // metric, penalizing the doc for doing what the standard requires.
    assert.deepEqual(ids(content), ["path-enumeration"]);
  });

  it("distinguishes a source file from its own spec (no dedup collision)", () => {
    // Both truncated to `src/x.service` before the path regex captured whole
    // multi-dot names, so two distinct files counted as one.
    const content = [
      "## Design approach",
      "src/x.service.ts, src/y.service.ts, src/z.service.ts, src/w.service.ts, src/v.service.ts",
    ].join("\n");
    assert.deepEqual(withTests(content), ["path-enumeration"], "five distinct services");
    // Three source/spec pairs: six mentions (over the old per-mention threshold)
    // but three distinct non-test files. Under the pre-fix truncation each pair
    // collapsed to one string, so this could not have discriminated with two.
    const withSpecs = [
      "## Design approach",
      "src/x.service.ts, src/y.service.ts and src/z.service.ts.",
      "Tested by src/x.service.spec.ts, src/y.service.spec.ts and src/z.service.spec.ts.",
    ].join("\n");
    assert.deepEqual(withTests(withSpecs), [], "three sources + their three specs");
    // And the sources alone, one more added, DO fire — so the clean result above
    // is the specs being exempt, not the section being too small to trip.
    const sourcesOnly = [
      "## Design approach",
      "src/x.service.ts, src/y.service.ts, src/z.service.ts, src/w.service.ts and src/v.service.ts.",
    ].join("\n");
    assert.deepEqual(withTests(sourcesOnly), ["path-enumeration"]);
  });

  it("still fires on five distinct non-test source paths", () => {
    const content = [
      "## Design approach",
      "It wires src/a.ts, src/b.ts, src/c.ts, src/d.ts, and src/e.ts together.",
    ].join("\n");
    assert.deepEqual(withTests(content), ["path-enumeration"]);
  });

  it("does not fire on many mentions of only two non-test files", () => {
    const content = [
      "## Design approach",
      "src/a.ts calls src/b.ts.",
      "Then src/a.ts retries, and src/b.ts logs.",
      "Finally src/a.ts commits while src/b.ts flushes.",
    ].join("\n");
    // Six mentions, two files: a discussion, not a file list.
    assert.deepEqual(withTests(content), []);
  });

  it("counts only the non-test residue in a mixed section", () => {
    const content = [
      "## Invariants & boundaries",
      "- One. *(test: src/a.spec.ts)* *(test: src/b.spec.ts)* *(test: src/c.spec.ts)*",
      "- It reads src/one.ts, src/two.ts, src/three.ts and src/four.ts.",
    ].join("\n");
    // Four non-test paths is at the threshold, not over it — the three test
    // citations must not push it over.
    assert.deepEqual(withTests(content), []);
    const overThreshold = [content, "- Also src/five.ts. *(test: src/d.spec.ts)*"].join("\n");
    assert.deepEqual(withTests(overThreshold), ["path-enumeration"]);
  });

  it("reports the deduped count in its message, not the mention count", () => {
    const content = [
      "## Design approach",
      "src/a.ts src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts",
    ].join("\n");
    const f = analyzeProseAltitude({ ...base, content }, { isTestPath });
    assert.equal(f.length, 1);
    assert.match(f[0].message, /\(6 source paths in prose\)/, "7 mentions, 6 distinct files");
  });

  it("dedupes even without a test predicate (the counting fix stands alone)", () => {
    const content = [
      "## Design approach",
      "src/a.ts and src/a.ts and src/a.ts and src/a.ts and src/a.ts and src/a.ts",
    ].join("\n");
    assert.deepEqual(ids(content), []);
  });

  it("keeps a test path visible to line-anchor when written with :NNN", () => {
    // Exempt from the COUNT, never from the rot-prone line anchor.
    assert.deepEqual(withTests("## Invariants\n- See src/a.spec.ts:42."), ["line-anchor"]);
  });
});
