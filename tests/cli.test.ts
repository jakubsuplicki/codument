import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const env = { ...process.env, NO_COLOR: "1" };

describe("built workflow compatibility", () => {
  it("exposes the work and verify capabilities required by the shipped skills", () => {
    const work = execFileSync("node", [CLI, "work", "status", "--json"], {encoding: "utf8", env});
    assert.equal(JSON.parse(work).version, 1);
    const verify = execFileSync("node", [CLI, "verify", "--help"], {encoding: "utf8", env});
    assert.match(verify, /--record/);
    assert.match(verify, /--prepare-review/);
  });

  it("keeps its build identity and refuses managed updates when the package was changed without rebuilding", () => {
    const root = mkdtempSync(join(tmpdir(), "codument-stale-build-"));
    try {
      cpSync(join(here, "..", "dist"), join(root, "dist"), {recursive: true});
      symlinkSync(join(here, "..", "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
      writeFileSync(join(root, "package.json"), JSON.stringify({...pkg, version: "999.0.0"}));
      const cli = join(root, "dist", "cli.js");
      assert.equal(execFileSync("node", [cli, "--version"], {encoding: "utf8", env}).trim(), pkg.version);
      const update = spawnSync("node", [cli, "update"], {cwd: root, encoding: "utf8", env});
      assert.equal(update.status, 1);
      assert.match(update.stderr, /stale build/i);
      assert.match(update.stderr, /npm run build/);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});

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
