import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  ackCovers,
  ackFileName,
  isIndependent,
  parseAck,
  readAcks,
  writeAck,
  type Acknowledgment,
} from "../src/lib/acknowledgment.js";

const ACK: Acknowledgment = {
  anchorId: "src/lib/foo.ts::bar().",
  fromHash: "aaaa",
  toHash: "bbbb",
  reason: "pure rename of an internal variable; behavior unchanged",
  signer: "alice",
};

describe("parseAck", () => {
  it("accepts a well-formed ack", () => {
    assert.deepStrictEqual(parseAck({ ...ACK }), ACK);
  });
  it("rejects a missing/empty field", () => {
    assert.equal(parseAck({ ...ACK, reason: "" }), null);
    const { signer, ...noSigner } = ACK;
    void signer;
    assert.equal(parseAck(noSigner), null);
  });
  it("rejects non-objects", () => {
    assert.equal(parseAck("nope"), null);
    assert.equal(parseAck(null), null);
    assert.equal(parseAck(42), null);
  });
});

describe("ackCovers — fingerprint binding + auto-invalidation", () => {
  it("covers the exact anchor + transition it names", () => {
    assert.equal(ackCovers(ACK, "src/lib/foo.ts::bar().", "aaaa", "bbbb"), true);
  });
  it("does NOT cover a different anchor", () => {
    assert.equal(ackCovers(ACK, "src/lib/foo.ts::baz().", "aaaa", "bbbb"), false);
  });
  it("auto-invalidates when the anchor moves again (new toHash)", () => {
    // the anchor moved a second time -> head fp is now "cccc"; the ack vouched for
    // "bbbb", so it no longer covers — no ride-forever exemption.
    assert.equal(ackCovers(ACK, "src/lib/foo.ts::bar().", "aaaa", "cccc"), false);
  });
  it("does not cover a different starting point (stale from)", () => {
    assert.equal(ackCovers(ACK, "src/lib/foo.ts::bar().", "zzzz", "bbbb"), false);
  });
});

describe("ackFileName", () => {
  it("is deterministic for the same transition (idempotent)", () => {
    assert.equal(ackFileName(ACK), ackFileName({ ...ACK, reason: "different words" }));
  });
  it("differs when the transition differs", () => {
    assert.notEqual(ackFileName(ACK), ackFileName({ ...ACK, toHash: "cccc" }));
  });
});

describe("isIndependent (opt-in strict)", () => {
  it("a self-signed ack is not independent", () => {
    assert.equal(isIndependent(ACK, "alice"), false);
    assert.equal(isIndependent(ACK, "Alice "), false); // case/space-insensitive
  });
  it("a second-party ack is independent", () => {
    assert.equal(isIndependent(ACK, "bob"), true);
  });
});

describe("readAcks / writeAck (temp dir)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ack-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("round-trips an ack and reads it back", () => {
    const path = writeAck(tmp, ACK);
    assert.match(path, /\.codument\/acks\/[0-9a-f]{16}\.json$/);
    assert.deepStrictEqual(readAcks(tmp), [ACK]);
  });

  it("returns [] when no acks dir exists", () => {
    assert.deepStrictEqual(readAcks(tmp), []);
  });

  it("skips malformed ack files", async () => {
    await mkdir(join(tmp, ".codument", "acks"), { recursive: true });
    await writeFile(join(tmp, ".codument", "acks", "bad.json"), "{ not json");
    await writeFile(join(tmp, ".codument", "acks", "empty.json"), JSON.stringify({ anchorId: "x" }));
    writeAck(tmp, ACK);
    assert.deepStrictEqual(readAcks(tmp), [ACK], "only the valid ack survives");
  });

  it("writing the same transition twice is idempotent (one file)", () => {
    writeAck(tmp, ACK);
    writeAck(tmp, { ...ACK, reason: "reworded rationale" });
    assert.equal(readAcks(tmp).length, 1);
  });
});
