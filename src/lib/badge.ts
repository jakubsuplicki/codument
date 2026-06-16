// Hand-rolled, no-network coverage badge (flat style, shields-like). Pure and
// deterministic: the same percent always renders byte-identical SVG. No external
// package — a static SVG string is all a README needs.

const COLORS = {
  na: "#9f9f9f",
  red: "#e05d44",
  yellow: "#dfb317",
  yellowgreen: "#97ca00",
  green: "#4c1",
};

function colorFor(percent: number | null): string {
  if (percent === null) return COLORS.na;
  if (percent < 50) return COLORS.red;
  if (percent < 70) return COLORS.yellow;
  if (percent < 90) return COLORS.yellowgreen;
  return COLORS.green;
}

// Rough monospace-ish width estimate so the two pills fit their text. Fixed
// per-character width keeps rendering deterministic without measuring fonts.
function textWidth(text: string): number {
  return text.length * 7 + 10;
}

/**
 * Render a flat coverage badge. `percent` of null renders an "N/A" value pill
 * (the degraded/no-applicable-ratio state), never a misleading 0%.
 */
export function renderCoverageBadge(
  percent: number | null,
  label = "docs coverage",
): string {
  const value = percent === null ? "N/A" : `${percent}%`;
  const color = colorFor(percent);
  const labelW = textWidth(label);
  const valueW = textWidth(value);
  const total = labelW + valueW;
  const labelX = labelW / 2;
  const valueX = labelW + valueW / 2;
  const aria = `${label}: ${value}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${aria}">`,
    `<title>${aria}</title>`,
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
    `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${labelW}" height="20" fill="#555"/>`,
    `<rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>`,
    `<rect width="${total}" height="20" fill="url(#s)"/>`,
    `</g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${label}</text>`,
    `<text x="${labelX}" y="14">${label}</text>`,
    `<text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${value}</text>`,
    `<text x="${valueX}" y="14">${value}</text>`,
    `</g>`,
    `</svg>`,
    "",
  ].join("\n");
}
