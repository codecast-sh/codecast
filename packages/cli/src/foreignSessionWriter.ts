/**
 * Is another program already running this session? A session Codecast lists
 * but did not start (another app's agent runner, a person's own terminal) is
 * resumed in a Codecast tmux to deliver a message. If the other program's
 * agent is still alive, that resume starts a second process appending to the
 * same transcript, and the app that owns the session can no longer run it
 * (GitHub #88). The delivery path missed those processes: its lookup skips a
 * process with no terminal (an app's headless agent has none) and reads only
 * `--resume <id>`, not `--resume=<id>` or `--session-id <id>`.
 *
 * Proof here is the process's own command line naming the session, so the
 * answer is never a guess from timing or the working directory. Processes
 * Codecast runs itself (its tmux servers, its Claude SDK hosts, the daemon)
 * are not foreign: the delivery path reaches those directly.
 */

import { agentBinaryFromPsRow, argvSessionId, collectAncestorPids } from "./sessionProcessMatcher.js";
import { SESSION_SOCKET_PREFIX } from "./tmuxRoute.js";

export interface PsRow {
  pid: number;
  ppid: number;
  tty: string;
  args: string;
}

/** The ps arguments parsePsRows reads: every process, full command lines. */
export const PS_ROWS_ARGS = ["-axww", "-o", "pid=,ppid=,tty=,args="];

export function parsePsRows(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], args: m[4].trim() });
  }
  return rows;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A Codecast pane lives on a per-session tmux server (`tmux -L cast-…`); the
// SDK backend runs its agent under `_claude-sdk-host`.
const OWN_RUNNER = new RegExp(`(?:^|/)tmux\\s.*-L\\s*${escapeRe(SESSION_SOCKET_PREFIX)}|\\s_claude-sdk-host(?:\\s|$)`);

/** The live agent process outside Codecast that runs `sessionId`, or null. */
export function foreignSessionWriter(rows: PsRow[], sessionId: string, daemonPid: number): PsRow | null {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const ppids = new Map(rows.map((r) => [r.pid, r.ppid]));
  for (const row of rows) {
    if (row.pid === daemonPid || !agentBinaryFromPsRow("", row.args)) continue;
    if (argvSessionId(row.args) !== sessionId) continue;
    const ancestors = collectAncestorPids(ppids, row.pid);
    if (ancestors.some((pid) => pid === daemonPid || OWN_RUNNER.test(byPid.get(pid)?.args ?? ""))) continue;
    return row;
  }
  return null;
}

/** What the held message shows: the process and the programs above it, so the person can tell which app holds the session. */
export function foreignWriterScreen(writer: PsRow, rows: PsRow[]): string {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const clip = (s: string) => (s.length > 240 ? `${s.slice(0, 239)}…` : s);
  const lines = [`pid ${writer.pid}${writer.tty === "??" || writer.tty === "?" ? "" : ` on ${writer.tty}`}  ${clip(writer.args)}`];
  for (const pid of collectAncestorPids(new Map(rows.map((r) => [r.pid, r.ppid])), writer.pid, 4)) {
    const row = byPid.get(pid);
    if (row) lines.push(`  under pid ${pid}  ${clip(row.args)}`);
  }
  return lines.join("\n");
}

export const FOREIGN_WRITER_RECHECK_MS = 60_000;

/**
 * Delivery held, not failed: the message stays queued with this reason, goes
 * out on its own once the other process exits, and "Send anyway" on the held
 * message resumes the session here regardless.
 */
export class ForeignWriterHoldError extends Error {
  readonly holdReason: string;
  readonly recheckMs = FOREIGN_WRITER_RECHECK_MS;
  constructor(readonly writer: PsRow, readonly holdScreen: string) {
    const reason = `another program is running this session (pid ${writer.pid})`;
    super(reason);
    this.holdReason = reason;
  }
}
