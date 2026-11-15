// A model of how ONE session moves between inbox sections over time, written
// as a small explicit state machine. inboxLifecycle.model.test.ts drives random
// action sequences through this model and through the real code side by side
// (the shared placement in packages/shared/contracts/inboxProjection.ts and the
// web store's chokepoint, placeInboxRows) and asserts after every action that
// they agree. The pattern is plannotator's update-lifecycle.model.test.ts.
//
// The model holds three things:
//   - the SERVER's facts about the session (what Convex stores and pushes),
//   - the WINDOW's copy of those facts (what this tab last received), plus its
//     own outbox of sends and its liveness hold,
//   - the clock.
// `sectionAt` says which section a set of facts lands in at an instant. Every
// rule names the code or doc it reflects. When the model and the code
// disagree, either the rule here is wrong (fix it) or the code is (keep the
// minimal trace as a todo test in the test file).
//
// Modelling choices, so a reader knows what is NOT covered:
//   - One session, one viewer, personal scope. No riders, roles, anchors,
//     subagents, triggers, loops or decisions.
//   - The window never sees a dispatch receipt: a send settles in this window
//     only by its echo in a transcript the window holds (prunePendingEchoes).
//     That is the inherited-send case of 2026-11-04 and the general one for a
//     window that did not dispatch the send.
//   - Heartbeats are fresh whenever the daemon is up (lastBeat = now). Only a
//     daemon going down ages them.
//   - Triage gestures (stash, pin, snooze, rest) are made on another device:
//     they reach this window as server pushes, with no local lock.
import {
  AGENT_IDLE_GRACE_MS,
  DORMANT_CLAIM_TTL_MS,
  HEARTBEAT_ALIVE_MS,
  STATUS_TRUST_TTL_MS,
} from "@codecast/shared/contracts";
import { PENDING_SEND_WORKING_TTL_MS } from "../inboxOverlays";
import { LIVENESS_SUSPEND_GAP_MS } from "../../hooks/livenessHold";

export type Section = "stashed" | "snoozed" | "questions" | "pinned" | "needs_input" | "done" | "dormant" | "working" | "idle" | "new";
export type DaemonStatus = "working" | "idle" | "done" | "dormant" | "permission_blocked" | "stopped";
export type Pin = "done" | "dormant" | "blocked" | null;
export type Rest = "needs_input" | "done" | "dormant";

export type Facts = {
  msgs: number;
  /** managed_sessions.agent_status as the daemon last wrote it (raw, untrusted). */
  status: DaemonStatus;
  statusAt: number;
  /** conversations.updated_at: the last activity. */
  updatedAt: number;
  daemonUp: boolean;
  lastBeat: number;
  /** conversations.has_pending_messages: a send the server holds, not yet delivered. */
  queued: boolean;
  lastRoleIsUser: boolean;
  /** conversations.thread_state_status: the agent's `cast state --status`. */
  pin: Pin;
  stashedAt: number | null;
  pinnedAt: number | null;
  snoozedUntil: number | null;
  rest: { rest: Rest; at: number } | null;
};

export type Send = { clientId: string; at: number; enqueued: boolean; delivered: boolean; echoed: boolean };

export type HoldModel = {
  running: boolean;
  heldAt: number | null;
  seq: number;
  lastAlive: number;
  /** The seq a probe in flight was started for, or null. */
  probe: number | null;
};

export type Model = {
  t: number;
  server: Facts;
  /** The window's copy of the facts: the last push it received, plus its own local writes. */
  client: Facts;
  connected: boolean;
  transcriptOpen: boolean;
  sends: Send[];
  /** The send's local clear of the pin / the snooze, protected by a field
   *  lock until the server echoes the clear (store/syncProtocol.ts
   *  OPTIONAL_INBOX_TIMESTAMPS: undefined and null are the same clear). */
  pinLock: boolean;
  snoozeLock: boolean;
  hold: HoldModel;
};

export const T0 = 1_800_000_000_000;
export const COARSE_TICK_MS = 15_000;

// The projection's clock: placement-level terms compare against the minute
// (inboxProjection.ts inboxEpoch, sync-convergence C2).
export const epochOf = (t: number) => Math.floor(t / 60_000) * 60_000;

export function initialModel(): Model {
  const facts: Facts = {
    msgs: 3,
    status: "working",
    statusAt: T0,
    updatedAt: T0,
    daemonUp: true,
    lastBeat: T0,
    queued: false,
    lastRoleIsUser: false,
    pin: null,
    stashedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    rest: null,
  };
  return {
    t: T0,
    server: { ...facts },
    client: { ...facts },
    connected: true,
    transcriptOpen: false,
    sends: [],
    pinLock: false,
    snoozeLock: false,
    hold: { running: false, heldAt: null, seq: 0, lastAlive: T0, probe: null },
  };
}

// The person sends from this window: the store takes the pin down and clears
// the snooze on its own copy before any round-trip (inboxStore sendMessage,
// clearSessionSnoozeInDraft), each under a field lock.
export function localSend(m: Model) {
  if (m.client.pin != null) { m.pinLock = true; m.client.pin = null; }
  if (m.client.snoozedUntil != null) { m.snoozeLock = true; m.client.snoozedUntil = null; }
}

// A push lands: the window takes the server's facts, except a locked field,
// which keeps the local clear until the push carries the clear itself.
export function applyPush(m: Model) {
  const s = m.server;
  m.client = { ...s, rest: s.rest && { ...s.rest } };
  if (m.pinLock) { if (s.pin == null) m.pinLock = false; else m.client.pin = null; }
  if (m.snoozeLock) { if (s.snoozedUntil == null) m.snoozeLock = false; else m.client.snoozedUntil = null; }
}

// ── The section rules ───────────────────────────────────────────────────────

// What the daemon's status is trusted to say at `t` (agentStatus.ts
// trustedAgentStatus via inboxProjection.ts trustedStatusAt):
//   - a working or declared-dormant status with no heartbeat AND no activity
//     for the liveness window reads as stopped: the process is gone. A
//     declared done survives a dead daemon (the deliverable is there).
//   - a working status quiet for the trust TTL with a live heartbeat reads as
//     idle: the daemon lost the turn's idle transition.
//   - idle, permission_blocked and stopped are taken as they are.
export function trustedStatus(f: Facts, t: number): DaemonStatus {
  const alive = t - f.lastBeat < HEARTBEAT_ALIVE_MS;
  const quiet = t - f.updatedAt;
  const s = f.status;
  if (s !== "working" && s !== "dormant" && s !== "done") return s;
  if (!alive && quiet >= HEARTBEAT_ALIVE_MS && s !== "done") return "stopped";
  if (s === "working" && quiet >= STATUS_TRUST_TTL_MS) return "idle";
  return s;
}

// The section a set of facts lands in. `liveT` is the instant the live facts
// (heartbeat, grace, trust) are read at; `epochT` the minute the placement
// terms (snooze, the dormant claim) are read at. `asking` is the row's own
// open prompt (decisionQueue.sessionHasOpenQuestion: permission_blocked).
export function sectionAt(f: Facts, liveT: number, epochT: number, asking: boolean): Section {
  // Filing order, first rule wins (inboxProjection.ts placeInboxRow).
  if (f.stashedAt != null) return "stashed";
  if (f.snoozedUntil != null && f.snoozedUntil > epochT) return "snoozed";
  // A snooze that came due asks for the person (placeInboxRow snoozeDue).
  if (f.snoozedUntil != null) return "needs_input";
  if (f.msgs === 0) return "new";
  return workSection(f, liveT, epochT, asking);
}

function workSection(f: Facts, liveT: number, epochT: number, asking: boolean): Section {
  // The user's own rest verdict stands until the next activity expires it
  // (userRestOf: stamp at >= updated_at). It outranks an open ask too: they
  // saw the ask and triaged past it (placeInboxRow, questions arm).
  const rest = f.rest && f.rest.at >= f.updatedAt ? f.rest.rest : null;
  if (!rest && asking) return "questions";
  if (f.pinnedAt != null) return "pinned";
  if (rest) return rest;

  const st = trustedStatus(f, liveT);
  const quiet = liveT - f.updatedAt;
  const recently = quiet < AGENT_IDLE_GRACE_MS;
  // daemon_alive: the heartbeat window, and never for a stopped agent
  // (deriveLiveAt).
  const daemonAlive = st !== "stopped" && liveT - f.lastBeat < HEARTBEAT_ALIVE_MS;
  // Waiting on something nothing serves: no live daemon, a trailing user turn
  // or queued input, quiet past the grace (isUnservedSession).
  const unresponsive = !daemonAlive && (f.lastRoleIsUser || f.queued) && !recently;

  // Blocked on the person: a permission prompt (classifyWorkState).
  if (st === "permission_blocked") return "needs_input";
  // Actively producing.
  if (st === "working") return "working";
  // Queued work a live daemon can deliver is work in flight.
  if (!unresponsive && st !== "stopped" && f.queued) return "working";
  // A process that exits after declaring done is the ordinary end of a run
  // (isExitAfterDone); any other dead or unserved session needs a person.
  if (st === "stopped") return f.pin === "done" && !f.queued && !unresponsive ? "done" : "needs_input";
  if (unresponsive) return "needs_input";

  // isSessionIdle: a settled status past the anti-flicker grace measured from
  // the status change; inside it, settled only when nothing points at more
  // work (no trailing user turn, no recent activity).
  const settledPastGrace = liveT - f.statusAt >= AGENT_IDLE_GRACE_MS;
  const isIdle = !f.queued && (settledPastGrace || (!f.lastRoleIsUser && !recently));
  if (!isIdle) return "working";

  // The rest verdicts (classifyWorkState restState):
  //   - a declared block over a settled turn claims the person,
  //   - a declared dormant parks until DORMANT_CLAIM_TTL_MS of quiet with no
  //     wake the system can verify (none exist in this model),
  //   - a declared done files under done,
  //   - anything else settled needs the person.
  if (f.pin === "blocked" && st === "idle") return "needs_input";
  if (st === "dormant") return epochT - f.updatedAt >= DORMANT_CLAIM_TTL_MS ? "needs_input" : "dormant";
  if (st === "done") return "done";
  return "needs_input";
}

// What the server stamps: the shared placement at the projection's minute
// (the overlay runs deriveLiveAt and placeProjectableRow at its epoch).
export function serverSection(m: Model): Section {
  const e = epochOf(m.t);
  return sectionAt(m.server, e, e, m.server.status === "permission_blocked");
}

// The window's clock: while the liveness facts are held, time-driven terms
// read at the moment they were last known current (placeInboxRows
// livenessHeldAt, hooks/livenessHold.ts).
export const clientNow = (m: Model) => Math.min(m.t, m.hold.heldAt ?? Infinity);

// A send of the person's this window still waits to confirm, inside the
// placement bound (inboxOverlays.ts convHasPendingSend with now).
export function sendInFlight(m: Model): boolean {
  const now = clientNow(m);
  return m.sends.some((s) => !s.echoed && now - s.at < PENDING_SEND_WORKING_TTL_MS);
}

// What this window renders: the shared placement over its own copy of the
// facts at its own clock, then the declared overlays (inboxOverlays.ts).
// pending_send: the person already acted, so a settled section, or their own
// open prompt, reads Working until the echo lands (placeInboxRows
// placeRowWithOverlays). A snoozed row is left where it is.
export function clientSection(m: Model): Section {
  const now = clientNow(m);
  const asking = m.client.status === "permission_blocked";
  const base = sectionAt(m.client, now, epochOf(now), asking);
  if (!sendInFlight(m)) return base;
  if ((base === "needs_input" || base === "done" || base === "dormant") && !m.client.snoozedUntil) return "working";
  if (base === "questions") return "working";
  return base;
}

// ── The liveness hold, as a machine (hooks/livenessHold.ts) ────────────────
// A window holds its placement clock when it cannot know its facts are
// current: a launch from cache, a suspension, a dropped socket. One fresh read
// started after the latest hold releases it. Stopping the machine (the window
// is demoted from sync host) releases its hold: nothing else ever would.

export function holdAt(m: Model, at: number) {
  const h = m.hold;
  h.heldAt = h.heldAt == null ? at : Math.min(h.heldAt, at);
  h.seq++;
  startProbe(m);
}

export function startProbe(m: Model) {
  const h = m.hold;
  if (h.probe != null || h.heldAt == null || !m.connected) return;
  h.probe = h.seq;
}

// The coarse tick, a reconnect and a wake all run the same check.
export function holdCheck(m: Model) {
  const h = m.hold;
  if (!h.running) return;
  const now = m.t;
  if (now - h.lastAlive > LIVENESS_SUSPEND_GAP_MS) holdAt(m, h.lastAlive);
  else if (!m.connected && h.heldAt == null) holdAt(m, h.lastAlive);
  if (m.connected) h.lastAlive = now;
  startProbe(m);
}

export function holdBoot(m: Model) {
  const h = m.hold;
  h.running = true;
  h.lastAlive = m.t;
  // The cached facts are as old as their latest heartbeat (cachedFactsAsOf).
  if (m.client.lastBeat <= m.t) holdAt(m, m.client.lastBeat);
}

export function holdProbeAnswered(m: Model) {
  const h = m.hold;
  const seq = h.probe;
  if (seq == null) return;
  h.probe = null;
  if (seq === h.seq) h.heldAt = null;
  if (h.heldAt != null && h.seq !== seq) startProbe(m);
}

export function holdStop(m: Model) {
  const h = m.hold;
  h.running = false;
  h.probe = null;
  h.heldAt = null;
}
