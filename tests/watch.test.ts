import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, readRecentEvents } from "../src/lib/events.js";
import { renderFrame } from "../src/commands/watch.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-watch-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("events log", () => {
  it("appends and reads back recent events oldest→newest", () => {
    appendEvent(tmp, { type: "review", message: "first", ts: "2026-06-16T10:00:00.000Z" });
    appendEvent(tmp, { type: "step", message: "second", ts: "2026-06-16T10:01:00.000Z" });
    const events = readRecentEvents(tmp, 10);
    assert.equal(events.length, 2);
    assert.equal(events[0].message, "first");
    assert.equal(events[1].type, "step");
  });

  it("caps to the most recent N", () => {
    for (let i = 0; i < 30; i++) {
      appendEvent(tmp, { type: "note", message: `n${i}`, ts: "2026-06-16T10:00:00.000Z" });
    }
    const events = readRecentEvents(tmp, 5);
    assert.equal(events.length, 5);
    assert.equal(events[4].message, "n29");
  });

  it("returns empty when no log exists", () => {
    assert.deepStrictEqual(readRecentEvents(tmp), []);
  });
});

describe("renderFrame", () => {
  it("renders coverage and a not-a-git-repo notice", () => {
    const review = {
      version: 1 as const,
      isGitRepo: false,
      changedFileCount: 0,
      plan: null,
      state: {} as never,
    };
    const coverage = { coverage: { percent: 80 } } as never;
    const frame = renderFrame(review, coverage, [], "2026-06-16 10:00:00");
    assert.match(frame, /codument watch/);
    assert.match(frame, /docs coverage: 80%/);
    assert.match(frame, /not a git repo/);
  });
});

describe("codument watch --once (CLI, temp git repo)", () => {
  function gitInit(root: string): void {
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
    run(["init"]);
    run(["config", "user.email", "t@e.com"]);
    run(["config", "user.name", "T"]);
    run(["add", "-A"]);
    run(["commit", "-m", "baseline"]);
  }

  it("renders one frame with coverage and a change summary", async () => {
    await mkdir(join(tmp, "src", "auth"), { recursive: true });
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await writeFile(
      join(tmp, "docs", ".registry.json"),
      JSON.stringify({
        features: {
          auth: {
            doc: "docs/features/auth.md",
            type: "feature",
            primary_sources: ["src/auth/login.ts"],
            related_sources: [],
            docs: [],
            depends_on: [],
            risk: ["auth"],
            last_updated: "2026-06-16",
            status: "current",
          },
        },
      }),
    );
    await writeFile(join(tmp, "docs", "features", "auth.md"), "# auth\n");
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 1;\n");
    gitInit(tmp);
    // make a change so the frame has something to show
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const a = 2;\n");

    const out = execFileSync("node", [CLI, "watch", "--once"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.match(out, /codument watch/);
    assert.match(out, /docs coverage/);
    assert.match(out, /stale docs/);
  });

  it("watches a repo given by --dir from a different cwd (no cd needed)", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "docs"), { recursive: true });
    await writeFile(join(tmp, "docs", ".registry.json"), JSON.stringify({ features: {} }));
    await writeFile(join(tmp, "src", "a.ts"), "export const a = 1;\n");
    gitInit(tmp);

    // run from `here` (the tests dir), targeting tmp via --dir
    const out = execFileSync("node", [CLI, "watch", "--once", "--dir", tmp], {
      cwd: here,
      encoding: "utf-8",
    });
    assert.match(out, /codument watch/);
    assert.match(out, /docs coverage/);
  });
});
