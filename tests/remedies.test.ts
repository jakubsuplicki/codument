import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ackApplies,
  ackAppliesAt,
  conditionFor,
  CONDITION_IDS,
  renderRoute,
  routesFor,
  whyNoAck,
  type ConditionContext,
  type ConditionId,
} from "../src/lib/remedies.js";

// A context rich enough that every condition can name itself fully. The catalog
// is walked as a whole here on purpose: a table whose members are only exercised
// where some surface happens to call them is a table that grows a member nobody
// routes to, which is the exact failure it was built to end.
const CTX: ConditionContext = {
  file: "src/pay.ts",
  doc: "docs/features/pay.md",
  feature: "pay",
  anchorId: "src/pay.ts::priceOf",
  pattern: "locales/**",
  matched: 12,
  claimants: 3,
  candidates: ["pay", "billing"],
  descriptor: "priceOf",
  where: "docs/.registry.json",
};

describe("the condition catalog answers for every condition it names", () => {
  it("every condition routes somewhere", () => {
    for (const id of CONDITION_IDS) {
      const routes = routesFor(id, CTX);
      assert.ok(routes.length > 0, `${id} names no remedy`);
      for (const r of routes) {
        assert.ok(r.label.length > 0, `${id} has an unlabelled route`);
        assert.ok(renderRoute(r).trim().length > 0, `${id}'s "${r.label}" renders empty`);
      }
    }
  });

  it("a condition no acknowledgment reaches says why", () => {
    // The half that stops the routing defects: withholding the ack route without
    // a reason leaves the reader guessing, and guessing here means pasting the
    // command that gets refused. Asked of the conditions no grain reaches, and
    // of the symbol-grained ones that turn the per-symbol grain away — those are
    // the two shapes a reader actually types into and gets refused. A file-grain
    // condition "refusing" the tree grain is not a route anyone tries, and
    // demanding prose for it would be ceremony.
    for (const id of CONDITION_IDS) {
      const reachesNothing = !ackApplies(id);
      const refusesSymbol = id.startsWith("symbol-") && !ackAppliesAt(id, "symbol");
      if (!reachesNothing && !refusesSymbol) continue;
      assert.ok(whyNoAck(id, CTX), `${id} turns an ack away and gives no reason`);
    }
  });

  it("no route offers a command the condition would refuse", () => {
    // The pair that drifted, asserted directly. A route printing `codument ack`
    // over a condition no acknowledgment reaches is precisely what shipped for
    // deletions and for signature moves — a plausible thing to paste that leaves
    // the gate exactly as red.
    for (const id of CONDITION_IDS) {
      if (ackApplies(id)) continue;
      for (const r of routesFor(id, CTX)) {
        assert.doesNotMatch(
          renderRoute(r),
          /^codument ack |[^`]\bcodument ack \S/,
          `${id} routes to an ack it does not accept, via "${r.label}"`,
        );
      }
    }
  });

  it("never renders a half-built command, however thin the context", () => {
    // The price of one loose context bag: a route reading a field its caller
    // forgot renders `codument ack  --reason "..."` — a command that looks
    // pasteable and is not, which is the exact failure mode the catalog exists
    // to end, arrived at from the inside. Asked of an EMPTY context, because a
    // caller that forgets one field is the realistic version of this.
    for (const id of CONDITION_IDS) {
      for (const r of routesFor(id, {})) {
        const line = renderRoute(r);
        assert.doesNotMatch(line, /codument \S+ {2,}/, `${id}: "${r.label}" renders a gap`);
        assert.doesNotMatch(
          line,
          /codument (ack|map materialize)\s+--/,
          `${id}: "${r.label}" renders a command with no subject`,
        );
        assert.doesNotMatch(line, /undefined/, `${id}: "${r.label}" leaks an absent field`);
        assert.doesNotMatch(
          line,
          /codument \S+ ""/,
          `${id}: "${r.label}" renders a command with an empty argument`,
        );
      }
    }
  });

  it("a gating condition always leaves a way out", () => {
    // A block whose only honest answer is "you cannot clear this" is a trap. It
    // need not be an ack — a doc update, a registry edit and a materialize are
    // all exits — but there must be one, and it must be actionable prose rather
    // than a restatement of the finding.
    for (const id of CONDITION_IDS) {
      if (!conditionFor(id).gates) continue;
      const rendered = routesFor(id, CTX).map((r) => renderRoute(r));
      assert.ok(
        rendered.some((line) => /update|add|remove|replace|claim|codument|repair/i.test(line)),
        `${id} gates but offers no action`,
      );
    }
  });
});

describe("the routes read as they always have", () => {
  const render = (id: ConditionId, ctx: ConditionContext = CTX): string[] =>
    routesFor(id, ctx).map((r) => `${r.label} → ${renderRoute(r)}`);

  it("a signature move offers the doc update, denies the ack, and demotes only against a rival", () => {
    assert.deepStrictEqual(render("signature-move"), [
      "contract changed → update docs/features/pay.md at intent altitude",
      "signature move → the symbol's signature changed — the doc's contract needs an update, not an ack",
      "not its contract → 3 entries claim src/pay.ts; if pay's contract does not turn on this symbol, demote it there in docs/.registry.json rather than writing prose",
    ]);

    // A sole owner keeps the denial and loses the demotion: demoting the only
    // claim would leave the file unowned, which trades one wake for a worse one.
    assert.deepStrictEqual(render("signature-move", { ...CTX, claimants: 1 }), [
      "contract changed → update docs/features/pay.md at intent altitude",
      "signature move → the symbol's signature changed — the doc's contract needs an update, not an ack",
    ]);
  });

  it("an added or removed export routes to the FILE grain, never the symbol", () => {
    assert.deepStrictEqual(render("symbol-added-removed"), [
      "contract changed → update docs/features/pay.md at intent altitude",
      'additive only → codument ack src/pay.ts --reason "..." (file-grain; a per-symbol ack does not apply to added/removed)',
    ]);
    assert.equal(ackAppliesAt("symbol-added-removed", "symbol"), false);
    assert.equal(ackAppliesAt("symbol-added-removed", "file"), true);
  });

  it("a tree wake answers in one line, with its own count", () => {
    assert.deepStrictEqual(render("stale-doc-tree"), [
      "doc impact → update docs/features/pay.md at intent altitude",
      // Shell-quoted, because a glob pasted bare is expanded by the shell before
      // `ack` ever sees it — the route has to survive being pasted.
      'no doc impact → codument ack "locales/**" --reason "..." (tree-grain, 12 files; expires when any of them changes again)',
    ]);
  });

  it("a deletion and a body-only move sit at opposite ends and neither takes an ack", () => {
    assert.equal(ackApplies("owned-file-deleted"), false);
    assert.equal(conditionFor("owned-file-deleted").gates, true);
    assert.match(String(whyNoAck("owned-file-deleted")), /no acknowledgment clears a deletion/);

    assert.equal(ackApplies("body-only-move"), false);
    assert.equal(conditionFor("body-only-move").gates, false);
    assert.match(String(whyNoAck("body-only-move")), /reported and never gates \(ADR 020\)/);
  });

  it("a blind file with no declared risk is told how to earn its gate", () => {
    assert.deepStrictEqual(render("blind-unread-file", { ...CTX, feature: "i18n or app" }), [
      'gate it → add "risk": ["<why it matters>"] to i18n or app in docs/.registry.json',
    ]);
    assert.equal(conditionFor("blind-unread-file").gates, false);
  });
});

describe("renderRoute joins the way the author wrote it", () => {
  it("glues a continuation on without a separator", () => {
    // The alternative was inferring it from the first character, which reads as
    // working until a route opens with something the rule did not anticipate.
    const line = renderRoute({
      label: "fix",
      segments: [
        { text: "remove it from docs/.registry.json", ink: "plain" },
        { text: ", or map the new path", ink: "dim", glue: true },
      ],
    });
    assert.equal(line, "remove it from docs/.registry.json, or map the new path");
  });

  it("renders through the caller's palette, and plainly by default", () => {
    const route = {
      label: "map it",
      segments: [{ text: "codument map materialize src/a.ts", ink: "cmd" as const }],
    };
    assert.equal(renderRoute(route), "codument map materialize src/a.ts");
    assert.equal(
      renderRoute(route, { plain: (s) => s, cmd: (s) => `[${s}]`, dim: (s) => s }),
      "[codument map materialize src/a.ts]",
    );
  });
});
