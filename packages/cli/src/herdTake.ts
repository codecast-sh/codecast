// `cast herd take`: move a session's claude out of tmux into a herdr tab.
//
// The daemon owns every step that touches session state (kill the tmux copy,
// launch the replacement), so the CLI is a client of one loopback route that
// streams its progress. The swap hold keeps the daemon from starting a tmux
// copy of the session in the gap between the kill and the new claude coming up.

import * as fs from "node:fs";
import { defaultConfigDir } from "./config/configDir.js";
import { readHookToken } from "./hookIdentity.js";
import { hookPortFile } from "./loopbackIdentity.js";
import { CLAUDE_UUID_RE } from "./syncScope.js";

/** The daemon's loopback route for a take (daemon.ts startHookServer); the hook token admits it. */
export const HERD_TAKE_PATH = "/hook/herd-take";

/** Covers the kill, the launch and the wait for the new claude. */
const SWAP_HOLD_MS = 60_000;
const AGENT_WAIT_MS = 30_000;
const BUSY_POLL_MS = 3000;

const holds = new Map<string, number>();

export function holdSwap(sessionId: string, now = Date.now()): void {
  holds.set(sessionId, now + SWAP_HOLD_MS);
}

export function releaseSwap(sessionId: string): void {
  holds.delete(sessionId);
}

/** Whether a take is mid-swap on this session. An expired hold counts as released. */
export function swapHeld(sessionId: string, now = Date.now()): boolean {
  const until = holds.get(sessionId);
  if (until === undefined) return false;
  if (until > now) return true;
  holds.delete(sessionId);
  return false;
}

export type HerdTakeRequest = {
  sessionId: string;
  /** The herdr API socket of the caller's session (HERDR_SOCKET_PATH). */
  socketPath: string;
  /** The caller's workspace (HERDR_WORKSPACE_ID). */
  workspaceId: string;
  force?: boolean;
};

export type HerdTakeResult = { ok: true; paneId: string; label: string } | { ok: false; error: string };

/** One line of the route's streamed answer: progress, then exactly one done or error. */
export type HerdTakeEvent =
  | { type: "progress"; message: string }
  | { type: "done"; paneId: string; label: string }
  | { type: "error"; error: string };

export type Busy = { kind: string; detail: string };

export type HerdTakeDeps = {
  agentType(sessionId: string): string;
  /** Where the session's agent runs now: a tmux pane, a bare process, or nowhere. */
  liveTarget(sessionId: string): Promise<{ tmuxTarget: string | null; proc: { pid: number } | null }>;
  /** What keeps the session from being interrupted now, or null. `kind` changes when the cause does; `detail` is for the person. */
  busy(sessionId: string): Busy | null;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** Why the tmux session cannot be killed without touching others, or null. */
  killRefusal(tmuxSession: string): Promise<string | null>;
  /** Everything a launch needs except the launch token, which is minted by `line()` once the old copy is gone. */
  prepareLaunch(sessionId: string): Promise<{ cwd: string; label: string; line: () => string }>;
  kill(tmuxSession: string, sessionId: string): Promise<void>;
  /** Opens the tab, types the line, and returns the new pane's id. */
  launch(req: HerdTakeRequest, launch: { cwd: string; label: string; line: string }): Promise<string>;
  /** Resolves true once the new claude is running the session; `tick` gets the elapsed seconds about every 5s. */
  agentUp(sessionId: string, waitMs: number, tick: (elapsedSec: number) => void): Promise<boolean>;
};

const fail = (error: string): HerdTakeResult => ({ ok: false, error });

/**
 * Takes the session, reporting each step through `emit`. A busy agent is waited
 * out (no overall limit: the person sees why and can interrupt), with no hold
 * taken so normal delivery goes on meanwhile. `signal` aborts the wait and
 * anything before the kill; once the old copy is killed the launch runs to its
 * end whatever the caller does, so an interrupted take never leaves the session
 * with no agent.
 */
export async function takeSessionIntoHerdr(
  req: HerdTakeRequest,
  deps: HerdTakeDeps,
  emit: (message: string) => void,
  signal: AbortSignal,
): Promise<HerdTakeResult> {
  const { sessionId } = req;
  const agent = deps.agentType(sessionId);
  if (agent !== "claude") return fail(`only claude sessions can be taken into herdr (this one is ${agent})`);

  const locate = async (): Promise<{ tmuxSession: string } | HerdTakeResult> => {
    const live = await deps.liveTarget(sessionId);
    if (live.tmuxTarget) return { tmuxSession: live.tmuxTarget.split(":")[0] };
    return fail(live.proc
      ? `the session already runs outside tmux (pid ${live.proc.pid}); nothing to take`
      : "the session has no live tmux copy to take");
  };

  emit("looking for the session's tmux copy");
  let located = await locate();
  if ("ok" in located) return located;

  if (!req.force) {
    let waitingOn: string | null = null;
    for (let busy = deps.busy(sessionId); busy; busy = deps.busy(sessionId)) {
      if (signal.aborted) return fail("cancelled while waiting for the agent");
      if (busy.kind !== waitingOn) {
        waitingOn = busy.kind;
        emit(`agent is active — waiting for ${busy.detail}`);
      }
      await deps.wait(BUSY_POLL_MS, signal);
    }
    if (signal.aborted) return fail("cancelled while waiting for the agent");
    if (waitingOn) {
      emit("agent is idle");
      located = await locate();
      if ("ok" in located) return located;
    }
  }
  const { tmuxSession } = located;

  const refusal = await deps.killRefusal(tmuxSession);
  if (refusal) return fail(refusal);
  const launch = await deps.prepareLaunch(sessionId);
  if (signal.aborted) return fail("cancelled");

  emit("holding message delivery to the session");
  holdSwap(sessionId);
  try {
    emit(`stopping tmux ${tmuxSession}`);
    await deps.kill(tmuxSession, sessionId);
    const after = await deps.liveTarget(sessionId);
    if (after.tmuxTarget || after.proc) return fail(`the old copy is still running after the kill (${after.tmuxTarget ?? `pid ${after.proc!.pid}`}); not starting a second one`);

    emit(`opening herdr tab "${launch.label}"`);
    let paneId: string;
    try {
      paneId = await deps.launch(req, { cwd: launch.cwd, label: launch.label, line: launch.line() });
    } catch (err) {
      return fail(`the tmux copy is gone but the herdr tab did not open: ${err instanceof Error ? err.message : String(err)}. The next message resumes the session in tmux`);
    }
    emit(`starting claude in pane ${paneId}`);
    const up = await deps.agentUp(sessionId, AGENT_WAIT_MS, (sec) => emit(`waiting for claude to come up (${sec}s)`));
    if (!up) return fail(`opened pane ${paneId}, but claude did not start on the session within ${AGENT_WAIT_MS / 1000}s; look at the tab`);
    return { ok: true, paneId, label: launch.label };
  } finally {
    releaseSwap(sessionId);
  }
}

/** The daemon's port and hook token, or null when no daemon has run here. */
function daemonEndpoint(configDir: string): { port: number; token: string } | null {
  try {
    const port = parseInt(fs.readFileSync(hookPortFile(configDir), "utf-8").trim(), 10);
    const token = readHookToken(configDir);
    return port > 0 && token ? { port, token } : null;
  } catch {
    return null;
  }
}

/** Asks the daemon to take a session and hands each progress message to `onProgress`. No time limit: the daemon may be waiting for a busy agent, and dropping the connection cancels that wait. */
export async function requestHerdTake(
  req: HerdTakeRequest,
  onProgress: (message: string) => void,
  configDir = defaultConfigDir(),
): Promise<HerdTakeResult> {
  const daemon = daemonEndpoint(configDir);
  if (!daemon) return fail("the codecast daemon is not running (cast status)");
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${HERD_TAKE_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.body) return fail(`daemon answered HTTP ${res.status}`);
    let result: HerdTakeResult | null = null;
    const read = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as HerdTakeEvent;
      if (event.type === "progress") onProgress(event.message);
      else if (event.type === "done") result = { ok: true, paneId: event.paneId, label: event.label };
      else if (event.type === "error") result = fail(event.error);
    };
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      lines.forEach(read);
    }
    read(buffered);
    return result ?? fail(res.ok ? "the daemon ended the stream without a result" : `daemon answered HTTP ${res.status}`);
  } catch (err) {
    return fail(`could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The session a reference names among the daemon's known sessions (session id to
 * conversation id): a session id or its prefix, or a conversation id or its
 * prefix (the short id `cast sessions` prints).
 */
export function resolveSessionRef(ref: string, sessionToConversation: Record<string, string>): { sessionId: string } | { error: string } {
  if (CLAUDE_UUID_RE.test(ref)) return { sessionId: ref };
  const entries = Object.entries(sessionToConversation);
  const exact = entries.find(([sid, cid]) => sid === ref || cid === ref);
  const matches = exact ? [exact] : ref.length >= 6 ? entries.filter(([sid, cid]) => sid.startsWith(ref) || cid.startsWith(ref)) : [];
  if (matches.length === 1) return { sessionId: matches[0][0] };
  if (matches.length > 1) return { error: `"${ref}" matches ${matches.length} sessions; use more of the id` };
  return { error: `no session matches "${ref}" on this machine` };
}
