import { shellArg } from "./acknowledgment.js";

// ── The condition→remedy catalog ────────────────────────────────────────
//
// One table of every condition the gate can put a reader in, and what clears
// each one. Every surface that routes — `review` beside a finding, `ack` when it
// refuses, `doctor` beside a lint — renders from here rather than writing its
// own sentence.
//
// The defect this exists to end is not duplication, it is DISAGREEMENT. Six
// releases in a row shipped a capability and left a surface pointing somewhere
// else: `review` printed the ack route for a deletion `ack` had always refused;
// the signature route went on advertising an ack after the ownership half of the
// same line was fixed; `--standing` was retired while the text that recommended
// it stayed. Each was one edit in one file that its twin never received. Two
// hand-written sentences about the same condition are not a copy — they are two
// claims that can disagree, and the reader finds out by pasting one and watching
// it be refused. At the moment of most pressure, a route that cannot clear the
// finding it sits under is worse than no route at all.
//
// So a condition owns three things, and the surfaces own none of them: whether
// it gates, what clears it, and — the field that stops the whole class — which
// acknowledgment grains reach it. `ack` refuses exactly the grains a condition
// omits, and `review` withholds exactly those routes, both from that one field,
// so the two cannot drift apart without a test noticing.

/**
 * How a fragment of a route should read. The catalog holds the words; each
 * surface owns its own palette, so the same route renders in `review`'s colors,
 * `doctor`'s, or none at all for a machine consumer or a test asserting text.
 */
export type Ink = "plain" | "cmd" | "dim";

export interface Segment {
  text: string;
  ink: Ink;
  /**
   * Attach to the previous segment with no separator.
   *
   * Segments are space-joined, which is right for the clauses a route is made
   * of and wrong for a continuation that opens with punctuation — "the mention"
   * followed by "— a doc that…" wants one space, not two. Stated per segment
   * rather than inferred from the first character, because inferring it is a
   * guess that reads as working until some route opens with a character the
   * rule did not anticipate, and the failure is a stray space nobody sees.
   */
  glue?: boolean;
}

export interface Route {
  /** The left-column label a surface prints before the arrow. */
  label: string;
  segments: Segment[];
}

const plain = (text: string): Segment => ({ text, ink: "plain" });
const cmd = (text: string): Segment => ({ text, ink: "cmd" });
const dim = (text: string): Segment => ({ text, ink: "dim" });
/** A dim continuation that runs straight on from the segment before it. */
const dimRun = (text: string): Segment => ({ text, ink: "dim", glue: true });

/**
 * The grains an acknowledgment can be recorded at.
 *
 * A condition names the grains that REACH it, and the answer is routinely not
 * all-or-nothing: an added export has no per-symbol transition to bind a
 * signature to but does leave file-grain additive residue, and a symbol under a
 * concept umbrella is woken whole so only the file grain settles it. Modelling
 * that as one boolean is how "no ack applies" and "no per-symbol ack applies"
 * came to be written as the same sentence in two places and mean different
 * things in each.
 */
export type AckGrain = "symbol" | "file" | "tree";

/**
 * Every condition the gate can raise, named once.
 *
 * The ids are the battery's handle: step 9 enumerates this union and fails when
 * a member has no routed remedy, which is the inversion of a suite that could
 * only ever check the routes someone remembered to print.
 */
export type ConditionId =
  | "signature-move"
  | "symbol-internal-move"
  | "symbol-added-removed"
  | "body-only-move"
  | "stale-doc-file"
  | "stale-doc-tree"
  | "owned-file-deleted"
  | "ownership-unassigned"
  | "ownership-ambiguous"
  | "symbol-unowned"
  | "symbol-under-concept"
  | "unmapped-source"
  | "registry-pointer"
  | "doc-pointer"
  | "blind-risk-file"
  | "blind-unread-file"
  | "unevaluable-source"
  | "added-file";

/**
 * Everything a route can need to name itself, in one bag.
 *
 * Deliberately one loose shape rather than a discriminated context per
 * condition: the battery's whole value is that it can walk the catalog and ask
 * every member the same question, and a per-condition type would make the walk
 * impossible to write without a second table mapping ids to shapes — which is
 * the duplication this module exists to delete, reintroduced one level up.
 * Each condition documents which fields it reads.
 */
export interface ConditionContext {
  /** Repo-relative source path. */
  file?: string;
  /** The owning doc's path. */
  doc?: string;
  /** The owning feature or concept's registry key. */
  feature?: string;
  /** Full anchor descriptor (`path::symbol`). */
  anchorId?: string;
  /** A declared tree pattern from the registry. */
  pattern?: string;
  /** How many files a tree route would cover. */
  matched?: number;
  /** How many registry entries claim the file (the demotion route's precondition). */
  claimants?: number;
  /** Rival feature keys, for the ownership conditions. */
  candidates?: string[];
  /** The per-symbol descriptors, as resolved rather than as typed. Plural because
   *  one shared file routinely wakes several unclaimed anchors and the registry
   *  edit that settles them is one line naming all of them. */
  descriptors?: string[];
  /** Where a stale pointer is still named (a doc path, or a registry entry). */
  where?: string;
  /** The path a renamed file moved to, when it moved rather than vanished. */
  renamedTo?: string;
}

export interface Condition {
  id: ConditionId;
  /**
   * Whether a nonzero exit can follow from this condition. False means it is
   * reported and never blocks (ADR 020) — such a condition still routes, because
   * a reader who wants to act on it deserves to know how, but nothing is owed.
   */
  gates: boolean;
  /** What fired, in one clause. Read by the battery and by the catalog's docs. */
  fired: string;
  /**
   * The acknowledgment grains that reach this condition; empty means none does.
   *
   * The single most load-bearing field here. `ack` refuses exactly the grains
   * this omits and `review` withholds exactly those routes — both from this one
   * value, so the surface that offers a route and the command that honours it
   * can no longer disagree. Every historical routing defect was this pair
   * falling out of step.
   */
  ackGrains: readonly AckGrain[];
  /**
   * Why the grains it omits do not reach it. Present whenever any grain is
   * missing, which includes conditions that accept one grain and refuse another.
   */
  whyNoAck?: (ctx: ConditionContext) => string;
  /** Every route that clears it, in the order a reader should consider them. */
  routes: (ctx: ConditionContext) => Route[];
}

/**
 * A field a route needs, or an honest placeholder when the caller had none.
 *
 * The price of one loose context bag is that a route can read a field its
 * caller forgot, and raw interpolation renders that as the word "undefined" —
 * inside a command the reader is invited to paste. A slot reads as a slot: it
 * tells the reader what is missing instead of handing them a broken line, and
 * the catalog's own test refuses the word outright so this cannot be skipped
 * for the next field someone adds.
 */
const slot = (value: string | undefined, placeholder: string): string => value ?? placeholder;

/** "a", "a and b", "a, b and c" — these lines are read under pressure, and a
 *  possessive plural spliced onto a comma list ("checkout, product' ...") reads as
 *  a typo, which is one more reason to skip the block. */
const andList = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** The descriptors a registry edit must name, quoted as the JSON they go into. */
const descriptorList = (ctx: ConditionContext): string =>
  (ctx.descriptors ?? ["<symbol>"]).map((d) => JSON.stringify(d)).join(", ");

const docUpdate = (label: string, doc: string): Route => ({
  label,
  segments: [plain(`update ${doc}`), dim("at intent altitude")],
});

const fileAck = (label: string, file: string, note: string): Route => ({
  label,
  segments: [cmd(`codument ack ${shellArg(file)} --reason "..."`), dim(note)],
});

const CONDITIONS: Record<ConditionId, Condition> = {
  // ── Symbol-grained conditions ─────────────────────────────────────────
  "signature-move": {
    id: "signature-move",
    gates: true,
    fired: "an owned symbol's public signature changed",
    ackGrains: [],
    whyNoAck: () =>
      "no ack of any grain clears a contract change — the owning doc's contract needs the update",
    routes: (ctx) => {
      const routes: Route[] = [docUpdate("contract changed", ctx.doc ?? "the owning doc")];
      routes.push({
        label: "signature move",
        segments: [
          dim("the symbol's signature changed — the doc's contract needs an update, not an ack"),
        ],
      });
      // Offered only where a rival claim exists: demoting a sole owner would
      // leave the file unowned, which trades one wake for a worse one. Where the
      // doc's contract does not turn on the symbol at all, denying the ack
      // without this route leaves prose as the only exit — and prose there is
      // the mirror edit the whole gate exists to prevent.
      if ((ctx.claimants ?? 0) > 1) {
        routes.push({
          label: "not its contract",
          segments: [
            dim(
              `${slot(ctx.claimants?.toString(), "several")} entries claim ${slot(ctx.file, "<file>")}; if ${slot(ctx.feature, "<feature>")}'s contract does not turn on this symbol, demote it there in`,
            ),
            cmd("docs/.registry.json"),
            dim("rather than writing prose"),
          ],
        });
      }
      return routes;
    },
  },

  "symbol-internal-move": {
    id: "symbol-internal-move",
    gates: true,
    fired: "an owned symbol moved and no adapter could prove the signature held",
    // The one surviving home of the per-symbol acknowledgment. ADR 020 demotes a
    // move PROVEN body-only, and proof means both signatures present and equal —
    // which an adapter that reports no signature at all can never supply. On
    // those languages the move is still a contract question, so the ask stands
    // and the per-symbol signature is what settles it.
    ackGrains: ["symbol"],
    // The coarser grains genuinely do not reach it, and saying so is not
    // pedantry: a file ack over a precise file leaves every owned gating symbol
    // in it still flagged, which reads as the ack having failed unless the
    // reason is given. The command already warned about this in its own words;
    // now the warning and the route quote the same one.
    whyNoAck: () =>
      "a file- or tree-grain ack does not reach an owned symbol that still gates — the file vouch stands, but this move needs its own signature or a doc update",
    routes: (ctx) => [
      docUpdate("contract changed", ctx.doc ?? "the owning doc"),
      {
        label: "internal only",
        segments: [cmd(`codument ack ${shellArg(slot(ctx.anchorId, "<path>::<symbol>"))} --reason "..."`)],
      },
    ],
  },

  "symbol-added-removed": {
    id: "symbol-added-removed",
    gates: true,
    fired: "an exported symbol appeared or vanished",
    // The event is proven, but "this new helper export owes no doc line" is a
    // judgment the parser cannot make — so the escape exists, at file grain
    // only: there is no per-symbol transition to bind an ack to.
    ackGrains: ["file"],
    whyNoAck: (ctx) =>
      `an added or removed symbol has no per-symbol transition to sign, so it needs doc attention: update the owning doc, or acknowledge the file's additive residue with \`codument ack ${shellArg(slot(ctx.file, "<file>"))} --reason "..."\``,
    routes: (ctx) => [
      docUpdate("contract changed", ctx.doc ?? "the owning doc"),
      fileAck(
        "additive only",
        slot(ctx.file, "<file>"),
        "(file-grain; a per-symbol ack does not apply to added/removed)",
      ),
    ],
  },

  "body-only-move": {
    id: "body-only-move",
    gates: false,
    fired: "an owned symbol moved with both signatures present and equal",
    ackGrains: [],
    whyNoAck: () =>
      "implementation changed, and no documented contract can have gone stale from it, so it is reported and never gates (ADR 020). There is nothing here to acknowledge. If behaviour a doc actually describes did change, that is a doc update, not a signature",
    routes: () => [
      {
        label: "nothing owed",
        segments: [dim("reported, not gated — no doc line and no signature is owed (ADR 020)")],
      },
    ],
  },

  "symbol-unowned": {
    id: "symbol-unowned",
    gates: false,
    fired: "no feature owns the moved symbol",
    ackGrains: [],
    whyNoAck: (ctx) =>
      `nothing gates it and an ack would clear nothing. If it should be governed, map the file first: \`codument map materialize ${shellArg(slot(ctx.file, "<file>"))}\``,
    routes: (ctx) => [
      {
        label: "map it first",
        segments: [cmd(`codument map materialize ${shellArg(slot(ctx.file, "<file>"))}`)],
      },
    ],
  },

  "symbol-under-concept": {
    id: "symbol-under-concept",
    gates: true,
    fired: "the symbol's file is narrated whole by a concept umbrella",
    // The umbrella wakes the FILE, so the file-grain judgment is the one that
    // settles it. A per-symbol ack is refused, not because nothing gates, but
    // because the thing that gates is a grain coarser than the ack.
    ackGrains: ["file"],
    whyNoAck: (ctx) =>
      `it is narrated at file grain by a concept umbrella, which a per-symbol ack never clears: \`codument ack ${shellArg(slot(ctx.file, "<file>"))} --reason "..."\``,
    routes: (ctx) => [
      docUpdate("doc impact", ctx.doc ?? "the owning doc"),
      fileAck("no doc impact", slot(ctx.file, "<file>"), "(file-grain; expires when the file changes again)"),
    ],
  },

  // ── Ownership conditions: a registry edit, never a doc edit ───────────
  "ownership-unassigned": {
    id: "ownership-unassigned",
    gates: true,
    fired: "several features claim the file and none claims the symbol",
    ackGrains: [],
    whyNoAck: (ctx) =>
      `it is a shared symbol no feature claims (${slot(andList(ctx.candidates ?? []) || undefined, "the candidates")}), so no ack reaches it — the wake is ownership, not doc debt`,
    routes: (ctx) => {
      const others = (ctx.candidates ?? []).filter((c) => c !== ctx.feature);
      return [
        {
          label: "claim it",
          segments: [
            plain("add under ONE of them in docs/.registry.json:"),
            cmd(
              `"owned_symbols": { ${JSON.stringify(slot(ctx.file, "<file>"))}: [${descriptorList(ctx)}] }`,
            ),
          ],
        },
        {
          label: "demote it",
          segments: [
            plain(`keep ${slot(ctx.file, "<file>")} in one feature's`),
            cmd("primary_sources"),
            { text: ", move it to the", ink: "plain", glue: true },
            cmd("related_sources"),
            // Named where they are known: "the other candidates" is what the
            // reader is left with when the caller could not say, and a route
            // that names the entries to edit is one less lookup under pressure.
            plain(`of ${others.length > 0 ? andList(others) : "the other candidates"}`),
            dim("— impact, never a wake"),
          ],
        },
      ];
    },
  },

  "ownership-ambiguous": {
    id: "ownership-ambiguous",
    gates: true,
    fired: "two or more features claim the same symbol",
    ackGrains: [],
    whyNoAck: (ctx) =>
      `it is claimed by ${slot(andList(ctx.candidates ?? []) || undefined, "more than one feature")}, so ownership is ambiguous and no ack reaches it — remove the claim from owned_symbols in all but one of them`,
    routes: (ctx) => [
      {
        label: "fix",
        segments: [
          plain("remove"),
          cmd(descriptorList(ctx)),
          plain("from"),
          cmd("owned_symbols"),
          plain(
            `in all but one of ${slot(andList(ctx.candidates ?? []) || undefined, "the claiming features")}`,
          ),
        ],
      },
    ],
  },

  // ── File-grained conditions ───────────────────────────────────────────
  "stale-doc-file": {
    id: "stale-doc-file",
    gates: true,
    fired: "an owned source changed and its mapped doc did not",
    ackGrains: ["file"],
    routes: (ctx) => [
      docUpdate("doc impact", ctx.doc ?? "the owning doc"),
      fileAck("no doc impact", slot(ctx.file, "<file>"), "(file-grain; expires when the file changes again)"),
    ],
  },

  "stale-doc-tree": {
    id: "stale-doc-tree",
    gates: true,
    fired: "a declared tree's files changed and the owning doc did not",
    ackGrains: ["tree"],
    routes: (ctx) => [
      docUpdate("doc impact", ctx.doc ?? "the owning doc"),
      {
        label: "no doc impact",
        segments: [
          cmd(`codument ack ${shellArg(slot(ctx.pattern, "<tree>"))} --reason "..."`),
          dim(
            `(tree-grain, ${ctx.matched ?? 0} files; expires when any of them changes again)`,
          ),
        ],
      },
    ],
  },

  "owned-file-deleted": {
    id: "owned-file-deleted",
    gates: true,
    fired: "an owned source was removed",
    ackGrains: [],
    whyNoAck: () =>
      "a removal owes its owning doc an update (or the doc's own removal with its feature), and no acknowledgment clears a deletion",
    routes: (ctx) => [docUpdate("doc impact", ctx.doc ?? "the owning doc")],
  },

  "blind-risk-file": {
    id: "blind-risk-file",
    gates: true,
    fired: "a risk-declared file no adapter can read changed",
    ackGrains: ["file"],
    routes: (ctx) => [
      docUpdate("doc impact", ctx.doc ?? "the owning doc"),
      fileAck("no doc impact", slot(ctx.file, "<file>"), "(file-grain; signed over the disclosed lines)"),
    ],
  },

  "blind-unread-file": {
    id: "blind-unread-file",
    gates: false,
    fired: "an owned file no adapter can read changed, with no risk declared",
    ackGrains: [],
    whyNoAck: () =>
      "nothing gates it, so there is no finding for an ack to clear — declare a risk on an owning entry if it should block",
    routes: (ctx) => [
      {
        label: "gate it",
        segments: [
          plain("add"),
          cmd('"risk": ["<why it matters>"]'),
          dim(`to ${slot(ctx.feature, "<feature>")} in`),
          cmd("docs/.registry.json"),
        ],
      },
    ],
  },

  "unevaluable-source": {
    id: "unevaluable-source",
    gates: true,
    fired: "a governed source could not be parsed",
    ackGrains: [],
    whyNoAck: (ctx) => `${slot(ctx.file, "the file")} does not parse — fix the parse error before acking`,
    routes: (ctx) => [
      {
        label: "fix",
        segments: [
          plain(`repair the parse error in ${slot(ctx.file, "<file>")}`),
          dim("— a file the gate cannot read is never acked fresh"),
        ],
      },
    ],
  },

  "added-file": {
    id: "added-file",
    gates: true,
    fired: "a file was added, so there is no content transition to sign",
    ackGrains: [],
    whyNoAck: (ctx) =>
      `${slot(ctx.file, "<file>")} was added, not changed — a new file needs an owner and doc attention: \`codument map materialize ${shellArg(slot(ctx.file, "<file>"))}\`, then narrate it (no ack applies)`,
    routes: (ctx) => [
      {
        label: "map it",
        segments: [
          cmd(`codument map materialize ${shellArg(slot(ctx.file, "<file>"))}`),
          dim("then narrate it"),
        ],
      },
    ],
  },

  // ── Pointer conditions: the map itself is false ───────────────────────
  "unmapped-source": {
    id: "unmapped-source",
    gates: true,
    fired: "a new source file has no owner",
    ackGrains: [],
    whyNoAck: () => "an unmapped file is not governed by anything an ack could clear — map it",
    routes: (ctx) => [
      {
        label: "map it",
        segments: [cmd(`codument map materialize ${shellArg(ctx.file ?? "<file>")}`)],
      },
    ],
  },

  "registry-pointer": {
    id: "registry-pointer",
    gates: true,
    fired: "a registry entry names a path this change removed or renamed",
    ackGrains: [],
    whyNoAck: () => "no ack applies: the pointer is simply false",
    routes: (ctx) =>
      ctx.renamedTo
        ? [
            {
              label: "fix",
              segments: [
                plain("replace it with"),
                cmd(ctx.renamedTo),
                plain(`in ${slot(ctx.where, "the entry")}`),
                dimRun(", or `codument map materialize` the new path and drop the old"),
              ],
            },
          ]
        : [
            {
              label: "fix",
              segments: [
                plain(`remove it from ${slot(ctx.where, "the entry")}`),
                dim("(a doc update for the removal is owed separately)"),
              ],
            },
          ],
  },

  "doc-pointer": {
    id: "doc-pointer",
    gates: true,
    fired: "a doc names a path this change removed or renamed",
    ackGrains: [],
    whyNoAck: () =>
      "no ack applies here either, and a doc that merely records the removal still sends its reader nowhere",
    routes: () => [
      {
        label: "fix",
        segments: [
          plain("name the path it moved to, or remove the mention"),
          dim("— a doc that only records the removal still points nowhere"),
        ],
      },
    ],
  },
};

/** The catalog, in a stable order, for the surfaces and for the battery. */
export const CONDITION_IDS: readonly ConditionId[] = Object.keys(CONDITIONS) as ConditionId[];

/** One condition's record. Total over the id union — there is no missing member. */
export function conditionFor(id: ConditionId): Condition {
  return CONDITIONS[id];
}

/**
 * The routes that clear a condition, rendered for this instance.
 *
 * Every routing surface calls this. A surface that formats its own sentence is
 * the defect, not a shortcut: the second sentence is what drifts.
 */
export function routesFor(id: ConditionId, ctx: ConditionContext = {}): Route[] {
  return CONDITIONS[id].routes(ctx);
}

/** Whether an acknowledgment of any grain reaches a condition. */
export function ackApplies(id: ConditionId): boolean {
  return CONDITIONS[id].ackGrains.length > 0;
}

/**
 * Whether one specific grain reaches a condition.
 *
 * The question `ack` actually asks, and the one a boolean could not answer: an
 * added export refuses the per-symbol grain and accepts the file grain, so
 * "does an ack apply" has two different right answers depending on what the
 * caller typed.
 */
export function ackAppliesAt(id: ConditionId, grain: AckGrain): boolean {
  return CONDITIONS[id].ackGrains.includes(grain);
}

/**
 * The sentence explaining why no ack reaches a condition.
 *
 * Read by `ack`'s refusal and by `review`'s replacement for the withheld ack
 * route — so the reason the command gives and the reason the report gives are
 * the same claim, not two claims that happen to agree today.
 */
export function whyNoAck(id: ConditionId, ctx: ConditionContext = {}): string | null {
  const c = CONDITIONS[id];
  return c.whyNoAck ? c.whyNoAck(ctx) : null;
}

/** A palette a surface supplies to render a route's segments in its own colors. */
export interface Palette {
  plain: (s: string) => string;
  cmd: (s: string) => string;
  dim: (s: string) => string;
}

/** The identity palette — plain text, for `--json`, tests, and non-tty output. */
export const PLAIN_PALETTE: Palette = {
  plain: (s) => s,
  cmd: (s) => s,
  dim: (s) => s,
};

/**
 * A context that makes every conditional route appear, for questions asked of the
 * catalog's SHAPE rather than of one instance — how wide the label column must be,
 * whether every member routes at all. Its values are placeholders on purpose: what
 * is asked here never depends on them, and a probe carrying plausible-looking data
 * invites someone to assert against it.
 */
const PROBE: ConditionContext = { claimants: 2 };

/**
 * The width the label column must be for a block that prints these conditions.
 *
 * Derived rather than declared, because a hand-written width is a number that has
 * to be revisited every time a label is added or renamed — and when it is not, the
 * block silently misaligns, which no test would ever fail on. The caller still owns
 * WHICH conditions share a block (a layout fact about that screen); it no longer
 * owns the arithmetic.
 */
export function labelWidth(...ids: ConditionId[]): number {
  return Math.max(
    0,
    ...ids.flatMap((id) => CONDITIONS[id].routes(PROBE).map((r) => r.label.length)),
  );
}

/** Render one route's segments with the caller's palette, honouring `glue`. */
export function renderRoute(route: Route, palette: Palette = PLAIN_PALETTE): string {
  return route.segments.reduce(
    (out, s, i) => out + (i > 0 && !s.glue ? " " : "") + palette[s.ink](s.text),
    "",
  );
}

/**
 * One route as a reader meets it: `label → route`, padded to a column.
 *
 * Shared rather than written per surface because the label column is the shape a
 * reader learns to scan, and it had already been written four times with two
 * different widths for the SAME pair of labels — a misalignment nobody would ever
 * see in a diff. `width` comes from `labelWidth` over whatever conditions share
 * the block; the palette is the surface's own.
 */
export function routeLine(route: Route, width: number, palette: Palette = PLAIN_PALETTE): string {
  return `${palette.dim(`${route.label.padEnd(width)} →`)} ${renderRoute(route, palette)}`;
}
