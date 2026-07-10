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
    assert.equal(json.lint.count, 0, "info notes are excluded from the actionable count");
    assert.ok(
      !("line-anchor" in json.lint.byId),
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
});
