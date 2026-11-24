// The inbox lifecycle model next to the real code (fast-check). See
// inboxLifecycle.model.ts for the model and its rules.
//
// Each run starts one session mid-turn and applies a random sequence of
// actions from every actor: the person (send, triage, open the transcript),
// the daemon (deliver, heartbeats, going down), the agent (output, ending a
// turn with a verdict, a permission prompt, exiting), the window (boot from
// cache, demotion from sync host, socket loss, suspension, the liveness probe
// answering) and the clock (advances across the real TTLs). After every
// action:
//   - the server stamp (shared placeProjectableRow over deriveLiveAt) equals
//     the model's server section,
//   - the window's section (the real store: addOptimisticMessage, sendMessage,
//     syncTable, setMessages, the liveness hold machine, placeInboxRows)
//     equals the model's client section,
//   - the whole-run properties hold (see `checkProperties`).
//
//   bun test store/__tests__/inboxLifecycle.model.test.ts
//   INBOX_MODEL_RUNS=2000 bun test store/__tests__/inboxLifecycle.model.test.ts
//   bun test --todo store/__tests__/inboxLifecycle.model.test.ts   # known findings (fail on main)
import { afterAll, describe, expect, it, setSystemTime, test } from "bun:test";
import fc from "fast-check";
import {
  AGENT_IDLE_GRACE_MS,
  HEARTBEAT_ALIVE_MS,
  deriveLiveAt,
  type ProjectableInboxRow,
} from "@codecast/shared/contracts";
import { placeProjectableRow } from "@codecast/shared/contracts/inboxPlacement";
import { useInboxStore, placeInboxRows, __resetInboxPlacementCacheForTests } from "../inboxStore";
import { PENDING_SEND_WORKING_TTL_MS } from "../inboxOverlays";
import { startLivenessHold, type LivenessHoldIO } from "../../hooks/livenessHold";
import {
  COARSE_TICK_MS,
  T0,
  applyPush,
  clientSection,
  localSend,
  epochOf,
  holdBoot,
  holdCheck,
  holdProbeAnswered,
  holdStop,
  initialModel,
  sendInFlight,
  serverSection,
  type Facts,
  type Model,
  type Pin,
  type Rest,
  type Section,
} from "./inboxLifecycle.model";

const ID = "jx70000000000000000000000000life";
const RUNS = Number(process.env.INBOX_MODEL_RUNS ?? 150);

// ── Actions ─────────────────────────────────────────────────────────────────

export type Action =
  | { k: "send" }
  | { k: "enqueue" }
  | { k: "deliver" }
  | { k: "output" }
  | { k: "stop"; v: "idle" | "done" | "dormant" | "blocked" }
  | { k: "permission" }
  | { k: "exit" }
  | { k: "daemonDown" }
  | { k: "daemonUp" }
  | { k: "openTranscript" }
  | { k: "closeTranscript" }
  | { k: "stash" }
  | { k: "unstash" }
  | { k: "pin" }
  | { k: "unpin" }
  | { k: "snooze"; ms: number }
  | { k: "unsnooze" }
  | { k: "rest"; r: Rest }
  | { k: "advance"; ms: number }
  | { k: "suspend"; ms: number }
  | { k: "disconnect" }
  | { k: "reconnect" }
  | { k: "boot" }
  | { k: "demote" }
  | { k: "probeAnswer" };

const MIN = 60_000;
// Durations chosen across the real thresholds: the 15s tick, the 40s suspend
// gap, the 45s idle grace, the 2m heartbeat window, the 10m send bound, the
// 1h trust TTL and the 2h dormant claim, each just under and just over.
const durationArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(5_000, 15_000, 30_000, 46_000, 61_000, 2 * MIN + 1_000, 5 * MIN, 9 * MIN, 11 * MIN, 30 * MIN, 61 * MIN, 121 * MIN) },
  { weight: 1, arbitrary: fc.integer({ min: 1_000, max: 3 * 60 * MIN }) },
);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ k: "send" } as const) },
  { weight: 4, arbitrary: fc.constant({ k: "enqueue" } as const) },
  { weight: 4, arbitrary: fc.constant({ k: "deliver" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "output" } as const) },
  { weight: 4, arbitrary: fc.constantFrom("idle", "done", "dormant", "blocked").map((v) => ({ k: "stop", v }) as const) },
  { weight: 1, arbitrary: fc.constant({ k: "permission" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "exit" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "daemonDown" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "daemonUp" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "openTranscript" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "closeTranscript" } as const) },
  { weight: 2, arbitrary: fc.constantFrom("stash", "unstash", "pin", "unpin", "unsnooze").map((k) => ({ k }) as Action) },
  { weight: 1, arbitrary: fc.constantFrom(10 * MIN, 60 * MIN).map((ms) => ({ k: "snooze", ms }) as const) },
  { weight: 1, arbitrary: fc.constantFrom("needs_input", "done", "dormant").map((r) => ({ k: "rest", r }) as const) },
  { weight: 7, arbitrary: durationArb.map((ms) => ({ k: "advance", ms }) as const) },
  { weight: 1, arbitrary: durationArb.map((ms) => ({ k: "suspend", ms }) as const) },
  { weight: 1, arbitrary: fc.constant({ k: "disconnect" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "reconnect" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "boot" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "demote" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "probeAnswer" } as const) },
);

export const showAction = (a: Action) =>
  a.k === "stop" ? `stop(${a.v})` :
  a.k === "rest" ? `rest(${a.r})` :
  "ms" in a ? `${a.k}(${a.ms >= MIN ? `${+(a.ms / MIN).toFixed(2)}m` : `${a.ms / 1000}s`})` :
  a.k;

// ── The real side ───────────────────────────────────────────────────────────

// The row the server pushes: the conversation, its inbox stamps and the
// liveness facts the overlay stamps at `t` (deriveLiveAt is the one idle rule).
function projectableRow(f: Facts): ProjectableInboxRow {
  return {
    _id: ID,
    status: "active",
    title: "Model run",
    agent_type: "claude_code",
    updated_at: f.updatedAt,
    message_count: f.msgs,
    has_pending_messages: f.queued,
    inbox_stashed_at: f.stashedAt,
    inbox_pinned_at: f.pinnedAt,
    inbox_snoozed_until: f.snoozedUntil,
    inbox_rest: f.rest?.rest ?? null,
    inbox_rest_at: f.rest?.at ?? null,
    thread_state_status: f.pin,
    agent_status: f.status,
    agent_status_updated_at: f.statusAt,
    last_heartbeat: f.lastBeat,
    daemon_alive_until: f.lastBeat + HEARTBEAT_ALIVE_MS,
    last_role_is_user: f.lastRoleIsUser,
  };
}

function sessionRow(f: Facts, t: number) {
  const row = projectableRow(f);
  const live = deriveLiveAt(row, t);
  return {
    ...row,
    session_id: "s-life",
    started_at: T0 - 60 * MIN,
    has_pending: f.queued,
    is_idle: live.is_idle,
    is_unresponsive: live.is_unresponsive,
    awaiting_input: false,
    is_connected: live.daemon_alive,
    thread_state: f.pin ? `Model run\nStatus: ${f.pin}` : null,
    thread_state_at: f.pin ? f.statusAt : null,
    thread_state_msg_count: f.pin ? f.msgs : null,
  };
}

// The stamp the server overlay writes: shared placement at its minute.
function realServerSection(m: Model): string {
  const e = epochOf(m.t);
  const row = projectableRow(m.server);
  const live = deriveLiveAt(row, e);
  return placeProjectableRow({ ...row, ...live }, m.server.status === "permission_blocked", e).bucket;
}

type World = {
  m: Model;
  /** Read the chokepoint through its memo, as the app does. Off: every read is a fresh computation. */
  memo: boolean;
  /** Check the properties without the exemptions known findings need. */
  strict: boolean;
  stopHold: (() => void) | null;
  probe: ((applied: boolean) => void) | null;
  ticks: Set<() => void>;
  conns: Set<() => void>;
  wakes: Set<() => void>;
  sendSeq: number;
};

const store = () => useInboxStore.getState() as any;

function setClock(t: number) {
  setSystemTime(new Date(t));
}

function freshWorld(): World {
  __resetInboxPlacementCacheForTests();
  const m = initialModel();
  setClock(m.t);
  useInboxStore.setState({
    sessions: {}, conversations: {}, pendingMessages: {}, messages: {}, pending: {},
    questionResolutions: {}, newSessionHolds: {}, sessionDecisions: {},
    sessionsWithQueuedMessages: new Set<string>(), blockedReviveRequestedAt: {},
    livenessHeldAt: null, livenessHoldSeq: 0, currentSessionId: null,
  } as any);
  store()._setDispatch(() => Promise.resolve(undefined));
  store().syncTable("sessions", [sessionRow(m.server, m.t)]);
  return { m, memo: true, strict: false, stopHold: null, probe: null, ticks: new Set(), conns: new Set(), wakes: new Set(), sendSeq: 0 };
}

// The server's current facts reach the window (a subscription push, or the
// probe's fresh read).
function push(w: World) {
  store().syncTable("sessions", [sessionRow(w.m.server, w.m.t)]);
  applyPush(w.m);
}

// Delivered sends echo into a transcript the window holds.
function echo(w: World) {
  const m = w.m;
  if (!m.transcriptOpen) return;
  const rows = m.sends.filter((s) => s.delivered).map((s, i) => ({
    _id: `msg_${s.clientId}`, role: "user", content: `note ${s.clientId}`, timestamp: s.at + 1 + i, client_id: s.clientId,
  }));
  if (!rows.length) return;
  store().setMessages(ID, rows);
  for (const s of m.sends) if (s.delivered) s.echoed = true;
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function holdIO(w: World): LivenessHoldIO {
  const sub = (set: Set<() => void>) => (fn: () => void) => { set.add(fn); return () => { set.delete(fn); }; };
  return {
    now: () => Date.now(),
    hydrated: () => true,
    sessions: () => store().sessions,
    heldAt: () => store().livenessHeldAt,
    holdSeq: () => store().livenessHoldSeq,
    hold: (at) => store().holdLiveness(at),
    release: (seq) => store().releaseLiveness(seq),
    probe: (signal) => new Promise<boolean>((resolve) => {
      w.probe = resolve;
      signal.addEventListener("abort", () => { if (w.probe === resolve) w.probe = null; });
    }),
    connected: () => w.m.connected,
    onTick: sub(w.ticks),
    onConnection: sub(w.conns),
    onWake: sub(w.wakes),
    onStore: () => () => {},
  };
}

const fire = (set: Set<() => void>) => { for (const fn of [...set]) fn(); };

// Clock moves with the app awake: the coarse tick runs every 15s.
function passTime(w: World, ms: number, awake: boolean) {
  const m = w.m;
  let left = ms;
  while (awake && m.hold.running && left >= COARSE_TICK_MS) {
    left -= COARSE_TICK_MS;
    m.t += COARSE_TICK_MS;
    setClock(m.t);
    if (m.server.daemonUp) m.server.lastBeat = m.t;
    holdCheck(m);
    fire(w.ticks);
  }
  m.t += left;
  setClock(m.t);
  if (m.server.daemonUp) m.server.lastBeat = m.t;
}

// Apply one action to the model and the real code. Returns false when the
// action does not apply in this state (it is then a no-op on both sides).
async function step(w: World, a: Action): Promise<boolean> {
  const m = w.m;
  const s = m.server;
  const serverWrite = () => { if (s.daemonUp) s.lastBeat = m.t; if (m.connected) push(w); };
  switch (a.k) {
    case "send": {
      // The window's half: the bubble, the outbox entry and the local clears.
      // The server sees it on the next enqueue.
      const content = `note ${++w.sendSeq}`;
      const clientId = store().addOptimisticMessage(ID, content);
      store().sendMessage(ID, content, undefined, clientId);
      m.sends.push({ clientId, at: m.t, enqueued: false, delivered: false, echoed: false });
      localSend(m);
      return true;
    }
    case "enqueue": {
      // The outbox reaches the server (pendingMessages.enqueue): a person's
      // send bumps the activity, queues, and clears the stash, the snooze and
      // the pin (wake-up rules).
      if (!m.connected || !m.sends.some((x) => !x.enqueued)) return false;
      for (const x of m.sends) x.enqueued = true;
      Object.assign(s, { updatedAt: m.t, queued: true, stashedAt: null, snoozedUntil: null, pin: null });
      serverWrite();
      return true;
    }
    case "deliver": {
      if (!s.queued || !s.daemonUp) return false;
      Object.assign(s, { queued: false, msgs: s.msgs + 1, lastRoleIsUser: true, updatedAt: m.t, status: "working", statusAt: m.t });
      for (const x of m.sends) if (x.enqueued) x.delivered = true;
      serverWrite();
      echo(w);
      return true;
    }
    case "output":
      if (s.status !== "working") return false;
      Object.assign(s, { msgs: s.msgs + 1, lastRoleIsUser: false, updatedAt: m.t });
      serverWrite();
      return true;
    case "stop": {
      if (s.status !== "working") return false;
      const status = a.v === "blocked" ? "idle" : a.v;
      const pin: Pin = a.v === "idle" ? s.pin : a.v;
      Object.assign(s, { status, pin, msgs: s.msgs + 1, lastRoleIsUser: false, updatedAt: m.t, statusAt: m.t });
      serverWrite();
      return true;
    }
    case "permission":
      if (s.status !== "working") return false;
      Object.assign(s, { status: "permission_blocked", statusAt: m.t, updatedAt: m.t });
      serverWrite();
      return true;
    case "exit":
      if (s.status === "stopped") return false;
      Object.assign(s, { status: "stopped", statusAt: m.t });
      serverWrite();
      return true;
    case "daemonDown":
      if (!s.daemonUp) return false;
      s.daemonUp = false;
      serverWrite();
      return true;
    case "daemonUp":
      if (s.daemonUp) return false;
      s.daemonUp = true;
      serverWrite();
      return true;
    case "openTranscript":
      if (m.transcriptOpen) return false;
      m.transcriptOpen = true;
      echo(w);
      return true;
    case "closeTranscript":
      if (!m.transcriptOpen) return false;
      m.transcriptOpen = false;
      return true;
    case "stash": if (s.stashedAt != null) return false; s.stashedAt = m.t; serverWrite(); return true;
    case "unstash": if (s.stashedAt == null) return false; s.stashedAt = null; serverWrite(); return true;
    case "pin": if (s.pinnedAt != null) return false; s.pinnedAt = m.t; serverWrite(); return true;
    case "unpin": if (s.pinnedAt == null) return false; s.pinnedAt = null; serverWrite(); return true;
    case "snooze": s.snoozedUntil = m.t + a.ms; serverWrite(); return true;
    case "unsnooze": if (s.snoozedUntil == null) return false; s.snoozedUntil = null; serverWrite(); return true;
    case "rest": s.rest = { rest: a.r, at: m.t }; serverWrite(); return true;
    case "advance":
      passTime(w, a.ms, true);
      if (m.connected) push(w);
      return true;
    case "suspend":
      // Asleep: no ticks, no pushes; the wake runs the hold's check.
      passTime(w, a.ms, false);
      holdCheck(m);
      fire(w.wakes);
      return true;
    case "disconnect":
      if (!m.connected) return false;
      m.connected = false;
      holdCheck(m);
      fire(w.conns);
      return true;
    case "reconnect":
      if (m.connected) return false;
      m.connected = true;
      push(w);
      holdCheck(m);
      fire(w.conns);
      return true;
    case "boot": {
      // A window launches from the persisted cache: its sessions and outbox
      // survive, its transcripts and hold do not. It boots as sync host.
      if (m.hold.running) return false;
      useInboxStore.setState({ messages: {}, livenessHeldAt: null } as any);
      m.transcriptOpen = false;
      m.hold.heldAt = null;
      m.hold.probe = null;
      holdBoot(m);
      w.stopHold = startLivenessHold(holdIO(w));
      await flush();
      return true;
    }
    case "demote":
      // The election demotes the window to follower, which stops the machine.
      if (!m.hold.running || !w.stopHold) return false;
      holdStop(m);
      w.stopHold();
      w.stopHold = null;
      await flush();
      return true;
    case "probeAnswer": {
      if (m.hold.probe == null || !w.probe) return false;
      const resolve = w.probe;
      w.probe = null;
      push(w);
      holdProbeAnswered(m);
      resolve(true);
      await flush();
      return true;
    }
  }
}

function realClientSection(w: World): string {
  if (!w.memo) __resetInboxPlacementCacheForTests();
  return placeInboxRows(store(), { now: Date.now() }).placements.get(ID)?.bucket ?? "absent";
}

// ── Properties over the whole run ───────────────────────────────────────────

function checkProperties(w: World, client: string): string | null {
  const m = w.m;
  const st = store();
  // No hold outlives its machine: nothing else can release it, and a held
  // clock freezes every time-driven placement (2026-11-04).
  if (!m.hold.running && st.livenessHeldAt != null) return `hold outlived its machine (livenessHeldAt=${st.livenessHeldAt - T0})`;
  // Nothing lands in Needs Input while a send of the person's is in flight.
  // Not yet true for a row whose snooze came due before the window learned
  // of it: the pending_send overlay skips any row carrying a snooze stamp
  // (finding F2 below). `strict` checks that case too.
  if (sendInFlight(m) && client === "needs_input" && (w.strict || !st.sessions[ID]?.inbox_snoozed_until)) return "needs_input while a send is in flight";
  // An echoed send leaves the in-flight state.
  const pending = (st.pendingMessages?.[ID] ?? []) as Array<{ _clientId?: string; _isSettled?: boolean }>;
  for (const s of m.sends) {
    if (s.echoed && pending.some((p) => p._clientId === s.clientId && !p._isSettled)) return `echoed send ${s.clientId} still pending`;
  }
  // The window shows the agent's pin as the server holds it once a push
  // landed (the send's local clear must retire on the server's echo).
  if (m.connected && !m.sends.some((x) => !x.enqueued)) {
    const pin = st.sessions[ID]?.thread_state_status ?? null;
    if (pin !== m.server.pin) return `window pin ${pin} != server pin ${m.server.pin}`;
  }
  // A session whose agent ended its turn declaring done never sits in Working
  // past the bound: the idle grace after the settle, or the send placement
  // bound after the person's last send, plus the minute epoch.
  const s = m.server;
  const lastSend = m.sends.reduce((x, y) => Math.max(x, y.at), -Infinity);
  const bound = Math.max(s.statusAt + AGENT_IDLE_GRACE_MS, lastSend + PENDING_SEND_WORKING_TTL_MS) + MIN;
  if (m.connected && m.hold.heldAt == null && s.status === "done" && !s.queued && m.t >= bound && client === "working") {
    return `Working ${Math.round((m.t - s.statusAt) / 1000)}s after a declared done`;
  }
  return null;
}

// ── Runner ──────────────────────────────────────────────────────────────────

type Failure = { step: number; trace: string[]; message: string };

export async function runTrace(actions: Action[], opts: { memo?: boolean; strict?: boolean } = {}): Promise<Failure | null> {
  const w = freshWorld();
  w.memo = opts.memo ?? true;
  w.strict = opts.strict ?? false;
  const trace: string[] = [];
  try {
    for (let i = 0; i < actions.length; i++) {
      if (!(await step(w, actions[i]))) continue;
      trace.push(showAction(actions[i]));
      const m = w.m;
      const at = `t=+${Math.round((m.t - T0) / 1000)}s`;
      const wantServer: Section = serverSection(m);
      const gotServer = realServerSection(m);
      if (gotServer !== wantServer) return { step: i, trace, message: `${at} server: model ${wantServer}, code ${gotServer}` };
      const wantClient = clientSection(m);
      const gotClient = realClientSection(w);
      if (gotClient !== wantClient) return { step: i, trace, message: `${at} window: model ${wantClient}, code ${gotClient}` };
      const realHeld = store().livenessHeldAt ?? null;
      if (realHeld !== m.hold.heldAt) {
        return { step: i, trace, message: `${at} hold: model ${m.hold.heldAt == null ? "none" : m.hold.heldAt - T0}, code ${realHeld == null ? "none" : realHeld - T0}` };
      }
      const broken = checkProperties(w, gotClient);
      if (broken) return { step: i, trace, message: `${at} property: ${broken}` };
    }
    return null;
  } finally {
    w.stopHold?.();
  }
}

afterAll(() => setSystemTime());

async function assertRandomRuns(memo: boolean) {
  let shown: Failure | null = null;
  await fc.assert(
    fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 60, size: "max" }), async (actions) => {
      const f = await runTrace(actions, { memo });
      if (f) shown = f;
      return f === null;
    }),
    { numRuns: RUNS, seed: process.env.INBOX_MODEL_SEED ? Number(process.env.INBOX_MODEL_SEED) : undefined },
  ).catch((e) => {
    const f = shown as Failure | null;
    throw new Error(f ? `${f.message}\n  trace: ${f.trace.join(" → ")}\n\n${(e as Error).message.split("\n").slice(0, 3).join("\n")}` : String(e));
  });
}

describe("inbox lifecycle: model and code agree after every action", () => {
  // Every read of the window's placement is a fresh computation, so this run
  // checks the rules. The memo is checked by the finding below.
  it(`random action sequences, fresh placement (${RUNS} runs)`, () => assertRandomRuns(false), 120_000);
});

// Past bugs, as the minimal traces the run shrinks to when each fix is
// reverted. They pass on main; each fails again if its fix regresses.
const replay = (actions: Action[], opts?: { memo?: boolean; strict?: boolean }) => async () => {
  const f = await runTrace(actions, opts);
  expect(f ? `${f.message} | ${f.trace.join(" → ")}` : null).toBeNull();
};

describe("inbox lifecycle: past bugs stay fixed", () => {
  // 2026-11-04: a window boots as sync host, holds its clock at its cached
  // heartbeat, and is demoted; the hold outlived the machine and froze the
  // follower's placement (livenessHold.ts stop releases it).
  it("a demoted window drops its liveness hold", replay([
    { k: "boot" }, { k: "demote" }, { k: "stop", v: "done" }, { k: "advance", ms: 2 * MIN },
  ]));
  // 2026-11-04: a send this window never sees confirmed kept the row in
  // Working for days (PENDING_SEND_WORKING_TTL_MS bounds the placement).
  it("an unconfirmed send stops holding Working after its bound", replay([
    { k: "send" }, { k: "advance", ms: 60 * MIN },
  ]));
  // 2026-11-04: the send clears the pin as undefined, the server echoes null,
  // and the lock never retired, masking every later pin
  // (syncProtocol.ts OPTIONAL_INBOX_TIMESTAMPS).
  it("the agent's next pin lands after a send cleared the old one", replay([
    { k: "stop", v: "done" }, { k: "send" }, { k: "enqueue" }, { k: "deliver" }, { k: "stop", v: "dormant" },
  ]));
});

// Known findings: disagreements on main that are real bugs, as minimal
// traces. Todo until the product is fixed (`bun test --todo` runs them).
describe("inbox lifecycle: findings", () => {
  // F1. placeInboxRows memoizes on pendingSendWakeSig, which lists the
  // conversations holding an unconfirmed send with no time bound, and the
  // deadline signature has no term for PENDING_SEND_WORKING_TTL_MS. So the
  // key does not move when an old send ages past the bound, or when a new
  // send joins a conversation that still holds an expired one. Here the first
  // send never reached the server; an hour later the agent's status decays to
  // idle and the row files under Needs Input; the person sends again and the
  // memo returns Needs Input until the server's push or the next minute.
  // The other direction (send, wait 10m 1s inside one minute) keeps Working
  // up to a minute past the bound.
  test.todo("F1: a new send into a row holding an expired one moves it to Working at once", replay([
    { k: "send" }, { k: "advance", ms: 121 * MIN }, { k: "send" },
  ], { memo: true }));
  test.todo("F1 (random): the memoized chokepoint agrees with the model", () => assertRandomRuns(true), 120_000);

  // F2. The pending_send overlay skips any row carrying inbox_snoozed_until
  // (placeInboxRows placeRowWithOverlays), including a snooze that already
  // came due and files the row under Needs Input. A snooze set on another
  // device while this window was offline comes due; the person sends here;
  // until the outbox reaches the server (whose enqueue clears the snooze) the
  // row reads Needs Input with the person's send in flight.
  test.todo("F2: a send in flight lifts a row whose snooze came due", replay([
    { k: "disconnect" }, { k: "snooze", ms: 10 * MIN }, { k: "advance", ms: 10 * MIN }, { k: "send" }, { k: "reconnect" },
  ], { strict: true }));
});
