// `cast herd take`: move a session's claude out of tmux into a herdr tab.
//
// The daemon owns every step that touches session state (kill the tmux copy,
// launch the replacement), so the CLI is a client of one loopback route that
// streams its progress. The swap hold keeps the daemon from starting a tmux
// copy of the session in the gap between the kill and the new claude coming up.

import * as fs from "node:fs";
import { defaultConfigDir } from "./config/configDir.js";
import { hookPortFile, readIdentity } from "./loopbackIdentity.js";
import { CLAUDE_UUID_RE } from "./syncScope.js";

/** The daemon's loopback route for a take (daemon.ts startHookServer); the loopback bearer admits it. */
export const HERD_TAKE_PATH = "/hook/herd-take";

/** A crash backstop only: a take releases its hold in a finally, so a live take never reaches this. */
const SWAP_HOLD_MS = 10 * 60_000;
/** How long, under the hold, a delivery already in flight gets to land before the idle check is repeated. */
const DRAIN_MS = 15_000;
const AGENT_WAIT_MS = 30_000;
const BUSY_POLL_MS = 3000;
/** How often a wait that goes on is said again, with how long it has lasted. */
const REEMIT_MS = 15_000;

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

/** A delivery that must wait for a take to finish: held with this reason, never spending its retries, and tried again after `recheckMs`. */
export class SwapHeldError extends Error {
  constructor(readonly holdReason: string, readonly recheckMs = 3000) {
    super(holdReason);
  }
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

/**
 * What a progress event says about the step it belongs to. Events of one `step`
 * are the same step said again (a re-emit with `elapsedSec` since the step
 * began), so a client can keep rewriting one line; a different `step` is new.
 * An event with no `step` is a step of its own.
 */
export type StepInfo = { step: string; elapsedSec?: number };

/** One line of the route's streamed answer: progress, then exactly one done or error. */
export type HerdTakeEvent =
  | ({ type: "progress"; message: string } & Partial<StepInfo>)
  | { type: "done"; paneId: string; label: string }
  | { type: "error"; error: string };

export type Busy = { kind: string; detail: string };

export type Emit = (message: string, info?: StepInfo) => void;

export function formatElapsed(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

/** A progress event as one plain line. */
export function formatProgress(message: string, elapsedSec?: number): string {
  return elapsedSec === undefined ? message : `${message} · ${formatElapsed(elapsedSec)}`;
}

export type HerdTakeDeps = {
  agentType(sessionId: string): string;
  /** Where the session's agent runs now: a tmux pane, a bare process, or nowhere. */
  liveTarget(sessionId: string): Promise<{ tmuxTarget: string | null; proc: { pid: number } | null }>;
  /** What keeps the session from being interrupted now, or null. `kind` changes when the cause does; `detail` is for the person. */
  busy(sessionId: string): Busy | null | Promise<Busy | null>;
  /** Whether a message to the session is mid-delivery. */
  deliveryInFlight(sessionId: string): boolean;
  /** The clock the wait is timed by (Date.now). */
  now?(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** Why the tmux session cannot be killed without touching others, or null. */
  killRefusal(tmuxSession: string): Promise<string | null>;
  /** What can be settled while the old agent still runs and the transcript is untouched: the cwd and the tab's label. Throws to refuse. */
  prepareLaunch(sessionId: string): Promise<{ cwd: string; label: string }>;
  kill(tmuxSession: string, sessionId: string): Promise<void>;
  /** The line that starts claude on the session. It rewrites transcript files, so it runs only once the old agent is gone. */
  buildLine(sessionId: string, cwd: string): Promise<{ line: string; note?: string }>;
  /** Opens the tab, types the line, and returns the new pane's id. */
  launch(req: HerdTakeRequest, launch: { cwd: string; label: string; line: string }): Promise<string>;
  closePane(req: HerdTakeRequest, paneId: string): Promise<void>;
  /** Resolves true once the new claude is running the session as a herdr agent; `tick` gets the elapsed seconds about every 5s. */
  agentUp(sessionId: string, waitMs: number, tick: (elapsedSec: number) => void): Promise<boolean>;
};

const fail = (error: string): HerdTakeResult => ({ ok: false, error });

const takesInFlight = new Set<string>();

/**
 * Takes the session, reporting each step through `emit`. A busy agent is waited
 * out (no overall limit: the person sees why and can interrupt), with no hold
 * taken so normal delivery goes on meanwhile. The hold is taken once the agent
 * looks idle; under it the idle check is repeated after any delivery already in
 * flight has landed, and a message that made the agent busy again sends the
 * take back to waiting. `signal` aborts the wait and anything before the kill;
 * once the old copy is killed the launch runs to its end whatever the caller
 * does, so an interrupted take never leaves the session with no agent.
 */
export async function takeSessionIntoHerdr(
  req: HerdTakeRequest,
  deps: HerdTakeDeps,
  emit: Emit,
  signal: AbortSignal,
): Promise<HerdTakeResult> {
  if (takesInFlight.has(req.sessionId)) return fail("a take of this session is already running");
  takesInFlight.add(req.sessionId);
  try {
    return await run(req, deps, emit, signal);
  } finally {
    takesInFlight.delete(req.sessionId);
  }
}

async function run(req: HerdTakeRequest, deps: HerdTakeDeps, emit: Emit, signal: AbortSignal): Promise<HerdTakeResult> {
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
  const cancelled = () => fail("cancelled while waiting for the agent");

  const now = () => (deps.now ?? Date.now)();
  let waitingOn: string | null = null;
  let waitingSince = 0;
  let lastSaid = 0;
  /** Says what the take waits on: at once when the cause is new, then every REEMIT_MS with the time so far. */
  const sayWaiting = (busy: Busy) => {
    const at = now();
    const message = `agent is active — waiting for ${busy.detail}`;
    const step = `busy:${busy.kind}`;
    if (busy.kind !== waitingOn) {
      waitingOn = busy.kind;
      waitingSince = lastSaid = at;
      emit(message, { step });
    } else if (at - lastSaid >= REEMIT_MS) {
      lastSaid = at;
      emit(message, { step, elapsedSec: Math.round((at - waitingSince) / 1000) });
    }
  };
  /** Polls until the agent is idle. A result means the take is over. */
  const waitIdle = async (): Promise<HerdTakeResult | null> => {
    for (let busy = await deps.busy(sessionId); busy; busy = await deps.busy(sessionId)) {
      if (signal.aborted) return cancelled();
      sayWaiting(busy);
      await deps.wait(BUSY_POLL_MS, signal);
    }
    if (signal.aborted) return cancelled();
    if (waitingOn) emit("agent is idle");
    waitingOn = null;
    return null;
  };

  /** Everything from the hold to the new claude. A Busy means a message got in first and the wait starts over. */
  const swap = async (tmuxSession: string): Promise<HerdTakeResult | Busy> => {
    emit("holding message delivery to the session");
    if (!req.force) {
      const drainUntil = Date.now() + DRAIN_MS;
      while (deps.deliveryInFlight(sessionId) && Date.now() < drainUntil && !signal.aborted) await deps.wait(500, signal);
      if (signal.aborted) return cancelled();
      const busy = await deps.busy(sessionId);
      if (busy) return busy;
    }
    const refusal = await deps.killRefusal(tmuxSession);
    if (refusal) return fail(refusal);
    const { cwd, label } = await deps.prepareLaunch(sessionId);
    if (signal.aborted) return fail("cancelled");

    emit(`stopping tmux ${tmuxSession}`);
    await deps.kill(tmuxSession, sessionId);
    const after = await deps.liveTarget(sessionId);
    if (after.tmuxTarget || after.proc) return fail(`the old copy is still running after the kill (${after.tmuxTarget ?? `pid ${after.proc!.pid}`}); not starting a second one`);

    const gone = (err: unknown) => fail(`the tmux copy is gone but the herdr tab did not open: ${err instanceof Error ? err.message : String(err)}. The next message resumes the session in tmux`);
    let line: string;
    try {
      const built = await deps.buildLine(sessionId, cwd);
      line = built.line;
      if (built.note) emit(built.note);
    } catch (err) {
      return gone(err);
    }
    emit(`opening herdr tab "${label}"`);
    let paneId: string;
    try {
      paneId = await deps.launch(req, { cwd, label, line });
    } catch (err) {
      return gone(err);
    }
    emit(`starting claude in pane ${paneId}`);
    if (await deps.agentUp(sessionId, AGENT_WAIT_MS, (sec) => emit("waiting for claude to come up", { step: "claude-up", elapsedSec: sec }))) {
      return { ok: true, paneId, label };
    }
    // Closed while the hold still stands: a claude that came up late would otherwise sit beside the tmux resume the next message starts.
    await deps.closePane(req, paneId).catch(() => {});
    return fail(`claude did not start on the session within ${AGENT_WAIT_MS / 1000}s; pane ${paneId} was closed and the next message resumes the session in tmux`);
  };

  emit("looking for the session's tmux copy");
  for (;;) {
    if (!req.force) {
      const stop = await waitIdle();
      if (stop) return stop;
    }
    const located = await locate();
    if ("ok" in located) return located;
    holdSwap(sessionId);
    let result: HerdTakeResult | Busy;
    try {
      result = await swap(located.tmuxSession);
    } finally {
      releaseSwap(sessionId);
    }
    if (!("kind" in result)) return result;
    waitingOn = null;
    sayWaiting(result);
  }
}

/** The daemon's port and loopback bearer, or null when no daemon has run here. */
function daemonEndpoint(configDir: string): { port: number; token: string } | null {
  try {
    const port = parseInt(fs.readFileSync(hookPortFile(configDir), "utf-8").trim(), 10);
    const token = readIdentity(configDir)?.token ?? "";
    return port > 0 && token ? { port, token } : null;
  } catch {
    return null;
  }
}

/** Asks the daemon to take a session and hands each progress message to `onProgress`. No time limit: the daemon may be waiting for a busy agent, and dropping the connection cancels that wait. */
export async function requestHerdTake(
  req: HerdTakeRequest,
  onProgress: (progress: { message: string } & Partial<StepInfo>) => void,
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
    if (!res.ok || !res.body) return fail(`daemon answered HTTP ${res.status}${res.status === 404 ? " (it predates cast herd take; restart it with cast restart)" : ""}`);
    let result: HerdTakeResult | null = null;
    const read = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as HerdTakeEvent;
      if (event.type === "progress") onProgress(event);
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
    return result ?? fail("the daemon ended the stream without a result");
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
