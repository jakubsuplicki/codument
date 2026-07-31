import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildManagedSection } from "../src/lib/scaffold.js";

// English number words the changelog is expected to spell out (small, closed set —
// this test only needs to decode whatever word currently appears in the claim).
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

function unreleasedSection(changelog: string): string {
  const start = changelog.indexOf("## [Unreleased]");
  assert.ok(start >= 0, "CHANGELOG.md must have an [Unreleased] section");
  const rest = changelog.slice(start + "## [Unreleased]".length);
  const nextHeading = rest.indexOf("\n## [");
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}

describe("CHANGELOG factual claims", () => {
  // A changelog entry becomes permanent project history, so a countable claim in
  // one has to be true. This does NOT require the claim to exist — the honest fix
  // for a wrong statistic is usually to drop it, not to restate it. It bites only
  // when a count IS asserted and the contract disagrees.
  it('any claimed "compact" occurrence count in the generated contract is accurate', () => {
    const changelog = readFileSync("CHANGELOG.md", "utf-8");
    const section = unreleasedSection(changelog);

    const match = /the generated contract said "compact" (\w+) times/i.exec(section);
    if (!match) return; // no count claimed — nothing to verify

    const claimedWord = match[1].toLowerCase();
    const claimedCount = NUMBER_WORDS[claimedWord];
    assert.ok(claimedCount !== undefined, `unrecognized number word "${claimedWord}"`);

    // Count every substring occurrence of "compact" (case-insensitive), generously
    // including "compaction"/"compacts" — the most charitable reading of the claim.
    const contract = buildManagedSection();
    const actualCount = (contract.match(/compact/gi) ?? []).length;

    assert.equal(
      actualCount,
      claimedCount,
      `CHANGELOG claims the generated contract says "compact" ${claimedWord} (${claimedCount}) times, ` +
        `but buildManagedSection() actually contains it ${actualCount} times`,
    );
  });
});
