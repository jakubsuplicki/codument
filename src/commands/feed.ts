import { inspectAgentCapture, pumpAgentFeed, renderCapture } from "../lib/agent-feed.js";

interface FeedOptions {
  root?: string;
  dir?: string;
  once?: boolean;
  interval?: string | number;
  reset?: boolean;
  backfill?: boolean;
  status?: boolean;
  json?: boolean;
  input?: string;
}

/** Capture local host usage without running or configuring either agent. */
export async function feed(options: FeedOptions = {}): Promise<void> {
  const root = options.root ?? options.dir ?? process.cwd();
  const error = (message: string) => {
    console.log(options.json ? JSON.stringify({ error: message }) : message);
    process.exitCode = 1;
  };
  if (options.status) {
    if (options.once || options.backfill || options.reset) {
      error("feed --status is read-only; choose a capture action separately.");
      return;
    }
    const capture = inspectAgentCapture(root, undefined, undefined, options.input);
    console.log(options.json ? JSON.stringify(capture, null, 2) : renderCapture(capture));
    return;
  }
  if (options.json && !(options.once || options.backfill || options.reset || options.input)) {
    error("Use --once, --backfill, --reset, --input or --status with --json.");
    return;
  }
  const pump = () => pumpAgentFeed(root, options);
  const show = (result: ReturnType<typeof pump>) => {
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log("codument feed: captured " + result.emitted + " events from " + result.sessions + " local inputs.");
      for (const host of result.hosts) if (host.reasons.length) console.log("  " + host.host + ": " + host.reasons.join(", "));
      console.log("  Captured counts are not complete usage or billing. Use feed --status for availability.");
    }
  };
  const first = pump();
  show(first);
  if (first.sessions === 0) {
    if (!options.json) console.log("  No matching session input; an explicit Codex JSON file needs a session_meta header with its run id and absolute cwd.");
    process.exitCode = 1;
    return;
  }
  if (options.once || options.reset || options.backfill || options.input) return;
  const timer = setInterval(() => {
    const result = pump();
    if (result.emitted || result.hosts.some(host => host.reasons.some(reason => reason !== "session-directory-missing"))) show(result);
  }, Math.max(250, Number(options.interval) || 1000));
  const stop = () => { clearInterval(timer); process.stdout.write("\n"); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
