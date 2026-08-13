import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { forgetWorkspace } from "../src/lib/git.js";

// The field-shaped fixture: a repository with the properties this one does not
// have, because that difference is why the suite passes and the field does not.
//
// Every failure in the last three field reports bit in a repo with CRLF working
// files, no `src/` directory, screens that export one default component, a locale
// pack of JSON, and a rules file nobody's parser reads. This repo has LF, a `src/`
// tree, named exports everywhere, and no JSON it governs — so a suite written
// against it can be entirely green while a real project trips on the first commit.
// A fixture is the cheapest way to stop that being discovered by a user.
//
// What it replays is the field session's three gate episodes, which between them
// account for five of that session's acknowledgments. Under ADR 020 they should
// cost one: the two that were tolls disappear, and the one that was a real
// contract question stays and gets louder.

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const roots: string[] = [];

/** Every fixture file lands with CRLF, the way a Windows checkout does. */
const crlf = (s: string): string => s.replace(/\r?\n/g, "\r\n");

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function run(root: string, argv: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...argv], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", NO_COLOR: "1" },
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

async function put(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    if (content === null) {
      await rm(full, { force: true });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, crlf(content));
  }
}

const doc = (title: string) =>
  `---\ntitle: ${title}\nstatus: current\ntype: feature\n---\n\n# ${title}\n\n## In plain terms\n\n${title} is part of the app.\n\n## Design approach\n\nIt does its job and hands off.\n\n## Invariants & boundaries\n\n- It never writes outside its own surface. (untested)\n\n## Decisions\n\n- Shipped as part of the first release.\n\n## Key files\n\n- The screen and its helpers.\n`;

/**
 * A doc long enough for the section split to be the difference between clean and
 * flagged: four sections of forty-odd lines each. Under LF no section crosses the
 * bloat threshold and the doc reports nothing; a parser blind to `\r` sees ONE
 * untitled section of the whole file and invents an oversized-section finding.
 *
 * Sized on purpose. A short doc reports nothing under either reading, so a
 * comparison over one would pass however broken the parser is — which is exactly
 * what this fixture's first draft did, and only a mutation showed it.
 */
const longDoc = (title: string): string => {
  const para = (n: number) =>
    Array.from(
      { length: 42 },
      (_, i) => `The ${title} surface holds line ${n}.${i} of its explanation for a reader.`,
    ).join("\n");
  return `---\ntitle: ${title}\nstatus: current\ntype: feature\n---\n\n# ${title}\n\n## In plain terms\n\n${para(1)}\n\n## Design approach\n\n${para(2)}\n\n## Invariants & boundaries\n\n${para(3)}\n\n## Decisions\n\n${para(4)}\n\n## Key files\n\nThe screen and its helpers.\n`;
};

const entry = (over: Record<string, unknown>) => ({
  doc: "docs/features/x.md",
  type: "feature",
  primary_sources: [],
  related_sources: [],
  docs: [],
  depends_on: [],
  risk: [],
  status: "current",
  ...over,
});

// A screen with ONE default export, which is what every file in the field repo
// looked like and what nothing in this repo looks like.
const HOME = `import { Button } from "../components/Button";

export default function HomeScreen() {
  const label = "Start";
  return Button({ label, onPress: () => undefined });
}
`;

const BUTTON = `export function Button(props: { label: string; onPress: () => void }): string {
  const padding = 8;
  return \`\${props.label}:\${padding}\`;
}
`;

/**
 * The whole fixture, committed, with CRLF preserved through git.
 *
 * `.gitattributes` marks everything binary-ish on purpose: without it git
 * normalizes the committed bytes to LF and the working tree's CRLF reads as a
 * diff on every file, which would make the fixture measure git's conversion
 * rather than the gate's behaviour.
 */
async function fieldRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codument-field-"));
  roots.push(root);
  await put(root, {
    ".gitattributes": "* -text\n",
    "docs/.registry.json": `${JSON.stringify(
      {
        features: {
          home: entry({
            doc: "docs/features/home.md",
            primary_sources: ["app/screens/HomeScreen.tsx", "app/components/Button.tsx"],
          }),
          // Deliberately a SECOND claim on the same component, with no
          // `owned_symbols` between them: the field's contested-file shape.
          design: entry({
            doc: "docs/features/design.md",
            primary_sources: ["app/components/Button.tsx"],
          }),
          i18n: entry({ doc: "docs/features/i18n.md", primary_sources: ["locales/**"] }),
          security: entry({
            doc: "docs/features/security.md",
            primary_sources: ["firestore.rules"],
            risk: ["security"],
          }),
        },
      },
      null,
      2,
    )}\n`,
    "docs/features/home.md": doc("Home"),
    // Long enough that how the parser splits sections changes the answer.
    "docs/features/design.md": longDoc("Design"),
    "docs/features/i18n.md": doc("I18n"),
    "docs/features/security.md": doc("Security"),
    "app/screens/HomeScreen.tsx": HOME,
    "app/components/Button.tsx": BUTTON,
    "locales/en.json": '{\n  "start": "Start"\n}\n',
    "locales/fr.json": '{\n  "start": "Commencer"\n}\n',
    "firestore.rules": "match /users/{uid} {\n  allow read: if request.auth.uid == uid;\n}\n",
  });
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "the app as shipped"]);
  return root;
}

/** Every pasteable `codument ack` the run offered — the toll, counted. */
function acksDemanded(output: string): string[] {
  return [...output.matchAll(/codument ack [^\n`]+/g)]
    .map((m) => m[0].trim())
    .filter((cmd) => !/<[^>]+>/.test(cmd));
}

after(async () => {
  forgetWorkspace();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("the field repo, replayed (plan 47)", () => {
  it("episode 1: a body edit on a contested screen costs nothing", async () => {
    // The field session's worst moment. One visual tweak inside a component two
    // features claim woke both docs, and neither an ack nor a doc edit could
    // honestly settle it — the exit taken was prose written into five docs. Under
    // ADR 020 the move is proven body-only, so there is nothing to settle: the
    // contested-ownership question is never even asked, because no doc went stale.
    const root = await fieldRepo();
    await put(root, {
      "app/components/Button.tsx": BUTTON.replace("const padding = 8;", "const padding = 12;"),
    });

    const review = run(root, ["review", "--strict"]);
    assert.equal(review.code, 0, `the gate blocked a body-only move:\n${review.out}`);
    assert.deepEqual(acksDemanded(review.out), [], "an ack was demanded for a body-only move");
    // Reported, not silent: the reader is told the tool saw the move and chose
    // not to block, on the line a piped read keeps.
    const verdict = review.out.trimEnd().split("\n").pop() ?? "";
    assert.match(verdict, /reported, not gated/, `verdict hid the move: ${verdict}`);
    // And the contested-ownership demand the field actually paid never appears.
    assert.doesNotMatch(review.out, /shared symbol no feature claims/);

    // The command agrees with the report: there is nothing here to sign.
    const ack = run(root, [
      "ack",
      "app/components/Button.tsx::Button",
      "--reason",
      "visual tweak only",
    ]);
    assert.equal(ack.code, 1, "a body-only move was acked into the ledger");
    assert.match(ack.out, /body-only move/);
  });

  it("episode 2: a locale pack gains strings without a signature", async () => {
    // Four acknowledgments in the field ledger for one translation drop, each the
    // same sentence, because a JSON tree no adapter reads gated on every edit. It
    // is still watched, attributed and reported — it just cannot be signed for,
    // because a signature over content nobody read is the toll ADR 020 refuses.
    const root = await fieldRepo();
    await put(root, {
      "locales/en.json": '{\n  "start": "Start",\n  "stop": "Stop"\n}\n',
      "locales/fr.json": '{\n  "start": "Commencer",\n  "stop": "Arrêter"\n}\n',
    });

    const review = run(root, ["review", "--strict"]);
    assert.equal(review.code, 0, `a non-risk blind file gated:\n${review.out}`);
    assert.deepEqual(acksDemanded(review.out), [], "an ack was demanded for a locale drop");
    // Named, with its owner, and with the one line that would make it block.
    assert.match(review.out, /locales\/en\.json/);
    assert.match(review.out, /"risk": \["<why it matters>"\]/);
    const verdict = review.out.trimEnd().split("\n").pop() ?? "";
    assert.match(verdict, /no adapter reads/, `verdict hid the downgrade: ${verdict}`);
  });

  it("episode 3: the rules file still blocks, and the signature names what it covers", async () => {
    // The one episode that keeps its toll, and the reason risk tags exist. A rule
    // change making private data world-readable rode along with a comment edit and
    // was signed off with a reason naming only the comment. It still gates — the
    // owner declared the risk — and now the command discloses the rule BEFORE
    // taking the signature, so a reason that does not match what is on screen is a
    // choice rather than an accident.
    const root = await fieldRepo();
    await put(root, {
      "firestore.rules": "match /users/{uid} {\n  allow read: if true;\n}\n",
    });

    const review = run(root, ["review", "--strict"]);
    assert.equal(review.code, 1, `a risk-declared rules change went green:\n${review.out}`);
    const demanded = acksDemanded(review.out);
    assert.equal(demanded.length, 1, `expected exactly one ack route, got ${demanded.join(" | ")}`);
    assert.match(demanded[0], /firestore\.rules/);
    assert.match(review.out, /signed over the disclosed lines/);

    const ack = run(root, ["ack", "firestore.rules", "--reason", "comment wording only"]);
    assert.equal(ack.code, 0);
    assert.match(ack.out, /allow read: if request\.auth\.uid == uid;/, "the rule it replaced");
    assert.match(ack.out, /\+ allow read: if true;/, "the rule it became");
    assert.ok(
      ack.out.indexOf("allow read: if true;") < ack.out.indexOf("✓ acknowledged"),
      "disclosed BEFORE the signature is taken, not after",
    );
    assert.equal(run(root, ["review", "--strict"]).code, 0, "the ack did not clear the gate");
  });

  it("the three episodes together cost one acknowledgment, where the field paid five", async () => {
    // The plan's acceptance criterion, asked of the whole session rather than of
    // one episode: the tolls that were unverifiable are gone, the one backed by a
    // declaration remains. Run as one change, because that is how a session lands.
    const root = await fieldRepo();
    await put(root, {
      "app/components/Button.tsx": BUTTON.replace("const padding = 8;", "const padding = 12;"),
      "locales/en.json": '{\n  "start": "Start",\n  "stop": "Stop"\n}\n',
      "firestore.rules": "match /users/{uid} {\n  allow read: if true;\n}\n",
    });
    const review = run(root, ["review", "--strict"]);
    const demanded = acksDemanded(review.out);
    assert.equal(
      demanded.length,
      1,
      `the session should cost one ack, not ${demanded.length}:\n${demanded.join("\n")}`,
    );
    assert.match(demanded[0], /firestore\.rules/);
  });

  it("a CRLF checkout is measured exactly as an LF one", async () => {
    // The 55 fabricated findings. A heading regex anchored at `$` sees no headings
    // in a CRLF file, so every doc reads as one nameless section and the bloat lint
    // invents debt that is not there. Asserted as a comparison rather than a count,
    // because the number is the lint's business and the EQUALITY is the contract.
    const crlfRoot = await fieldRepo();
    const lfRoot = await mkdtemp(join(tmpdir(), "codument-field-lf-"));
    roots.push(lfRoot);
    // The same repo, byte-for-byte, except the line endings.
    const { readFile, readdir } = await import("node:fs/promises");
    for (const rel of await readdir(crlfRoot, { recursive: true, withFileTypes: false })) {
      const name = String(rel).replace(/\\/g, "/");
      if (name.startsWith(".git/") || name === ".git") continue;
      const full = join(crlfRoot, String(rel));
      const stat = await import("node:fs/promises").then((m) => m.stat(full));
      if (stat.isDirectory()) continue;
      const text = await readFile(full, "utf8");
      await mkdir(dirname(join(lfRoot, name)), { recursive: true });
      await writeFile(join(lfRoot, name), text.replace(/\r\n/g, "\n"));
    }
    git(lfRoot, ["init"]);
    git(lfRoot, ["config", "user.email", "test@example.com"]);
    git(lfRoot, ["config", "user.name", "Test"]);
    git(lfRoot, ["add", "-A"]);
    git(lfRoot, ["commit", "-m", "the app as shipped"]);

    const strip = (s: string) => s.replace(/\r/g, "").replace(/[0-9a-f]{7,40}/g, "<sha>");
    assert.equal(
      strip(run(crlfRoot, ["doctor"]).out),
      strip(run(lfRoot, ["doctor"]).out),
      "a Windows checkout is diagnosed differently from a POSIX one",
    );
  });
});
