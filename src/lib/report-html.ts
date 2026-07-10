import type { CoveringAck, ReviewReport } from "../commands/review.js";
import type { ImpactLedger } from "./impact-ledger.js";

// Self-contained HTML review report: inline CSS, no network, no JS (uses native
// <details> for the collapsible sections). Pure function of the data passed in,
// so the same change renders the same page. "Dark control room" theme — a
// high-contrast instrument readout: the verdict leads, the coverage ring is a
// secondary gauge, findings triage by severity, detail is tucked behind toggles.

export interface ReportData {
  review: ReviewReport;
  coveragePercent: number | null;
  previousPercent?: number | null;
  generatedAt: string;
  /** Optional "how this was produced" notes — set by `demo` to explain the sample repo. */
  demo?: DemoExplainer;
  /** Optional cumulative impact ledger (all sessions) — the "what codument caught" panel. */
  impact?: ImpactLedger;
}

/** A clickable explainer panel describing how a sample/demo report was produced. */
export interface DemoExplainer {
  intro: string;
  scenario: string;
  changeRows: { file: string; note: string }[];
  footnote: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chips(items: string[]): string {
  if (items.length === 0) return "";
  return `<div class="chips">${items
    .map((i) => `<span class="chip">${esc(i)}</span>`)
    .join("")}</div>`;
}

interface Card {
  level: "risk" | "warn" | "info";
  count: number;
  label: string;
  items: string[];
  explain: string;
}

const SEV: Record<Card["level"], { cls: string; lab: string }> = {
  risk: { cls: "s-risk", lab: "Risk" },
  warn: { cls: "s-warn", lab: "Warning" },
  info: { cls: "s-info", lab: "Info" },
};

export function renderReviewReportHtml(data: ReportData): string {
  const s = data.review.state;
  const cov = data.coveragePercent;
  const prev = data.previousPercent ?? null;
  const plan = data.review.plan;

  const cards: Card[] = [
    {
      level: "risk",
      count: s.riskTouches.length,
      label: "High-risk areas were touched",
      items: s.riskTouches.map((r) => `${r.feature} [${r.risk.join(", ")}]`),
      explain:
        "Registry entries can tag an area as high-risk (auth, data-loss, security…). When a change touches one of those files it's surfaced so a human looks before it ships.",
    },
    {
      level: "warn",
      count: s.staleDocs.length,
      label: "Docs went stale (code changed, the doc didn't)",
      items: s.staleDocs.map((d) => d.feature),
      explain:
        "Each changed source file is compared with the doc that owns it in the registry. If the code changed but its doc didn't, the doc is flagged stale — it may now describe behaviour that no longer exists.",
    },
    {
      level: "warn",
      count: s.unmapped.length,
      label: "Changed files have no documented owner",
      items: s.unmapped.map(short),
      explain:
        "Every changed file is looked up in docs/.registry.json. Files no feature lists are “unmapped” — Codument can't tell what they belong to or which doc should describe them.",
    },
    {
      level: "warn",
      count: plan ? s.outOfPlan.length : 0,
      label: plan
        ? `Changes outside the approved plan (${shortDoc(plan.plan)})`
        : "Changes outside the approved plan",
      items: s.outOfPlan.map(short),
      explain:
        "When an approved plan with a ## Scope section is present, every changed file outside that scope is listed. These are changes the plan didn't sign off on — scope creep, or a plan that needs updating.",
    },
    {
      level: "info",
      count: s.highFanout.length,
      label: "High-fanout files changed (shared by many features)",
      items: s.highFanout.map((f) => short(f.file)),
      explain:
        "A file referenced by many registry entries is high-fanout — lots of features lean on it, so a small edit here can ripple widely.",
    },
    {
      level: "info",
      count: s.dependents.length,
      label: "Dependent features may need re-review",
      items: dedupe(s.dependents.map((d) => d.feature)),
      explain:
        "Features can declare depends_on others. When a depended-on feature changes, its dependents are listed as possibly needing a re-check.",
    },
  ];

  const shown = cards.filter((c) => c.count > 0);
  const needsLook = cards.some((c) => c.level !== "info" && c.count > 0);
  const totalFindings = shown.reduce((a, c) => a + c.count, 0);

  const verdict = needsLook
    ? { cls: "warn", chip: "Needs review", title: "This change needs a look" }
    : { cls: "good", chip: "Clear", title: "Nothing suspicious — looks clean" };

  const delta = cov !== null && prev !== null && prev !== cov ? cov - prev : null;
  const signedDelta = delta === null ? "" : `(${delta > 0 ? "+" : "&minus;"}${Math.abs(delta)})`;

  // Coverage gauge — a conic ring whose colour tracks the level. N/A when null.
  const gaugeClass = cov === null ? "na" : covClass(cov);
  const ringColor =
    gaugeClass === "hi" ? "var(--good)" : gaugeClass === "mid" ? "var(--warn)" : "var(--risk)";
  const ringStyle =
    cov === null
      ? "background:#1c2740"
      : `background:conic-gradient(${ringColor} 0 ${cov}%,#1c2740 ${cov}% 100%)`;
  const pctInner = cov === null ? "N/A" : `${cov}<sup>%</sup>`;
  const wasHtml = prev !== null ? `<div class="was">was ${prev}%</div>` : "";

  const cardHtml = shown
    .map((c) => {
      const m = SEV[c.level];
      return `
      <div class="find ${m.cls}">
        <div class="frow">
          <div class="cnt">${c.count}</div>
          <div class="fbody">
            <div class="ftop"><span class="sev">${m.lab}</span><span class="flabel">${esc(c.label)}</span></div>
            ${chips(c.items)}
            <details class="exp"><summary>what this checks</summary><div class="why">${esc(c.explain)}</div></details>
          </div>
        </div>
      </div>`;
    })
    .join("");

  const findingsBody =
    cardHtml ||
    `<div class="find s-ok"><div class="frow"><div class="cnt">&check;</div><div class="fbody"><div class="ftop"><span class="sev">Clear</span><span class="flabel">No findings on this change.</span></div></div></div></div>`;

  const valueBlock = needsLook
    ? `
  <div class="value">
    <div class="vcard off"><div class="vk">Without codument</div><p>This diff merges with <b>none</b> of the findings below surfaced.</p></div>
    <div class="vcard on"><div class="vk">With codument</div><p>It flagged what to look at${
      delta !== null
        ? `. Coverage <code>${prev}% &rarr; ${cov}% ${signedDelta}</code> is the health gauge, not the verdict`
        : ""
    }.</p></div>
  </div>`
    : `<div class="clean-note"><span class="ok-dot"></span>Source and docs changed together, every change is owned, and nothing fell outside scope.</div>`;

  const demoHtml = data.demo ? renderDemo(data.demo) : "";
  const impactHtml = renderImpact(data.impact);
  const acksHtml = renderAcks(data.review.coveringAcks, data.review.requireIndependentAck === true);

  const byFeature = s.byFeature
    .map(
      (g) =>
        `<tr><td><b>${esc(g.feature)}</b></td><td>${g.files
          .map((f) => `<code>${esc(f)}</code>`)
          .join(" ")}</td></tr>`,
    )
    .join("");

  const detailRows = [
    detailList(
      "Stale docs",
      s.staleDocs.map((d) => `${d.feature} — ${d.doc}`),
    ),
    detailList("Unmapped changes", s.unmapped),
    detailList("Out-of-plan changes", plan ? s.outOfPlan : []),
    detailList(
      "High-risk touches",
      s.riskTouches.map((r) => `${r.feature} [${r.risk.join(", ")}] — ${r.files.join(", ")}`),
    ),
    detailList(
      "Dependents",
      s.dependents.map((d) => `${d.feature} (depends on ${d.dependsOn})`),
    ),
    detailList("Docs changed without source", s.docsChangedWithoutSource),
  ]
    .filter(Boolean)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codument — change review</title>
<style>
  :root{
    --bg:#0b0f17; --bg2:#0f1521; --surface:#131a28; --surface2:#172033;
    --line:#23304a; --line2:#2c3a58; --ink:#e8edf6; --ink2:#aab6cc; --ink3:#8493ad;
    --mono:ui-monospace,Menlo,"SFMono-Regular",Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --risk:#ff5d6c; --risk-bg:#2a121a; --risk-ln:#5a2330;
    --warn:#ffb454; --warn-bg:#2a1f0f; --warn-ln:#553c1a;
    --info:#5cc8ff; --info-bg:#0f2233; --info-ln:#1d4054;
    --good:#46e0a8; --good-bg:#0d1a16; --good-ln:#1d4c3a;
    --glow:0 0 22px;
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;
    -webkit-font-smoothing:antialiased;letter-spacing:.1px;
    background:radial-gradient(900px 500px at 18% -8%,#16213a 0,transparent 60%),
               radial-gradient(700px 460px at 100% 0,#161226 0,transparent 55%),var(--bg);}
  .wrap{max-width:820px;margin:0 auto;padding:32px 20px 56px}
  a{color:var(--info)}
  code{font-family:var(--mono)}

  /* header */
  .top{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;
    padding-bottom:16px;border-bottom:1px solid var(--line)}
  .brand{display:flex;align-items:center;gap:10px}
  .logo{font-family:var(--mono);font-weight:700;font-size:20px;letter-spacing:-.5px;color:var(--ink)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--good);box-shadow:var(--glow) var(--good)}
  .sub{font-family:var(--mono);font-size:12px;color:var(--ink3)}
  .sub b{color:var(--ink2);font-weight:600}
  .stamp{font-family:var(--mono);font-size:11px;color:var(--ink3);text-transform:uppercase;letter-spacing:1.4px}

  /* dashboard — verdict leads (left), gauge is the secondary readout (right) */
  .dash{display:grid;grid-template-columns:1fr 200px;gap:16px;margin-top:20px}
  .panel{background:linear-gradient(180deg,var(--surface),var(--bg2));border:1px solid var(--line);border-radius:14px;padding:20px}
  .verdict{display:flex;flex-direction:column;justify-content:center;border-left:3px solid var(--line)}
  .verdict.warn{border-left-color:var(--warn)}
  .verdict.good{border-left-color:var(--good)}
  .vchip{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;font-family:var(--mono);
    font-size:11px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;padding:5px 11px;border-radius:999px}
  .vchip .pip{width:7px;height:7px;border-radius:50%}
  .warn .vchip{color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-ln)}
  .warn .vchip .pip{background:var(--warn);box-shadow:var(--glow) var(--warn)}
  .good .vchip{color:var(--good);background:var(--good-bg);border:1px solid var(--good-ln)}
  .good .vchip .pip{background:var(--good);box-shadow:var(--glow) var(--good)}
  .vtitle{font-size:28px;font-weight:700;letter-spacing:-.4px;margin:14px 0 6px;line-height:1.18}
  .vmeta{font-family:var(--mono);font-size:13px;color:var(--ink2)}
  .vmeta b{color:var(--ink)}

  .gauge{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
  .gauge .lab{font-family:var(--mono);font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:var(--ink3)}
  .ring{position:relative;width:128px;height:128px;margin:12px 0 8px;border-radius:50%;
    box-shadow:inset 0 0 0 1px var(--line2)}
  .gauge.lo .ring{box-shadow:var(--glow) rgba(255,93,108,.30),inset 0 0 0 1px var(--line2)}
  .gauge.mid .ring{box-shadow:var(--glow) rgba(255,180,84,.30),inset 0 0 0 1px var(--line2)}
  .gauge.hi .ring{box-shadow:var(--glow) rgba(70,224,168,.30),inset 0 0 0 1px var(--line2)}
  .ring::after{content:"";position:absolute;inset:11px;border-radius:50%;background:var(--bg2);box-shadow:inset 0 0 22px rgba(0,0,0,.6)}
  .ring .num{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .pct{font-family:var(--mono);font-size:27px;font-weight:700}
  .pct sup{font-size:13px;font-weight:600;color:var(--ink2)}
  .gauge.lo .pct{color:#ff8a96;text-shadow:var(--glow) rgba(255,93,108,.45)}
  .gauge.mid .pct{color:#ffd089;text-shadow:var(--glow) rgba(255,180,84,.45)}
  .gauge.hi .pct{color:#7ef0c0;text-shadow:var(--glow) rgba(70,224,168,.45)}
  .gauge.na .pct{color:var(--ink3);font-size:22px}
  .was{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:2px}

  /* value framing */
  .value{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
  .vcard{border-radius:14px;padding:16px;border:1px solid var(--line)}
  .vcard.off{background:#10131b}
  .vcard.on{background:linear-gradient(180deg,#11261f,var(--good-bg));border-color:var(--good-ln)}
  .vk{font-family:var(--mono);font-size:11px;letter-spacing:1.6px;text-transform:uppercase;font-weight:700;
    display:flex;align-items:center;gap:7px;margin-bottom:8px}
  .off .vk{color:var(--ink3)} .off .vk::before{content:"";width:7px;height:7px;border-radius:50%;background:#39435a}
  .on .vk{color:var(--good)} .on .vk::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:var(--glow) var(--good)}
  .vcard p{margin:0;font-size:13px;color:var(--ink2);line-height:1.5}
  .vcard.on p{color:var(--ink)}
  .vcard code{font-size:12px;background:#06120d;color:var(--good);padding:1px 6px;border-radius:5px;border:1px solid var(--good-ln)}
  .clean-note{display:flex;align-items:center;gap:10px;margin-top:16px;padding:14px 16px;font-size:14px;color:var(--ink2);
    background:linear-gradient(180deg,#11261f,var(--good-bg));border:1px solid var(--good-ln);border-radius:14px}
  .ok-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--good);box-shadow:var(--glow) var(--good)}

  /* section heading */
  .shead{display:flex;align-items:center;gap:12px;margin:32px 0 16px}
  .shead h2{font-family:var(--mono);font-size:12px;letter-spacing:2px;text-transform:uppercase;color:var(--ink2);margin:0;white-space:nowrap;font-weight:700}
  .shead .ln{height:1px;background:linear-gradient(90deg,var(--line2),transparent);flex:1}

  /* findings */
  .find{background:var(--surface);border:1px solid var(--line);border-left-width:3px;border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .find.s-risk{border-left-color:var(--risk)} .find.s-warn{border-left-color:var(--warn)}
  .find.s-info{border-left-color:var(--info)} .find.s-ok{border-left-color:var(--good)}
  .frow{display:flex;align-items:flex-start;gap:16px}
  .cnt{flex:none;width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;
    font-family:var(--mono);font-size:20px;font-weight:700;border:1px solid}
  .s-risk .cnt{color:var(--risk);background:var(--risk-bg);border-color:var(--risk-ln)}
  .s-warn .cnt{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-ln)}
  .s-info .cnt{color:var(--info);background:var(--info-bg);border-color:var(--info-ln)}
  .s-ok .cnt{color:var(--good);background:var(--good-bg);border-color:var(--good-ln);font-size:18px}
  .fbody{flex:1;min-width:0}
  .ftop{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .sev{font-family:var(--mono);font-size:10px;letter-spacing:1.3px;text-transform:uppercase;font-weight:700;padding:2px 7px;border-radius:5px;border:1px solid}
  .s-risk .sev{color:var(--risk);border-color:var(--risk-ln);background:var(--risk-bg)}
  .s-warn .sev{color:var(--warn);border-color:var(--warn-ln);background:var(--warn-bg)}
  .s-info .sev{color:var(--info);border-color:var(--info-ln);background:var(--info-bg)}
  .s-ok .sev{color:var(--good);border-color:var(--good-ln);background:var(--good-bg)}
  .flabel{font-size:14px;font-weight:600;color:var(--ink);line-height:1.35}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
  .chip{font-family:var(--mono);font-size:12px;color:var(--ink2);background:var(--surface2);border:1px solid var(--line2);padding:2px 9px;border-radius:6px}
  .s-risk .chip{border-color:var(--risk-ln);background:#1c0e13}
  details.exp{margin-top:9px}
  details.exp>summary{font-family:var(--mono);font-size:11px;color:var(--ink3);cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;letter-spacing:.4px}
  details.exp>summary::-webkit-details-marker{display:none}
  details.exp>summary::before{content:"+";font-weight:700}
  details.exp[open]>summary::before{content:"\\2013"}
  details.exp>summary:hover{color:var(--ink2)}
  details.exp .why{font-size:13px;color:var(--ink2);margin-top:7px;padding-left:14px;border-left:1px solid var(--line2);line-height:1.5}

  /* caught (impact ledger) */
  .impact{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:6px 18px 14px}
  .iline{display:flex;gap:14px;align-items:baseline;padding:11px 0}
  .iline+.iline{border-top:1px solid var(--line)}
  .ik{font-family:var(--mono);font-size:10px;letter-spacing:1.3px;text-transform:uppercase;font-weight:700;padding:3px 0;border-radius:6px;flex:none;width:82px;text-align:center}
  .ik.prov{color:var(--good);background:var(--good-bg);border:1px solid var(--good-ln)}
  .ik.rep{color:var(--info);background:var(--info-bg);border:1px solid var(--info-ln)}
  .iv{color:var(--ink);font-size:14px}
  .iv .self{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-left:8px}
  .ifoot{font-family:var(--mono);font-size:11px;color:var(--ink3);margin:12px 0 2px;line-height:1.6}
  .ifoot b{color:var(--ink2)}

  /* acknowledgments in this change */
  .acks{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:8px 18px 12px}
  .akhead{font-family:var(--mono);font-size:11px;letter-spacing:.6px;color:var(--ink3);padding:8px 0 4px}
  .akrow{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:9px 0;font-size:14px}
  .akrow+.akrow{border-top:1px solid var(--line)}
  .akrow code{font-family:var(--mono);font-size:12.5px;color:var(--ink);background:var(--bg2);border:1px solid var(--line2);padding:1px 7px;border-radius:5px}
  .akg{font-family:var(--mono);font-size:10px;color:var(--ink3)}
  .akb{font-family:var(--mono);font-size:10px;letter-spacing:.8px;text-transform:uppercase;font-weight:700;padding:2px 7px;border-radius:5px;flex:none}
  .akb.self{color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-ln)}
  .akb.ind{color:var(--good);background:var(--good-bg);border:1px solid var(--good-ln)}
  .akb.ignored{color:var(--risk);background:var(--risk-bg);border:1px solid var(--risk-ln)}
  .aksig{font-family:var(--mono);font-size:11px;color:var(--ink3)}
  .akrs{color:var(--ink2);flex:1 1 240px;min-width:0}

  /* collapsible detail blocks */
  details.block{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin-bottom:12px;overflow:hidden}
  details.block>summary{cursor:pointer;list-style:none;padding:15px 18px;display:flex;align-items:center;gap:11px;font-weight:600;font-size:14px;color:var(--ink)}
  details.block>summary::-webkit-details-marker{display:none}
  details.block>summary .ic{font-family:var(--mono);color:var(--info);font-weight:700;font-size:13px;transition:transform .15s}
  details.block[open]>summary .ic{transform:rotate(90deg)}
  details.block>summary .sd{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-left:auto;font-weight:400}
  details.block .inner{padding:4px 18px 18px;border-top:1px solid var(--line)}
  details.block .inner>p{font-size:13px;color:var(--ink2);margin:13px 0}
  .scn{font-size:13px;color:var(--ink2);background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:12px 14px;margin:13px 0}
  .scn b{color:var(--ink)}
  .foot-note{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:13px;line-height:1.55}
  table{width:100%;border-collapse:collapse;margin:8px 0 2px;font-size:13px}
  th{text-align:left;font-family:var(--mono);font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--ink3);font-weight:700;padding:8px 10px;border-bottom:1px solid var(--line2)}
  td{padding:9px 10px;border-bottom:1px solid var(--line);color:var(--ink2);vertical-align:top}
  tr:last-child td{border-bottom:none}
  td code{font-size:12px;color:var(--info)} td b{color:var(--ink)}
  .feat h4{font-family:var(--mono);font-size:12px;color:var(--ink);margin:16px 0 6px;letter-spacing:.5px}
  .feat ul{margin:0 0 4px;padding-left:18px;color:var(--ink2);font-size:13px}
  .feat li{margin:3px 0}

  footer{margin-top:30px;padding-top:18px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--ink3);line-height:1.7}
  footer .strong{color:var(--ink2)}
  @media (max-width:640px){.dash{grid-template-columns:1fr}.gauge{flex-direction:row;justify-content:flex-start;gap:18px;text-align:left}.value{grid-template-columns:1fr}.vtitle{font-size:23px}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand"><span class="dot"></span><span class="logo">codument</span></div>
    <span class="sub">change review${plan ? ` &middot; plan: <b>${esc(shortDoc(plan.plan))}</b>` : ""}</span>
    <span class="stamp">Health Monitor</span>
  </header>

  <section class="dash">
    <div class="panel verdict ${verdict.cls}">
      <span class="vchip"><span class="pip"></span>${verdict.chip}</span>
      <h1 class="vtitle">${verdict.title}</h1>
      <div class="vmeta"><b>${data.review.changedFileCount}</b> changed file${
        data.review.changedFileCount === 1 ? "" : "s"
      }${needsLook ? ` &middot; <b>${totalFindings}</b> finding${totalFindings === 1 ? "" : "s"}` : ""}</div>
    </div>
    <div class="panel gauge ${gaugeClass}">
      <div class="lab">Coverage</div>
      <div class="ring" style="${ringStyle}"><div class="num"><div class="pct">${pctInner}</div>${wasHtml}</div></div>
    </div>
  </section>

  ${valueBlock}

  <div class="shead"><h2>Findings</h2><span class="ln"></span></div>
  ${findingsBody}

  ${impactHtml}

  ${acksHtml}

  <div class="shead"><h2>Details</h2><span class="ln"></span></div>
  ${demoHtml}
  <details class="block">
    <summary><span class="ic">&#9656;</span>Changed files &amp; full breakdown<span class="sd">${data.review.changedFileCount} file${data.review.changedFileCount === 1 ? "" : "s"}</span></summary>
    <div class="inner">
      <table><thead><tr><th>Feature</th><th>Files</th></tr></thead><tbody>${
        byFeature || '<tr><td colspan="2">No owned changes.</td></tr>'
      }</tbody></table>
      ${detailRows ? `<div class="feat">${detailRows}</div>` : ""}
    </div>
  </details>

  <footer>
    Generated from repo state &middot; ${esc(data.generatedAt)} &middot; Deterministic &middot; no network &middot; no AI model.<br>
    <span class="strong">Reports facts and gaps — it does not certify the change is safe.</span>
  </footer>
</div>
</body>
</html>
`;
}

/** Cumulative "what codument caught on this project" panel — provable line leads,
 *  agent-self-reported line labeled. Empty string when there is nothing to show. */
function renderImpact(impact?: ImpactLedger): string {
  if (!impact || (!impact.hasProvable && !impact.hasReported)) return "";
  const rows: string[] = [];
  if (impact.hasProvable) {
    const p = impact.provable;
    const parts: string[] = [];
    if (p.staleDocs > 0)
      parts.push(`${p.staleDocs} stale ${p.staleDocs === 1 ? "doc" : "docs"} flagged`);
    if (p.riskTouches > 0)
      parts.push(`${p.riskTouches} high-risk ${p.riskTouches === 1 ? "touch" : "touches"}`);
    if (p.offPlan > 0)
      parts.push(`${p.offPlan} off-plan ${p.offPlan === 1 ? "change" : "changes"}`);
    rows.push(
      `<div class="iline"><span class="ik prov">Provable</span><span class="iv">${esc(parts.join(" · "))}</span></div>`,
    );
  }
  if (impact.hasReported) {
    const r = impact.reported;
    let main = `${r.headline} review ${r.headline === 1 ? "issue" : "issues"} fixed before commit`;
    if (r.fixed.minor > 0) main += ` · +${r.fixed.minor} minor`;
    rows.push(
      `<div class="iline"><span class="ik rep">Reported</span><span class="iv">${esc(main)}<span class="self">agent self-reported · correctness</span></span></div>`,
    );
  }
  return `
  <div class="shead"><h2>Caught across this project</h2><span class="ln"></span></div>
  <div class="impact">
    ${rows.join("\n    ")}
    <p class="ifoot"><b>Provable</b> — what codument's analyzer caught, deterministic. <b>Reported</b> — findings the agent fixed before commit, self-reported. Cumulative across all sessions.</p>
  </div>`;
}

/** The "Acknowledgments in this change" audit card — every covering ack on one line,
 *  badged self vs independent of the change author, so self-review is visible and
 *  over-acking is loud. Empty string when the change set carries no covering ack. */
function renderAcks(acks: CoveringAck[] | undefined, requireIndependentAck = false): string {
  if (!acks || acks.length === 0) return "";
  const selfCount = acks.filter((a) => !a.independent).length;
  const ignored = requireIndependentAck ? selfCount : 0;
  const rows = acks
    .map((a) => {
      // Under --require-independent-ack a self ack did not clear its finding — badge
      // it ignored (red) so a rejected self-review is visible, not silently dropped.
      const isIgnored = requireIndependentAck && !a.independent;
      const badge = a.independent
        ? `<span class="akb ind">independent</span>`
        : isIgnored
          ? `<span class="akb ignored">self &middot; not counted</span>`
          : `<span class="akb self">self</span>`;
      const target =
        a.grain === "file"
          ? `<code>${esc(a.anchorId)}</code> <span class="akg">file</span>`
          : `<code>${esc(a.symbol ?? a.anchorId)}</code>`;
      return `<div class="akrow">${target} ${badge} <span class="aksig">${esc(a.signer)}</span> <span class="akrs">${esc(a.reason)}</span></div>`;
    })
    .join("\n    ");
  const head =
    ignored > 0
      ? `${acks.length} covering &middot; ${ignored} self-ack${ignored === 1 ? "" : "s"} not counted (--require-independent-ack) &middot; ${acks.length - selfCount} independent`
      : `${acks.length} covering &middot; ${selfCount} self-adjudicated &middot; ${acks.length - selfCount} independent`;
  return `
  <div class="shead"><h2>Acknowledgments in this change</h2><span class="ln"></span></div>
  <div class="acks">
    <div class="akhead">${head}</div>
    ${rows}
  </div>`;
}

function renderDemo(d: DemoExplainer): string {
  const rows = d.changeRows
    .map((r) => `<tr><td><code>${esc(r.file)}</code></td><td>${esc(r.note)}</td></tr>`)
    .join("");
  return `
  <details class="block">
    <summary><span class="ic">&#9656;</span>How this demo works<span class="sd">sample &middot; offline &middot; deterministic</span></summary>
    <div class="inner">
      <p>${esc(d.intro)}</p>
      <div class="scn"><b>Scenario:</b> ${esc(d.scenario)}</div>
      <table><thead><tr><th>File</th><th>Why it's flagged</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="foot-note">${esc(d.footnote)}</p>
    </div>
  </details>`;
}

function detailList(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `<h4>${esc(title)}</h4><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function short(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : path;
}

function shortDoc(path: string): string {
  return path.replace(/^docs\/plans\//, "");
}

function covClass(percent: number): string {
  if (percent >= 90) return "hi";
  if (percent >= 70) return "mid";
  return "lo";
}
