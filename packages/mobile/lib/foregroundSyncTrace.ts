// One trace per return from the background: how long until the open
// conversation shows what the server already has, and where the time goes.
//
// A phone that sat in the background comes back to a socket iOS may have
// dropped, a store that missed every push since, and a JS thread that has to
// absorb a reconnect's worth of query results at once. The server side of that
// is in Convex's logs; this is the phone's side, sent as one
// `mobile_foreground_sync` event so a reported "the message wasn't there for
// minutes" can be read step by step: did the socket look alive, did it
// reconnect, when did the first server message land, how far behind was the
// conversation, when did the store catch up, when did a frame follow, and how
// long the JS thread was stalled in between.
import { AppState, type AppStateStatus } from 'react-native';
import { api } from '@codecast/convex/convex/_generated/api';
import { socketStats } from '@/lib/socketStats';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { convex } from '@/lib/convex';
import { track } from '@/lib/analytics';
import { currentRoute, lastCatchUp, socketState, newestLocalTimestamp as lastTimestamp, sessionIdFromRoute } from '@/lib/foregroundResume';

const TICK_MS = 200;
const WS_STATES = ['ready', 'connecting', 'disconnected', 'stopped', 'terminated', 'unknown'] as const;
const TIMEOUT_MS = 5 * 60_000;
// A return with nothing new still waits this long for the reconnect to show,
// so a fast "up to date" carries its socket numbers too.
const UP_TO_DATE_HOLD_MS = 3_000;

let started = false;

type Trace = { finish: (outcome: 'backgrounded') => void };

function beginTrace(awayMs: number): Trace {
  const t0 = Date.now();
  const since = (t: number) => (t ? t - t0 : -1);
  const convId = sessionIdFromRoute(currentRoute());
  const state0 = convex.connectionState();
  const wsState0 = socketState();
  const opens0 = socketStats.opens;
  const msgs0 = socketStats.messagesIn;
  const socketIdleMs = socketStats.lastMessageAt ? t0 - socketStats.lastMessageAt : -1;

  const local0 = convId ? lastTimestamp(convId) : 0;
  let firstRowsAt = 0;
  let reconnectAt = 0;
  let firstMsgAt = 0;
  let probeAt = 0;
  let behindRows = -1;
  let serverNewest = 0;
  let storeAt = 0;
  let paintAt = 0;
  let maxStall = 0;
  let stall = 0;
  let heldMax = socketStats.heldMutations;
  let activeMax = socketStats.activeMutations;
  let done = false;
  let prevTick = t0;

  const finish = (outcome: 'caught_up' | 'up_to_date' | 'backgrounded' | 'timeout') => {
    if (done) return;
    done = true;
    clearInterval(timer);
    const http = convId && lastCatchUp.convId === convId && lastCatchUp.at >= t0 ? lastCatchUp : null;
    const pending = convId ? (useInboxStore.getState().pendingMessages[convId]?.length ?? 0) : 0;
    const props = {
      outcome,
      on_session: !!convId,
      away_ms: awayMs,
      ws_up_at_start: state0.isWebSocketConnected,
      ws_state_at_start: WS_STATES.includes(wsState0 as (typeof WS_STATES)[number]) ? wsState0 : 'unknown',
      socket_idle_ms: socketIdleMs,
      reconnect_ms: since(reconnectAt),
      first_msg_ms: since(firstMsgAt),
      probe_ms: since(probeAt),
      behind_rows: behindRows,
      first_rows_ms: since(firstRowsAt),
      http_rows_ms: http ? http.at - t0 : -1,
      http_rows: http ? http.rows : -1,
      store_ms: since(storeAt),
      paint_ms: since(paintAt),
      duration_ms: Date.now() - t0,
      max_stall_ms: maxStall,
      stall_ms: stall,
      msgs_in: socketStats.messagesIn - msgs0,
      held_mutations_max: heldMax,
      active_mutations_max: activeMax,
      pending_sends: pending,
    };
    if (__DEV__) console.log('[foreground-sync]', JSON.stringify(props));
    track('mobile_foreground_sync', props);
  };

  const timer = setInterval(() => {
    const now = Date.now();
    // An interval that fires late is time the JS thread spent on something
    // else: the reconnect's query results, a store apply, a render.
    const late = now - prevTick - TICK_MS;
    prevTick = now;
    if (late > 0) {
      stall += late;
      if (late > maxStall) maxStall = late;
    }
    heldMax = Math.max(heldMax, socketStats.heldMutations);
    activeMax = Math.max(activeMax, socketStats.activeMutations);
    if (!reconnectAt && socketStats.opens > opens0) reconnectAt = socketStats.lastOpenAt;
    if (!firstMsgAt && socketStats.lastMessageAt > t0) firstMsgAt = socketStats.lastMessageAt;
    if (convId && !firstRowsAt && lastTimestamp(convId) > local0) firstRowsAt = now;
    if (convId && behindRows > 0 && !storeAt && lastTimestamp(convId) >= serverNewest) {
      storeAt = now;
      requestAnimationFrame(() => {
        paintAt = Date.now();
        finish('caught_up');
      });
    }
    if (probeAt && behindRows === 0 && now - t0 >= UP_TO_DATE_HOLD_MS) finish('up_to_date');
    if (!convId && now - t0 >= UP_TO_DATE_HOLD_MS) finish('up_to_date');
    if (now - t0 >= TIMEOUT_MS) finish('timeout');
  }, TICK_MS);

  // What the server has that this phone does not: the rows after the newest
  // one the store holds. Its answer time is also a plain round trip through
  // whatever socket the client is on.
  if (convId) {
    convex
      .query(api.conversations.listMessagesTail, { conversation_id: convId, after_timestamp: lastTimestamp(convId) })
      .then((res: any) => {
        if (done) return;
        probeAt = Date.now();
        const rows = res?.messages ?? [];
        behindRows = rows.length;
        serverNewest = rows.length ? rows[rows.length - 1].timestamp : 0;
      })
      .catch(() => {});
  }

  return { finish };
}

/** Starts watching AppState. Idempotent. */
export function startForegroundSyncTrace() {
  if (started) return;
  started = true;
  let backgroundAt = 0;
  let trace: Trace | null = null;
  AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'background') {
      backgroundAt = Date.now();
      trace?.finish('backgrounded');
      trace = null;
    } else if (next === 'active' && backgroundAt) {
      trace = beginTrace(Date.now() - backgroundAt);
      backgroundAt = 0;
    }
  });
}
