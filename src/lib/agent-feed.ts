import { homedir } from "node:os";
import { discoverSessionLogs } from "./claude-feed.js";
import { readEventLog, type EventLogRead } from "./events.js";
import { eventHost, isTokenEvent } from "./token-report.js";

export type AgentHost = "manual" | "claude" | "codex";
export type CaptureState = "available" | "empty" | "partial" | "unavailable" | "unsupported";

export interface HostCapture {
  host: AgentHost;
  state: CaptureState;
  sessions: number;
  capturedEvents: number;
  reasons: string[];
}

export interface CaptureReport {
  version: 1;
  ledger: { state: EventLogRead["state"]; skipped: number };
  hosts: HostCapture[];
  limitations: string[];
}

/** Read-only availability, distinct from the estimated cost of already captured counts. */
export function inspectAgentCapture(
  root: string,
  home = homedir(),
  ledger = readEventLog(root),
): CaptureReport {
  const counts: Record<AgentHost, number> = { manual: 0, claude: 0, codex: 0 };
  const invalidHosts = new Set<AgentHost>();
  for (const event of ledger.events) if (event.type === "tokens") {
    counts[eventHost(event)]++;
    if (!isTokenEvent(event)) invalidHosts.add(eventHost(event));
  }
  const discovery = discoverSessionLogs(root, home);
  const reasons: string[] = [];
  if (discovery.missing) reasons.push("session-directory-missing");
  if (discovery.unreadable) reasons.push("unreadable-session-input");
  if (discovery.unidentified) reasons.push("unidentified-repository-or-format");
  if (discovery.malformed) reasons.push("malformed-session-records");
  if (discovery.limited) reasons.push("inspection-limited");
  if (discovery.incompleteUsage) reasons.push("missing-or-invalid-source-usage");
  if (!discovery.sessions.length && !discovery.missing) reasons.push("no-matching-session");
  if (ledger.state === "partial" || ledger.state === "unavailable") reasons.push("ledger-incomplete");
  if (invalidHosts.has("claude")) reasons.push("invalid-token-record");
  let state: CaptureState = counts.claude ? "available" : "empty";
  if (discovery.missing || (discovery.unreadable && !discovery.sessions.length)) state = "unavailable";
  else if (discovery.unreadable || discovery.unidentified || discovery.malformed || discovery.limited || discovery.incompleteUsage ||
    (counts.claude > 0 && !discovery.sessions.length) || reasons.includes("ledger-incomplete") || invalidHosts.has("claude")) state = "partial";
  return {
    version: 1,
    ledger: { state: ledger.state, skipped: ledger.skipped },
    hosts: [
      { host: "manual", state: invalidHosts.has("manual") ? "partial" : ledger.state === "available" ? (counts.manual ? "available" : "empty") : ledger.state,
        sessions: 0, capturedEvents: counts.manual, reasons: ["self-reported-only", ...(invalidHosts.has("manual") ? ["invalid-token-record"] : [])] },
      { host: "claude", state, sessions: discovery.sessions.length, capturedEvents: counts.claude, reasons },
      { host: "codex", state: "unsupported", sessions: 0, capturedEvents: counts.codex, reasons: ["adapter-not-available"] },
    ],
    limitations: [
      "Availability describes local inputs, not complete usage or billing.",
      "Counts cover the captured ledger only; run feed to refresh it.",
      "Session discovery uses bounded reads of an internal, best-effort format.",
    ],
  };
}

export function renderCapture(capture: CaptureReport): string {
  return [
    `capture: ${capture.hosts.map(host => `${host.host} ${host.state}`).join(" · ")}`,
    ...capture.hosts.filter(host => host.reasons.length).map(host => `  ${host.host}: ${host.reasons.join(", ")}`),
    `  ledger ${capture.ledger.state}; availability does not establish complete usage.`,
  ].join("\n");
}
