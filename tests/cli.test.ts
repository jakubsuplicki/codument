import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const env = { ...process.env, NO_COLOR: "1" };

describe("codument run (signpost)", () => {
  it("lists every registered command — the inventory is generated, never hand-maintained", () => {
    const runOut = execFileSync("node", [CLI, "run"], { encoding: "utf-8", env });
    const helpOut = execFileSync("node", [CLI, "--help"], { encoding: "utf-8", env });

    // Every command commander itself lists (minus the implicit help and the
    // signpost) must appear in the inventory line, so adding a command can
    // never silently drift this surface again — the drift that previously
    // dropped cost/map/ack/emit.
    const names = [...helpOut.matchAll(/^ {2}(\w[\w-]*)/gm)]
      .map((m) => m[1])
      .filter((n) => n !== "help" && n !== "run");
    assert.ok(names.length >= 15, `parsed only ${names.length} commands from --help`);
    assert.ok(names.includes("cost") && names.includes("map"), "sanity: parse saw the once-missing commands");

    const inventory = runOut
      .split("\n")
      .find((l) => l.trimStart().startsWith("codument "));
    assert.ok(inventory, "signpost prints a command-inventory line");
    for (const name of names) {
      assert.ok(inventory.includes(name), `signpost inventory missing "${name}"`);
    }
    assert.ok(runOut.includes("does not run your coding agent"));
  });
});
