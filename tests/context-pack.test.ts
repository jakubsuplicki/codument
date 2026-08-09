import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyBudget,
  buildContextPack,
  estimateTokens,
  gatherContextPack,
  ownersOfFile,
  ownershipOfFile,
  selectedFromPlanRows,
  type ContextPackInput,
} from "../src/lib/context-pack.js";
import { normalizeRegistry, type Registry } from "../src/lib/registry.js";
import { parseFeatureMap } from "../src/lib/feature-map.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

interface EntryShape {
  doc?: string;
  type?: "feature" | "concept";
  primary_sources?: string[];
  related_sources?: string[];
  depends_on?: string[];
  risk?: string[];
}

function registryOf(entries: Record<string, EntryShape>): Registry {
  const features: Record<string, object> = {};
  for (const [slug, e] of Object.entries(entries)) {
    features[slug] = {
      doc: e.doc ?? `docs/features/${slug}.md`,
      type: e.type ?? "feature",
      primary_sources: e.primary_sources ?? [],
      related_sources: e.related_sources ?? [],
      docs: [],
      depends_on: e.depends_on ?? [],
      risk: e.risk ?? [],
      status: "current",
    };
  }
  return normalizeRegistry({ features });
}

function doc(inPlainTerms: string, invariants = ""): string {
  return [
    "# Title",
    "",
    "## In plain terms",
    "",
    inPlainTerms,
    "",
    "## Invariants & boundaries",
    "",
    invariants,
    "",
    "## Key files",
    "",
    "- `src/x.ts`",
    "",
  ].join("\n");
}

describe("buildContextPack — the pure projection", () => {
  const registry = registryOf({
    gate: {
      primary_sources: ["src/gate.ts", "src/verdict.ts"],
      related_sources: ["src/util.ts"],
      depends_on: ["parser", "store"],
      risk: ["data-loss"],
    },
    parser: { primary_sources: ["src/parser.ts"], depends_on: ["store"] },
    store: { primary_sources: ["src/store.ts"] },
  });
  const docContents = new Map<string, string>([
    [
      "docs/features/gate.md",
      doc(
        "The gate decides whether a change is safe. It reads the registry.",
        "- Never green outside a repo. *(test: `gate.test.ts` fail-closed)*",
      ),
    ],
    ["docs/features/parser.md", doc("Parses source into anchors. Deterministic.", "- Cosmetic churn never moves an anchor.")],
    ["docs/features/store.md", doc("Reads and writes the registry file.")],
  ]);

  const input: ContextPackInput = {
    selector: { kind: "feature", value: "gate" },
    selected: ["gate"],
    registry,
    unknownFeatures: [],
    unmappedFile: null,
    planErrors: [],
    docContents,
  };

  it("puts the selected feature first with full orientation, invariants, test pointers, and sources", () => {
    const pack = buildContextPack(input);
    const gate = pack.entries[0];
    assert.equal(gate.feature, "gate");
    assert.equal(gate.relation, "selected");
    assert.match(gate.summary, /The gate decides whether a change is safe\./);
    assert.match(gate.invariants, /Never green outside a repo/);
    assert.deepEqual(gate.testPointers, ["gate.test.ts"]);
    assert.deepEqual(gate.primarySources, ["src/gate.ts", "src/verdict.ts"]);
    assert.deepEqual(gate.relatedSources, ["src/util.ts"]);
    assert.deepEqual(gate.risk, ["data-loss"]);
  });

  it("follows one-hop deps as lightweight pointers: doc + first sentence only, sorted after the selected", () => {
    const pack = buildContextPack(input);
    const deps = pack.entries.filter((e) => e.relation === "dependency");
    assert.deepEqual(deps.map((e) => e.feature), ["parser", "store"]);
    const parser = deps.find((e) => e.feature === "parser")!;
    assert.equal(parser.summary, "Parses source into anchors.");
    assert.equal(parser.invariants, "", "a dependency is a pointer, not an inlined contract");
    assert.deepEqual(parser.primarySources, [], "a dependency does not inline its sources");
    // store is a dep of BOTH gate and parser but appears once, one-hop from gate.
    assert.equal(deps.filter((e) => e.feature === "store").length, 1);
  });

  it("does not transitively walk dependencies", () => {
    // store depends on nothing here; if parser->store were transitively pulled
    // from gate we'd still see only one hop. Assert no second-hop features leak.
    const pack = buildContextPack(input);
    assert.deepEqual(
      pack.entries.map((e) => e.feature),
      ["gate", "parser", "store"],
    );
  });

  it("is deterministic — byte-identical across runs", () => {
    assert.deepEqual(buildContextPack(input), buildContextPack(input));
  });

  it("estimates tokens as ceil(chars/4), summed across entries", () => {
    const pack = buildContextPack(input);
    for (const e of pack.entries) assert.ok(e.estimatedTokens > 0);
    assert.equal(
      pack.estimatedTokens,
      pack.entries.reduce((s, e) => s + e.estimatedTokens, 0),
    );
    assert.equal(estimateTokens("12345678"), 2);
    assert.equal(estimateTokens("123456789"), 3);
  });

  it("flags a selected slug the registry does not know, and never fabricates it", () => {
    const pack = buildContextPack({
      ...input,
      selector: { kind: "feature", value: "ghost" },
      selected: ["gate", "ghost"],
      unknownFeatures: ["ghost"],
    });
    assert.deepEqual(pack.unknownFeatures, ["ghost"]);
    assert.ok(!pack.entries.some((e) => e.feature === "ghost"));
  });
});

describe("ownersOfFile — file selector resolves through primary ownership", () => {
  const registry = registryOf({
    // a feature and a concept umbrella that both PRIMARILY own the shared file
    drift: { primary_sources: ["src/lib/drift.ts"] },
    lib: { type: "concept", primary_sources: ["src/lib/drift.ts", "src/lib/other.ts"] },
    // a feature that only RELATED-touches it (impact, never ownership)
    reviewer: { related_sources: ["src/lib/drift.ts"] },
  });

  it("returns every primary owner incl. concept umbrellas, never a related-only toucher", () => {
    assert.deepEqual(ownersOfFile(registry, "src/lib/drift.ts"), ["drift", "lib"]);
  });

  it("returns nothing for a file no entry owns", () => {
    assert.deepEqual(ownersOfFile(registry, "src/lib/nobody.ts"), []);
  });
});

describe("ownershipOfFile — ownership through the same matcher the gate uses", () => {
  // Declared out of alphabetical order on purpose: the answer must be sorted by
  // the resolver, not inherited from however the registry file happens to read.
  const registry = registryOf({
    lib: { type: "concept", primary_sources: ["src/lib/drift.ts", "src/lib/other.ts"] },
    drift: { primary_sources: ["src/lib/drift.ts"] },
    reviewer: { related_sources: ["src/lib/drift.ts"] },
    locales: { primary_sources: ["i18n/locales/**/*.json"] },
    // declares BOTH a literal and a pattern that cover the same file
    both: { primary_sources: ["src/both/**", "src/both/one.ts"] },
  });

  it("names a file governed by a registered pattern, not just a literal source", () => {
    // The tree grain made a pattern a legitimate way to own a file. An ownership
    // answer that only reads literals tells an agent "nothing owns this" about a
    // correctly-registered file — the worst possible answer to this question.
    assert.deepEqual(ownershipOfFile(registry, "i18n/locales/en/common.json"), [
      { feature: "locales", doc: "docs/features/locales.md", via: "i18n/locales/**/*.json" },
    ]);
  });

  it("carries the literal when an entry declares both, so the answer is the specific claim", () => {
    assert.deepEqual(ownershipOfFile(registry, "src/both/one.ts")[0].via, "src/both/one.ts");
    assert.deepEqual(ownershipOfFile(registry, "src/both/two.ts")[0].via, "src/both/**");
  });

  it("returns every primary owner incl. concept umbrellas, never a related-only toucher", () => {
    assert.deepEqual(
      ownershipOfFile(registry, "src/lib/drift.ts").map((o) => o.feature),
      ["drift", "lib"],
    );
  });

  it("resolves a Windows-shaped path the same as its posix form", () => {
    assert.deepEqual(ownersOfFile(registry, "src\\lib\\drift.ts"), ["drift", "lib"]);
  });

  it("returns nothing for a file no entry owns", () => {
    assert.deepEqual(ownershipOfFile(registry, "src/lib/nobody.ts"), []);
  });
});

describe("selectedFromPlanRows — plan selector routes via the Feature Map", () => {
  it("collects every row's primary owner plus its secondaries, sorted", () => {
    const md = [
      "```feature-map",
      "src/a.ts | alpha | feature | does A [secondary: shared]",
      "src/b.ts | beta  | feature | does B",
      "```",
    ].join("\n");
    const rows = parseFeatureMap(md).rows;
    assert.deepEqual(selectedFromPlanRows(rows), ["alpha", "beta", "shared"]);
  });
});

describe("gatherContextPack — impure wrapper over the registry + docs", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-context-"));
    const registry = registryOf({
      gate: { primary_sources: ["src/gate.ts"], depends_on: ["store"] },
      store: { primary_sources: ["src/store.ts"] },
    });
    await write(root, "docs/.registry.json", JSON.stringify(registry, null, 2));
    await write(root, "docs/features/gate.md", doc("The gate decides safety.", "- Fail closed. *(test: `gate.test.ts` x)*"));
    await write(root, "docs/features/store.md", doc("Owns the registry file. Atomic writes."));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function readRegistry(): Promise<Registry> {
    const { readRegistrySync } = await import("../src/lib/registry.js");
    return readRegistrySync(join(root, "docs", ".registry.json"));
  }

  it("reads the selected feature's doc and its one-hop dep's doc off disk", async () => {
    const registry = await readRegistry();
    const pack = gatherContextPack(root, registry, {
      kind: "feature",
      input: "gate",
      selected: ["gate"],
      unknownFeatures: [],
      unmappedFile: null,
      planErrors: [],
    });
    assert.deepEqual(pack.entries.map((e) => e.feature), ["gate", "store"]);
    assert.match(pack.entries[0].invariants, /Fail closed/);
    assert.deepEqual(pack.entries[0].testPointers, ["gate.test.ts"]);
    assert.equal(pack.entries[1].summary, "Owns the registry file.");
    // the selector echoes the caller's input, not what it resolved to
    assert.deepEqual(pack.selector, { kind: "feature", value: "gate" });
  });

  it("surfaces an unmapped --file rather than guessing an owner, echoing the file path", async () => {
    const registry = await readRegistry();
    const pack = gatherContextPack(root, registry, {
      kind: "file",
      input: "src/orphan.ts",
      selected: [],
      unknownFeatures: [],
      unmappedFile: "src/orphan.ts",
      planErrors: [],
    });
    assert.equal(pack.unmappedFile, "src/orphan.ts");
    assert.deepEqual(pack.entries, []);
    assert.deepEqual(pack.selector, { kind: "file", value: "src/orphan.ts" });
  });

  it("a missing doc yields empty orientation, never a throw", async () => {
    const registry = await readRegistry();
    // point store at a nonexistent doc by removing it from disk first
    await rm(join(root, "docs/features/store.md"), { force: true });
    const pack = gatherContextPack(root, registry, {
      kind: "feature",
      input: "store",
      selected: ["store"],
      unknownFeatures: [],
      unmappedFile: null,
      planErrors: [],
    });
    assert.equal(pack.entries[0].summary, "");
  });
});

describe("applyBudget — tail-first trimming, head inviolable", () => {
  const registry = registryOf({
    gate: {
      primary_sources: ["src/gate.ts", "src/verdict.ts"],
      related_sources: ["src/util.ts"],
      depends_on: ["store"],
      risk: ["data-loss"],
    },
    store: { primary_sources: ["src/store.ts"] },
  });
  const docContents = new Map<string, string>([
    ["docs/features/gate.md", doc("The gate decides safety.", "- Fail closed. *(test: `gate.test.ts` x)*")],
    ["docs/features/store.md", doc("Owns the registry file. Atomic.")],
  ]);
  const full = buildContextPack({
    selector: { kind: "feature", value: "gate" },
    selected: ["gate"],
    registry,
    unknownFeatures: [],
    unmappedFile: null,
    planErrors: [],
    docContents,
  });

  it("a generous budget trims nothing", () => {
    const { pack, trimmed, overBudget } = applyBudget(full, 100000);
    assert.deepEqual(trimmed, []);
    assert.equal(overBudget, false);
    assert.deepEqual(pack.entries.map((e) => e.feature), ["gate", "store"]);
    assert.equal(pack.estimatedTokens, full.estimatedTokens);
  });

  it("trims tail-first (risk → related → deps → primary) and reports every dropped tier", () => {
    // A tiny budget forces every trimmable tier off.
    const { pack, trimmed, overBudget } = applyBudget(full, 1);
    assert.deepEqual(trimmed, [
      "risk tags",
      "related sources",
      "dependency pointers",
      "primary source lists",
    ]);
    const gate = pack.entries.find((e) => e.feature === "gate")!;
    // the head survives; the tail is gone
    assert.match(gate.summary, /The gate decides safety/);
    assert.match(gate.invariants, /Fail closed/);
    assert.deepEqual(gate.risk, []);
    assert.deepEqual(gate.relatedSources, []);
    assert.deepEqual(gate.primarySources, []);
    assert.ok(!pack.entries.some((e) => e.relation === "dependency"), "deps dropped");
    // head alone still exceeds 1 token → honestly reported, never dropped
    assert.equal(overBudget, true);
  });

  it("stops trimming as soon as the pack fits — a mid-tier budget keeps the head tiers", () => {
    // Budget between "risk trimmed" and "full": drops only the lowest tier(s).
    const afterRisk = applyBudget(full, full.estimatedTokens - 1);
    assert.deepEqual(afterRisk.trimmed, ["risk tags"]);
    assert.equal(afterRisk.overBudget, false);
    const gate = afterRisk.pack.entries.find((e) => e.feature === "gate")!;
    assert.deepEqual(gate.risk, []);
    assert.deepEqual(gate.relatedSources, ["src/util.ts"], "higher tiers untouched");
    assert.deepEqual(gate.primarySources, ["src/gate.ts", "src/verdict.ts"]);
  });

  it("recomputes the estimate and total to match the trimmed content", () => {
    const { pack } = applyBudget(full, 1);
    assert.equal(
      pack.estimatedTokens,
      pack.entries.reduce((s, e) => s + e.estimatedTokens, 0),
    );
    assert.ok(pack.estimatedTokens < full.estimatedTokens);
  });

  it("is pure — same pack + budget yields a deep-equal result", () => {
    assert.deepEqual(applyBudget(full, 50), applyBudget(full, 50));
  });
});

describe("codument context — end-to-end through the real CLI", () => {
  let root: string;
  const env = { ...process.env, NO_COLOR: "1" };
  const run = (args: string[]) => execFileSync("node", [CLI, ...args], { cwd: root, encoding: "utf-8", env });
  const runFail = (args: string[]): string => {
    try {
      run(args);
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string };
      assert.notEqual(e.status ?? 0, 0);
      return e.stdout ?? "";
    }
    return assert.fail("expected a nonzero exit");
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-context-cli-"));
    const registry = registryOf({
      gate: { primary_sources: ["src/gate.ts"], depends_on: ["store"], risk: ["data-loss"] },
      store: { primary_sources: ["src/store.ts"] },
    });
    await write(root, "docs/.registry.json", JSON.stringify(registry, null, 2));
    await write(root, "docs/features/gate.md", doc("The gate decides safety.", "- Fail closed. *(test: `gate.test.ts` x)*"));
    await write(root, "docs/features/store.md", doc("Owns the registry file. Atomic writes."));
    await write(
      root,
      "docs/plans/p.md",
      ["```feature-map", "src/gate.ts | gate | feature | the gate", "```"].join("\n"),
    );
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--json is version-tagged and byte-identical across runs", () => {
    const a = run(["context", "--feature", "gate", "--json"]);
    const b = run(["context", "--feature", "gate", "--json"]);
    assert.equal(a, b);
    const parsed = JSON.parse(a);
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.selector, { kind: "feature", value: "gate" });
    assert.equal(parsed.entries[0].feature, "gate");
    assert.deepEqual(parsed.entries[0].testPointers, ["gate.test.ts"]);
    assert.equal(parsed.entries[1].feature, "store");
    assert.equal(parsed.budget, null);
  });

  it("--file resolves through ownership", () => {
    const parsed = JSON.parse(run(["context", "--file", "src/gate.ts", "--json"]));
    assert.deepEqual(parsed.selector, { kind: "file", value: "src/gate.ts" });
    assert.equal(parsed.entries[0].feature, "gate");
  });

  it("--plan routes through the Feature Map", () => {
    const parsed = JSON.parse(run(["context", "--plan", "docs/plans/p.md", "--json"]));
    assert.deepEqual(parsed.selector, { kind: "plan", value: "docs/plans/p.md" });
    assert.ok(parsed.entries.some((e: { feature: string }) => e.feature === "gate"));
  });

  it("--budget trims tail-first and records what it dropped in the contract", () => {
    const parsed = JSON.parse(run(["context", "--feature", "gate", "--budget", "1", "--json"]));
    assert.equal(parsed.budget, 1);
    assert.ok(parsed.trimmed.includes("risk tags"));
    assert.equal(parsed.overBudget, true);
  });

  it("exits nonzero on no selector, two selectors, and a non-positive budget", () => {
    assert.match(runFail(["context"]), /choose one selector/);
    assert.match(runFail(["context", "--feature", "gate", "--file", "src/gate.ts"]), /mutually exclusive/);
    assert.match(runFail(["context", "--feature", "gate", "--budget", "-5"]), /whole number of tokens/);
  });

  it("rejects a sub-1 --budget rather than silently flooring it to 0", () => {
    // 0.9 would floor to 0 — the exact effective budget `--budget 0` is rejected
    // for; it must be rejected consistently, not silently reinterpreted.
    assert.match(runFail(["context", "--feature", "gate", "--budget", "0.9"]), /whole number of tokens/);
    assert.match(runFail(["context", "--feature", "gate", "--budget", "0"]), /whole number of tokens/);
  });

  it("surfaces malformed Feature-Map rows instead of silently dropping them", async () => {
    await write(
      root,
      "docs/plans/mixed.md",
      [
        "```feature-map",
        "src/gate.ts | gate | feature | the gate",
        "src/store.ts | Bad_Slug | feature | the store", // uppercase slug → rejected
        "```",
      ].join("\n"),
    );
    const parsed = JSON.parse(run(["context", "--plan", "docs/plans/mixed.md", "--json"]));
    // the valid row still routes...
    assert.ok(parsed.entries.some((e: { feature: string }) => e.feature === "gate"));
    // ...and the malformed row is surfaced, not silently dropped
    assert.ok(parsed.planErrors.length >= 1, JSON.stringify(parsed.planErrors));
    // the human path warns too
    assert.match(run(["context", "--plan", "docs/plans/mixed.md"]), /malformed Feature-Map row/);
  });

  it("fails gracefully when --plan points at a directory (no uncaught stack trace)", () => {
    // docs/plans exists as a directory: existsSync passes, readFileSync throws
    // EISDIR — the command must fail cleanly, not crash.
    const out = runFail(["context", "--plan", "docs/plans"]);
    assert.match(out, /could not read plan/);
  });
});

describe("codument context --owner — the ownership lookup priced at a line", () => {
  let root: string;
  const env = { ...process.env, NO_COLOR: "1" };
  const run = (args: string[]) => execFileSync("node", [CLI, ...args], { cwd: root, encoding: "utf-8", env });
  const runFail = (args: string[]): string => {
    try {
      run(args);
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string };
      assert.notEqual(e.status ?? 0, 0);
      return e.stdout ?? "";
    }
    return assert.fail("expected a nonzero exit");
  };
  const lines = (out: string): string[] => out.split(/\r?\n/).filter((l) => l.trim() !== "");

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-owner-"));
    const registry = registryOf({
      store: { type: "concept", primary_sources: ["src/shared.ts"] },
      gate: { primary_sources: ["src/gate.ts", "src/shared.ts"], depends_on: ["store"], risk: ["data-loss"] },
      locales: { primary_sources: ["i18n/locales/**/*.json"] },
    });
    await write(root, "docs/.registry.json", JSON.stringify(registry, null, 2));
    await write(root, "docs/features/gate.md", doc("The gate decides safety.", "- Fail closed. *(test: `gate.test.ts` x)*"));
    await write(root, "docs/features/store.md", doc("Owns the registry file."));
    await write(root, "docs/features/locales.md", doc("Every user-visible string."));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("answers a single-owner file in one line naming the owning doc", () => {
    const out = run(["context", "--file", "src/gate.ts", "--owner"]);
    assert.equal(lines(out).length, 1, out);
    assert.match(out, /src\/gate\.ts/);
    assert.match(out, /docs\/features\/gate\.md/);
  });

  it("names every candidate for a shared file, still in one line", () => {
    const out = run(["context", "--file", "src/shared.ts", "--owner"]);
    assert.equal(lines(out).length, 1, out);
    assert.match(out, /docs\/features\/gate\.md/);
    assert.match(out, /docs\/features\/store\.md/);
  });

  it("says plainly when nothing owns the file, and still exits 0", () => {
    // Unowned is a fact about the repository, not a bad invocation — a lookup
    // that fails the shell is a lookup nobody puts in a hook.
    const out = run(["context", "--file", "src/orphan.ts", "--owner"]);
    assert.equal(lines(out).length, 1, out);
    assert.match(out, /no feature owns src\/orphan\.ts/);
  });

  it("answers for a file a registered pattern governs, naming the tree it came through", () => {
    const out = run(["context", "--file", "i18n/locales/en/common.json", "--owner"]);
    assert.equal(lines(out).length, 1, out);
    assert.match(out, /docs\/features\/locales\.md/);
    assert.match(out, /via i18n\/locales\/\*\*\/\*\.json/);
  });

  it("costs a fraction of the pack it replaces", () => {
    const lean = run(["context", "--file", "src/gate.ts", "--owner"]).length;
    const pack = run(["context", "--file", "src/gate.ts"]).length;
    assert.ok(lean * 4 < pack, `lean ${lean} vs pack ${pack}`);
  });

  it("leaves the full pack untouched when the flag is absent", () => {
    // The lean answer is an additional door, never a change to the existing one.
    const parsed = JSON.parse(run(["context", "--file", "src/gate.ts", "--json"]));
    assert.deepEqual(parsed.selector, { kind: "file", value: "src/gate.ts" });
    assert.equal(parsed.entries[0].feature, "gate");
    assert.ok(parsed.entries[0].invariants.includes("Fail closed"));
  });

  it("the pack and the lean answer resolve a pattern-owned file the same way", () => {
    // The claim is that the two doors cannot disagree. A file governed by a
    // registered tree is the case where they used to: the pack called it
    // unmapped while the registry plainly owned it.
    const parsed = JSON.parse(run(["context", "--file", "i18n/locales/en/common.json", "--json"]));
    assert.equal(parsed.unmappedFile, null);
    assert.deepEqual(
      parsed.entries.map((e: { feature: string }) => e.feature),
      ["locales"],
    );
    const owners = JSON.parse(
      run(["context", "--file", "i18n/locales/en/common.json", "--owner", "--json"]),
    ).owners;
    assert.deepEqual(owners.map((o: { feature: string }) => o.feature), ["locales"]);
  });

  it("still rejects a malformed --budget alongside --owner rather than ignoring the flag", () => {
    // The lean route short-circuits the pack; it must not short-circuit the
    // validation of a flag the caller actually typed.
    assert.match(
      runFail(["context", "--file", "src/gate.ts", "--owner", "--budget", "0"]),
      /whole number of tokens/,
    );
  });

  it("emits a version-tagged contract under --json, byte-identical across runs", () => {
    const a = run(["context", "--file", "src/shared.ts", "--owner", "--json"]);
    assert.equal(a, run(["context", "--file", "src/shared.ts", "--owner", "--json"]));
    const parsed = JSON.parse(a);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.file, "src/shared.ts");
    assert.deepEqual(
      parsed.owners.map((o: { feature: string }) => o.feature),
      ["gate", "store"],
    );
    assert.deepEqual(JSON.parse(run(["context", "--file", "src/orphan.ts", "--owner", "--json"])).owners, []);
  });

  it("refuses --owner without --file, and alongside another selector", () => {
    assert.match(runFail(["context", "--owner"]), /use it with --file/);
    assert.match(runFail(["context", "--owner", "--feature", "gate"]), /use it with --file/);
    assert.match(runFail(["context", "--owner", "--file", "src/gate.ts", "--plan", "p.md"]), /use it with --file/);
  });
});

async function write(root: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), content);
}
