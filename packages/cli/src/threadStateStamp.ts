// The on-disk trace of `cast state`, split out from stateCommand.ts.
//
// The reminder hook (thread-state.sh, on Stop and UserPromptSubmit) must decide
// whether to nudge without a network call on every event, so the decision is
// kept on disk: a stamp file exists only while this session has a pinned state,
// and a mark beside it holds the transcript message count the thread stood at
// after the last write (plus a "nudged" flag once the reminder has fired).
// `cast state` deletes the mark on every write, which is what makes the
// reminder fire once per stretch and re-arm when the agent updates its state.
//
// It is its own module because the daemon reads the stamp at turn end and has
// no business loading the `cast state` command to do it: importing
// stateCommand.js put commander, the HTTP client and the whole publish deps
// chain into the daemon bundle for one file read. ct-49546.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseThreadStateStatus, type ThreadStateStatus } from "@codecast/shared/contracts";

function threadStateDir(): string {
  return path.join(os.homedir(), ".codecast", "thread-state");
}

export function threadStateStampPath(sessionId: string): string {
  return path.join(threadStateDir(), `${sessionId}.json`);
}

export function threadStateCounterPath(sessionId: string): string {
  return path.join(threadStateDir(), "counters", sessionId);
}

/** What the stamp holds. `status` is the agent's declared answer to "who acts
 * next" — the daemon reads it at turn end (daemon.ts declaredSettleVerdict)
 * and settles the agent's status to "dormant" / "done" instead of plain idle
 * when the stamp was written during the turn that just ended. */
export interface ThreadStateStamp {
  at: number;
  status?: ThreadStateStatus;
}

/** Stamp "this session has a pinned state" (with the declared status) and
 * reset the reminder's message baseline. */
export function writeThreadStatePulse(sessionId: string, status?: ThreadStateStatus): void {
  try {
    fs.mkdirSync(threadStateDir(), { recursive: true });
    const stamp: ThreadStateStamp = { at: Date.now(), ...(status ? { status } : {}) };
    fs.writeFileSync(threadStateStampPath(sessionId), JSON.stringify(stamp));
    const counter = threadStateCounterPath(sessionId);
    if (fs.existsSync(counter)) fs.unlinkSync(counter);
  } catch {}
}

/** The stamp for a session, or null when it has none / is unreadable. */
export function readThreadStateStamp(sessionId: string): ThreadStateStamp | null {
  try {
    const raw = fs.readFileSync(threadStateStampPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as { at?: unknown; status?: unknown };
    if (typeof parsed.at !== "number") return null;
    const status = parseThreadStateStatus(typeof parsed.status === "string" ? parsed.status : null);
    return { at: parsed.at, ...(status ? { status } : {}) };
  } catch {
    return null;
  }
}

/** Drop the stamp — a session with no pinned state is never nudged. */
export function clearThreadStatePulse(sessionId: string): void {
  try {
    for (const file of [threadStateStampPath(sessionId), threadStateCounterPath(sessionId)]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  } catch {}
}
