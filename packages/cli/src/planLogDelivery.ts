// The delivery half of the shared-log messaging policy (messagingPolicy.ts,
// docs/architecture/agent-comms.md): after a `cast` command an agent session
// runs, the entries of its plan's log that are new to it ride along under the
// command's output, once. The server keeps the per-session cursor
// (convex/planLog.ts); this side only asks and prints.
//
// Rides along with another command's output, so it is silent on every failure
// and never turns that command into an error.

import * as fs from "node:fs";
import * as path from "node:path";
import { FOREIGN_TEXT_CAPS, fenceForeignText, inlineForeignText } from "@codecast/shared/contracts";
import { foreignProse } from "@codecast/shared/tasks";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";

export type LogEntry = { type: string; content: string; author?: string; session?: string; title?: string; timestamp: number };

/** The commands that never carry the log: the daemon's own, auth, the hooks, and
 *  the ones that end a turn, where a delivery would move the cursor and be lost. */
const SKIP_COMMANDS = new Set(["start", "stop", "status", "daemon", "codecast", "_daemon", "_watchdog", "auth", "login", "update", "agent-context", "stable-context", "state", "handoff", "task handoff"]);

/** Under the backend's wait note (cliHttp.ts WAIT_NOTE_MS): a slow backend never holds up the command. */
export const LOG_TIMEOUT_MS = 2_500;

/** How long a session with no shared-log plan is not asked again.
 *  ponytail: a session bound to a shared-log plan by another process waits up
 *  to this long for its first delivery; any `cast plan` command asks at once. */
export const NO_LOG_RECHECK_MS = 5 * 60_000;

export function formatLogEntries(planShortId: string | undefined, entries: LogEntry[]): string {
  const head = fmt.muted(`shared log${planShortId ? ` of ${planShortId}` : ""}, ${entries.length} new:`);
  // Another agent wrote each entry: escaped and capped the way `cast plan show`
  // renders a plan comment (planForeignText.ts), so it cannot repaint the terminal.
  const lines = entries.map((e) => {
    const [first, ...rest] = (foreignProse(e.content, FOREIGN_TEXT_CAPS.commentChars) ?? "").split("\n");
    const from = [inlineForeignText(e.author), e.session && `session ${inlineForeignText(e.session)}`, e.title && `"${inlineForeignText(e.title).slice(0, 60)}"`].filter(Boolean).join(", ");
    return [`[${inlineForeignText(e.type)}]${from ? ` ${from}:` : ""} ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
  });
  // Other agents' words, fenced the way `cast plan show` fences them, so an
  // instruction inside an entry reads as quoted data.
  return `${head}\n${fenceForeignText(lines.join("\n"), `plan ${planShortId ?? ""} shared log`)}`;
}

export type DeliverOpts = {
  /** The command path under `cast` (`plan`, `task handoff`, `send`, ...). */
  command: string;
  /** The command was asked for machine-readable output: nothing may follow it. */
  json: boolean;
  /** The calling agent session, from its env only: a person's shell has none and pays nothing. */
  sessionId: string | null;
  /** Where the "no log for this session" marks live. */
  stateDir: string;
  now?: number;
  print?: (text: string) => void;
};

export async function deliverPlanLog(deps: Pick<PublishDeps, "getCliEndpoint">, opts: DeliverOpts): Promise<void> {
  // stderr: an agent's tool shows it, and `$(cast ...)` never captures it.
  const { command, json, sessionId, stateDir, now = Date.now(), print = (t) => process.stderr.write(`${t}\n`) } = opts;
  const top = command.split(" ")[0];
  if (!sessionId || json || SKIP_COMMANDS.has(top) || SKIP_COMMANDS.has(command) || top.startsWith("_")) return;
  try {
    const mark = path.join(stateDir, `plan-log-none-${sessionId.replace(/[^\w.-]/g, "_")}`);
    if (top !== "plan") {
      try {
        if (now - fs.statSync(mark).mtimeMs < NO_LOG_RECHECK_MS) return;
      } catch {}
    }
    const res = await apiPost(deps as PublishDeps, "/cli/plans/log/unread", { session_id: sessionId }, { exitOnError: false, timeoutMs: LOG_TIMEOUT_MS })
      .catch(() => null);
    if (!res?.plan_short_id) {
      // No plan, a plan on another policy, or a backend that is down, slow or
      // older than this route: skip the round-trip for a while.
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(mark, "");
      return;
    }
    fs.rmSync(mark, { force: true });
    const entries: LogEntry[] = Array.isArray(res.entries) ? res.entries : [];
    if (entries.length) print(`\n${formatLogEntries(res.plan_short_id, entries)}`);
  } catch {}
}
