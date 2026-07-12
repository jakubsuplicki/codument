import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Anchor } from "../src/lib/fingerprint.js";
import { classifySfcFile, sfcAdapter } from "../src/lib/sfc-adapter.js";
import { type AdapterHarness, checkAdapterConformance } from "./adapter-conformance.js";

const V = "components/Hero.vue";

// A plain (non-setup) script keeps normal export semantics, so the shared
// battery's helper-closure behavior is exercisable through delegation.
const BASE = `<template>
  <div class="hero">
    <!-- headline -->
    <h1>{{ title() }}</h1>
  </div>
</template>

<script lang="ts">
import { format } from "./format";

function clamp(n: number): number {
  return n < 0 ? 0 : n;
}

export function area(w: number, h: number): number {
  return clamp(w * h);
}

export function perimeter(w: number, h: number): number {
  return 2 * (w + h);
}
</script>

<style scoped>
.hero { color: red; }
</style>
`;

function anchors(content: string, path = V): Anchor[] {
  return sfcAdapter.anchors(path, content);
}

function named(as: Anchor[], name: string): Anchor | undefined {
  return as.find((a) => a.name === name);
}

describe("sfc scanner + delegation", () => {
  it("matches .vue/.svelte/.astro, nothing else", () => {
    assert.ok(sfcAdapter.matches("a/Hero.vue"));
    assert.ok(sfcAdapter.matches("a/Card.svelte"));
    assert.ok(sfcAdapter.matches("a/Page.astro"));
    assert.ok(!sfcAdapter.matches("a/hero.ts"));
    assert.ok(!sfcAdapter.matches("a/hero.css"));
  });

  it("script symbols are per-symbol anchors keyed on the SFC path", () => {
    const as = anchors(BASE);
    assert.equal(named(as, "area")?.id, `${V}::area().`);
    assert.ok(named(as, "area")?.signature, "delegated anchors carry the signature split");
    assert.equal(named(as, "clamp"), undefined, "a private helper is not anchored");
  });

  it("the delegated engine's split holds: body edit ackable, signature edit contract, helper closure live", () => {
    const base = anchors(BASE);
    const bodyEdit = anchors(BASE.replace("return 2 * (w + h);", "return (w + h) * 2;"));
    assert.notEqual(named(bodyEdit, "perimeter")?.fingerprint, named(base, "perimeter")?.fingerprint);
    assert.equal(named(bodyEdit, "perimeter")?.signature, named(base, "perimeter")?.signature);
    const sigEdit = anchors(BASE.replace("perimeter(w: number, h: number)", "perimeter(w: number, h: number, pad = 0)"));
    assert.notEqual(named(sigEdit, "perimeter")?.signature, named(base, "perimeter")?.signature);
    const helperEdit = anchors(BASE.replace("n < 0", "n <= 0"));
    assert.notEqual(named(helperEdit, "area")?.fingerprint, named(base, "area")?.fingerprint);
    assert.equal(named(helperEdit, "perimeter")?.fingerprint, named(base, "perimeter")?.fingerprint);
  });

  it("<script setup>: top-level declarations ARE the public surface", () => {
    const setup = `<script setup lang="ts">
const title = "hello";
function rotateToken(): string {
  return title;
}
</script>

<template><p>{{ rotateToken() }}</p></template>
`;
    const as = anchors(setup);
    assert.ok(named(as, "title"), "unexported const is the component surface");
    assert.equal(named(as, "rotateToken")?.id, `${V}::rotateToken().`);
  });

  it("multiple script blocks fold into one extraction in source order", () => {
    const two = `<script>
export default { name: "Hero" };
</script>
<script setup lang="ts">
const state = 1;
</script>
<template><p/></template>
`;
    const as = anchors(two);
    assert.ok(named(as, "default"), "plain script's default export anchors");
    assert.ok(named(as, "state"), "setup block's surface anchors (all-public wins ties)");
  });

  it("svelte: instance script is all-public and the loose markup is the template", () => {
    const svelte = `<script>
  export let name;
  let count = 0;
</script>

<button on:click={() => count++}>{name}: {count}</button>

<style>
  button { color: blue; }
</style>
`;
    const as = anchors(svelte, "lib/Counter.svelte");
    assert.ok(named(as, "name"));
    assert.ok(named(as, "count"), "unexported state is still the component surface");
    assert.ok(named(as, "template"), "loose markup is the template pseudo-anchor");
    assert.ok(named(as, "style"));
  });

  it("astro: the frontmatter fence is the script; the rest is the template", () => {
    const astro = `---
const posts = await fetchPosts();
---
<ul>{posts.map((p) => <li>{p.title}</li>)}</ul>
`;
    const as = anchors(astro, "src/pages/Index.astro");
    assert.ok(named(as, "posts"), "frontmatter declarations anchor all-public");
    assert.ok(named(as, "template"));
  });

  it("a file the scanner cannot segment classifies unevaluable — never guessed", () => {
    // Unclosed top-level blocks and an unterminated frontmatter fence. (An
    // unclosed element INSIDE a template is opaque block content, not a
    // segmentation failure — blocks are regions, not parsed markup.)
    assert.equal(classifySfcFile(V, "<template><div></div>\n").mode, "unevaluable");
    assert.equal(classifySfcFile(V, "<script>\nconst x = 1;\n").mode, "unevaluable");
    assert.equal(
      classifySfcFile("p/Index.astro", "---\nconst x = 1;\n<ul></ul>\n").mode,
      "unevaluable",
    );
  });

  it("a parse-broken script block classifies unevaluable through delegation", () => {
    const broken = `<script lang="ts">
export function broken( {
</script>
<template><p/></template>
`;
    assert.equal(classifySfcFile(V, broken).mode, "unevaluable");
  });

  it("classification: any component part is precise; an empty shell is coarse", () => {
    assert.equal(classifySfcFile(V, BASE).mode, "precise");
    assert.equal(classifySfcFile(V, "<!-- nothing yet -->\n").mode, "coarse");
  });
});

describe("sfc pseudo-anchors (template./style.)", () => {
  it("markup trivia never fires: comments and inter-tag whitespace fold away", () => {
    const reformatted = BASE.replace("<!-- headline -->", "<!-- reworded comment -->")
      .replace("<div class=\"hero\">\n    <h1>", "<div class=\"hero\">\n\n      <h1>");
    const a = anchors(BASE);
    const b = anchors(reformatted);
    assert.equal(named(b, "template")?.fingerprint, named(a, "template")?.fingerprint);
  });

  it("a real template edit moves ONLY the template pseudo-anchor, body-grain (ackable)", () => {
    const a = anchors(BASE);
    const b = anchors(BASE.replace("{{ title() }}", "{{ headline() }}"));
    const moved = named(b, "template");
    assert.notEqual(moved?.fingerprint, named(a, "template")?.fingerprint);
    assert.equal(moved?.signature, undefined, "pseudo-anchors are body-only — always ackable");
    for (const keep of ["area", "perimeter", "style"]) {
      assert.equal(named(b, keep)?.fingerprint, named(a, keep)?.fingerprint, `${keep} must hold`);
    }
  });

  it("a style edit moves ONLY the style pseudo-anchor; CSS comments and formatting are trivia", () => {
    const a = anchors(BASE);
    const b = anchors(BASE.replace("color: red;", "color: green;"));
    assert.notEqual(named(b, "style")?.fingerprint, named(a, "style")?.fingerprint);
    assert.equal(named(b, "template")?.fingerprint, named(a, "template")?.fingerprint);
    const c = anchors(BASE.replace(".hero { color: red; }", "/* brand */ .hero {\n  color: red;\n}"));
    assert.equal(named(c, "style")?.fingerprint, named(a, "style")?.fingerprint);
  });

  it("a vue custom block rides the residual — never silent", () => {
    const withCustom = BASE + "\n<i18n>\n{ \"en\": { \"hi\": \"Hi\" } }\n</i18n>\n";
    const a = anchors(withCustom);
    const moduleAnchor = a.find((x) => x.kind === "module");
    assert.ok(moduleAnchor, "custom block must produce a residual");
    const edited = anchors(withCustom.replace("\"Hi\"", "\"Hello\""));
    assert.notEqual(
      edited.find((x) => x.kind === "module")?.fingerprint,
      moduleAnchor?.fingerprint,
    );
  });
});

describe("sfc conformance battery — full, through delegation", () => {
  it("the SFC adapter passes all eight behaviors on a plain-script component", () => {
    const harness: AdapterHarness = {
      adapter: sfcAdapter,
      classify: (path, content) => classifySfcFile(path, content).mode,
      fixtures: {
        path: V,
        base: BASE,
        formatted: BASE.replace("<!-- headline -->", "<!-- reworded -->").replace(
          "function clamp(n: number): number {",
          "function clamp(n: number): number { // inline note",
        ),
        bodyEdit: {
          symbol: "perimeter",
          content: BASE.replace("return 2 * (w + h);", "return (w + h) * 2;"),
        },
        signatureEdit: {
          symbol: "perimeter",
          content: BASE.replace(
            "perimeter(w: number, h: number): number {",
            "perimeter(w: number, h: number, pad = 0): number {",
          ),
        },
        helperEdit: {
          symbol: "area",
          content: BASE.replace("return n < 0 ? 0 : n;", "return n <= 0 ? 0 : n;"),
        },
        residualEdit: BASE.replace('import { format } from "./format";', 'import { format, pad } from "./format";'),
        reordered: BASE.replace(
          "export function area(w: number, h: number): number {\n  return clamp(w * h);\n}\n\nexport function perimeter(w: number, h: number): number {\n  return 2 * (w + h);\n}",
          "export function perimeter(w: number, h: number): number {\n  return 2 * (w + h);\n}\n\nexport function area(w: number, h: number): number {\n  return clamp(w * h);\n}",
        ),
        parseError: "<template><div></div>\n",
      },
    };
    assert.deepEqual(checkAdapterConformance(harness), []);
  });
});
