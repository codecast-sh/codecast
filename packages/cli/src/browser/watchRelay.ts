// The daemon half of remote browser watching: run a watch session (the same
// one the loopback socket runs, watchServer.ts runWatchSession) and publish
// it to the Convex relay (convex/browserStream.ts) for a viewer on another
// machine. Started by the `stream_browser` daemon command.
//
// The relay stores one picture, not a stream, so this keeps only the newest
// frame and pushes it at most every BROWSER_RELAY_FRAME_INTERVAL_MS, with the
// tab, the control grant and the agent's recent actions riding the same
// push when they change. An unchanged page costs a heartbeat every couple of
// seconds.
//
// The push answer carries the viewer's lease and any input they queued. A
// lapsed lease stops the loop; there is no stop command. When the session
// ends on its own (tab closed, no browser, the 30 minute cap), the ending is
// pushed once so the viewer can say why, and the loop stops.

import {
  BROWSER_RELAY_FRAME_INTERVAL_MS,
  BROWSER_RELAY_HEARTBEAT_MS,
  BROWSER_RELAY_INPUT_POLL_MS,
  BROWSER_RELAY_LEASE_MS,
  BROWSER_RELAY_MAX_DIM,
  BROWSER_RELAY_QUALITY,
  BROWSER_RELAY_RECENT_ACTIONS,
  type BrowserRelayEnd,
  type StreamBrowserArgs,
} from "@codecast/shared/contracts";
import type { WatchSessionHandle, WatchSessionOptions, WatchSink } from "./watchServer.js";

export interface RelayPush {
  key: string;
  frame?: string;
  frame_w?: number;
  frame_h?: number;
  tab?: { id: string; title: string; url: string };
  control?: boolean;
  actions?: string;
  end?: string;
}

export interface RelayAnswer {
  stop: boolean;
  input?: unknown[];
  fast?: boolean;
}

export interface WatchRelayDeps {
  /** Publish to the relay; null when the push itself failed. */
  push(msg: RelayPush): Promise<RelayAnswer | null>;
  startSession(opts: WatchSessionOptions, sink: WatchSink): WatchSessionHandle;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}

/** Consecutive failed pushes before giving up: rides out a reconnect, but a
 *  machine that lost the server stops streaming a page nobody can see. */
const MAX_PUSH_FAILURES = 6;
/** How often the loop wakes to look for something to push. */
const TICK_MS = 100;

export async function runWatchRelay(args: StreamBrowserArgs, deps: WatchRelayDeps): Promise<void> {
  let frame: { data: string; w: number; h: number } | null = null;
  let tab: { id: string; title: string; url: string } | null = null;
  let control: boolean | null = null;
  let actions: Record<string, unknown>[] = [];
  let actionsDirty = false;
  let end: BrowserRelayEnd | null = null;

  const session = deps.startSession(
    {
      session_uuid: args.session_uuid,
      tmux_session: args.tmux_session,
      minIntervalMs: BROWSER_RELAY_FRAME_INTERVAL_MS,
      control: true,
      quality: BROWSER_RELAY_QUALITY,
      maxDim: BROWSER_RELAY_MAX_DIM,
      log: deps.log,
    },
    {
      send(msg) {
        switch (msg.type) {
          case "ready":
            tab = { id: String(msg.targetId ?? ""), title: String(msg.title ?? ""), url: String(msg.url ?? "") };
            control = msg.control === true;
            // A new tab's cursor memory starts over; the replay that follows
            // ready refills it.
            actions = [];
            actionsDirty = true;
            break;
          case "frame":
            frame = { data: String(msg.data ?? ""), w: Number(msg.w) || 0, h: Number(msg.h) || 0 };
            break;
          case "tab":
            tab = { id: String(msg.targetId ?? ""), title: String(msg.title ?? ""), url: String(msg.url ?? "") };
            break;
          case "action":
            actions = [...actions, msg].slice(-BROWSER_RELAY_RECENT_ACTIONS);
            actionsDirty = true;
            break;
        }
      },
      finish(msg) {
        end = msg.type === "error"
          ? { kind: "error", code: msg.code, message: msg.message }
          : { kind: "exit", code: msg.reason };
      },
      backlogged: () => false,
    },
  );

  let lastPushAt = 0;
  let failures = 0;
  let fast = false;
  // The session's own 30 minute cap ends it first; this is the backstop for a
  // relay that stops answering.
  const hardDeadline = deps.now() + BROWSER_RELAY_LEASE_MS * 120;

  try {
    for (;;) {
      if (deps.now() > hardDeadline) {
        deps.log(`[BROWSER-RELAY] ${args.key}: hard deadline reached, stopping`);
        return;
      }
      const since = deps.now() - lastPushAt;
      const changed = frame !== null || tab !== null || control !== null || actionsDirty;
      const due =
        end !== null ||
        (changed && since >= BROWSER_RELAY_FRAME_INTERVAL_MS) ||
        since >= (fast ? BROWSER_RELAY_INPUT_POLL_MS : BROWSER_RELAY_HEARTBEAT_MS);
      if (!due) {
        await deps.sleep(TICK_MS);
        continue;
      }

      const msg: RelayPush = { key: args.key };
      const sent = { frame, tab, control, actionsDirty };
      if (frame) Object.assign(msg, { frame: frame.data, frame_w: frame.w, frame_h: frame.h });
      if (tab) msg.tab = tab;
      if (control !== null) msg.control = control;
      if (actionsDirty) msg.actions = JSON.stringify(actions);
      const ending = end as BrowserRelayEnd | null;
      if (ending) msg.end = JSON.stringify(ending);

      const answer = await deps.push(msg);
      if (!answer) {
        if (++failures >= MAX_PUSH_FAILURES) {
          deps.log(`[BROWSER-RELAY] ${args.key}: ${failures} failed pushes, stopping`);
          return;
        }
        await deps.sleep(Math.min(2_000, 250 * failures));
        continue;
      }
      failures = 0;
      lastPushAt = deps.now();
      fast = !!answer.fast;
      // Clear only what this push carried: anything that arrived while it was
      // in flight goes out on the next one.
      if (frame === sent.frame) frame = null;
      if (tab === sent.tab) tab = null;
      if (control === sent.control) control = null;
      if (sent.actionsDirty) actionsDirty = false;
      if (ending) {
        deps.log(`[BROWSER-RELAY] ${args.key}: stream ended (${ending.kind} ${ending.code})`);
        return;
      }
      if (answer.stop) {
        deps.log(`[BROWSER-RELAY] ${args.key}: lease lapsed, stopping`);
        return;
      }
      if (answer.input) for (const ev of answer.input) session.input(ev);
    }
  } finally {
    session.stop();
  }
}

// One loop per relay row, however many viewers: they share the row's lease.
const active = new Map<string, Promise<void>>();

export function isBrowserRelayRunning(key: string): boolean {
  return active.has(key);
}

/** Start the relay loop for `args.key` unless it is already running. */
export function startWatchRelay(args: StreamBrowserArgs, deps: WatchRelayDeps): boolean {
  if (active.has(args.key)) return false;
  const run = runWatchRelay(args, deps)
    .catch((err) => deps.log(`[BROWSER-RELAY] ${args.key}: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => active.delete(args.key));
  active.set(args.key, run);
  return true;
}
