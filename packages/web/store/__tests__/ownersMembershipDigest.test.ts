// The inbox digest compare and an owners change in flight: while the viewer's
// own Add me holds its lock on the inbox row's owned_by_me stamp, the replica
// files the session as theirs before the server does, and the compare holds
// that row dark (an owners stamp is a triage field, bounded the same); once
// the lock retires and the server's row agrees, the compare is clean again,
// by its short-circuit.
import { beforeEach, expect, test } from "bun:test";
import { INBOX_PROJECTION_VERSION, inboxEpoch } from "@codecast/shared/contracts";
import { evaluateInboxCompare, type InboxCompareState } from "../inboxDigestCompare";
import { projectReplicaInbox, type InboxProjectionStamp, type InboxSession, type SessionsProjectionSlot } from "../inboxStore";
import type { SessionOwnersRow } from "../sessionOwnersSlice";
import { __resetSyncActivityForTests } from "../syncActivity";
import { collectTriagePendingIds } from "../inboxOverlays";

const MIN = 60_000;
const H = 60 * MIN;
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);
const MONO = 500_000;
const ME = "u".repeat(32);
const ASHOT = "v".repeat(32);
const CRAWL_KEY = "sessions:v2:inbox:" + ME;
const S = ("s" + "0".repeat(32)).slice(0, 32);
const MINE = ("m" + "0".repeat(32)).slice(0, 32);

function row(id: string, extra: Partial<InboxSession> = {}): InboxSession {
  return {
    _id: id, session_id: `sess-${id.slice(0, 2)}`, agent_type: "claude_code", user_id: ASHOT, status: "active",
    updated_at: EPOCH - 10 * MIN, message_count: 3, is_idle: true, agent_status: "idle", has_pending: false,
    agent_status_updated_at: EPOCH - 10 * MIN, last_heartbeat: EPOCH + H, daemon_alive_until: EPOCH + 2 * H, last_role_is_user: false,
    owners_model: true, owned_by_me: false, implicit_owner: null,
    ...extra,
  } as InboxSession;
}

const read = (people: string[]): SessionOwnersRow => ({
  _id: S, people_ids: people, people_info: {}, role: null, parent_session: null, implicit_starter: null,
  starter_id: ASHOT, role_started: false, can_edit: true, owners_changed_at: 1,
});

function state(sessions: Record<string, InboxSession>, over: Partial<InboxCompareState> & { sessionOwners?: Record<string, SessionOwnersRow> } = {}): InboxCompareState {
  return {
    sessions, sessionsWithQueuedMessages: new Set(), pendingMessages: {},
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: false } }, currentUser: { _id: ME },
    sessionsProjection: {}, sessionDecisions: {}, questionResolutions: {}, pendingSessionCreates: {}, blockedReviveRequestedAt: {},
    currentSessionId: null, pending: {}, syncMeta: { [CRAWL_KEY]: { backfilledAt: NOW - 24 * H } }, syncProgress: {},
    ...over,
  } as InboxCompareState;
}

// The server's run of the shared module over its own rows.
function serverSlot(server: InboxCompareState): SessionsProjectionSlot {
  const { proj } = projectReplicaInbox(server, { scope: "mine", focusedId: null, epoch: EPOCH, now: EPOCH });
  const stamps: Record<string, InboxProjectionStamp> = {};
  for (const [id, p] of proj.placements) stamps[id] = { bucket: p.bucket, work_state: p.work_state, asking: false, below_fold: p.below_fold, bucket_stale_at: null, stale_bucket: null };
  return { v: INBOX_PROJECTION_VERSION, epoch: EPOCH, receivedAtMono: MONO, tally: proj.tally, set_digest: proj.set_digest, truncated: [...proj.truncated], stamps };
}
const ctx = { now: NOW, nowMono: MONO + 1_000, crawlMetaKey: CRAWL_KEY, lastApplyMono: MONO - 10 * MIN, inflight: 0 };

beforeEach(() => __resetSyncActivityForTests());

test("no drift while your Add me holds the lock, and none after it retires", () => {
  const mine = row(MINE, { user_id: ME, owned_by_me: true });
  // The server has not seen the Add me: the session is not yours there.
  const before = state({ [S]: row(S), [MINE]: mine });
  const slot = serverSlot(before);
  // The replica painted it: the row says it is yours, under the lock.
  const lock = { [`sessions:${S}:owned_by_me`]: { type: "field", value: true, ts: NOW - 1_000 } } as any;
  const inFlight = state({ [S]: row(S, { owned_by_me: true }), [MINE]: mine }, { pending: lock, sessionsProjection: { mine: slot } });
  expect(projectReplicaInbox(inFlight, { scope: "mine", focusedId: null, epoch: EPOCH, now: EPOCH }).proj.placements.has(S)).toBe(true);
  expect(evaluateInboxCompare(inFlight, ctx)).toMatchObject({ kind: "clean" });

  // The echo: the lock retired, and the server's row now says it is yours.
  const after = state({ [S]: row(S, { owned_by_me: true }), [MINE]: mine });
  const settled = state({ [S]: row(S, { owned_by_me: true }), [MINE]: mine }, { sessionOwners: { [S]: read([ASHOT, ME]) }, sessionsProjection: { mine: serverSlot(after) } });
  expect(evaluateInboxCompare(settled, ctx)).toMatchObject({ kind: "clean", short_circuit: true });
});

test("a stale owners read is no drift: the row's stamps decide", () => {
  const mine = row(MINE, { user_id: ME, owned_by_me: true });
  const server = state({ [S]: row(S), [MINE]: mine });
  const stale = state({ [S]: row(S), [MINE]: mine }, { sessionOwners: { [S]: read([ASHOT, ME]) }, sessionsProjection: { mine: serverSlot(server) } });
  expect(evaluateInboxCompare(stale, ctx)).toMatchObject({ kind: "clean" });
});

test("an org_role_id lock on a row off the owners model darkens nothing, as on main; under the model it does", () => {
  const lock = { [`sessions:${S}:org_role_id`]: { type: "field", value: "r1", ts: NOW - 1_000 } } as any;
  expect([...collectTriagePendingIds(lock, NOW, { [S]: row(S, { owners_model: undefined }) })]).toEqual([]);
  expect([...collectTriagePendingIds(lock, NOW, { [S]: row(S) })]).toEqual([S]);
});
