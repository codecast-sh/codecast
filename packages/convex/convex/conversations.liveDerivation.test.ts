import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  computeInboxSessions,
  computeSessionsLiveness,
  collectInboxSessionsByIds,
  collectInboxSessionsPaginated,
  tallyInboxRows,
  INBOX_PROJECTION_FIELDS,
  INBOX_LIVENESS_FIELDS,
  INBOX_FAST_FIELDS,
  _resetChildAuqProbeCacheForTests,
} from "./conversations";
import { INBOX_PINNED_CAP } from "./inboxProjection";
import {
  AGENT_IDLE_GRACE_MS,
  STATUS_TRUST_TTL_MS,
  HEARTBEAT_ALIVE_MS,
} from "./inboxFilters";
import { digestProjection, inboxEpoch, INBOX_FACT_FIELDS, INBOX_PROJECTION_VERSION, deriveLiveAt, trustedStatusAt, rowLiveDeadlines, computeBucketStale, placeProjectableRow, rollupParentIdOf, type InboxBucket } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";

// The server half of sync-convergence (docs/architecture/sync-convergence.md):
// the liveness overlay stamps one deterministic projection per execution —
// bucket, work_state, asking, below_fold, the time flip — plus a tally and a
// digest; the base list, the crawl and the byIds fetch never carry any of it.

import { ME, MIN, H, NOW, EPOCH, LIVENESS_FIELDS, conv, db, countingCtx } from "./conversations.projection.testkit";

// The replica's live derivation matches the server's. Split out of
// conversations.projection.test.ts for its max-lines cap.

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); _resetChildAuqProbeCacheForTests(); });
afterEach(() => { nowSpy.mockRestore(); delete process.env.INBOX_DIGEST_DISABLED; });

describe("the replica's live derivation is the server's", () => {
  test("refreshed dormant background work agrees across the CLI, overlay, and replica", async () => {
    const tables = {
      conversations: [conv("dormant", { updated_at: EPOCH - 3 * H, thread_state_status: "dormant" })],
      managed_sessions: [{
        _id: "ms_dormant", user_id: ME, conversation_id: "conversations_dormant",
        last_heartbeat: EPOCH - 5_000, agent_status: "dormant", agent_status_updated_at: EPOCH - 3 * H,
        open_tasks: [{ id: "bjmsej5ia", kind: "background" }], open_tasks_at: EPOCH - MIN,
      }],
    };
    // The report's age does not lapse the vouch; the daemon's heartbeat does.
    for (const [tasks, at, heartbeat, expected] of [
      [tables.managed_sessions[0].open_tasks, EPOCH - MIN, EPOCH - 5_000, "dormant"],
      [tables.managed_sessions[0].open_tasks, EPOCH - 11 * MIN, EPOCH - 5_000, "dormant"],
      [tables.managed_sessions[0].open_tasks, EPOCH - MIN, EPOCH - 11 * MIN, "needs_input"],
      [[], EPOCH - MIN, EPOCH - 5_000, "needs_input"],
    ] as const) {
      const input = { ...tables, managed_sessions: [{ ...tables.managed_sessions[0], open_tasks: tasks, open_tasks_at: at, last_heartbeat: heartbeat }] };
      const { liveness } = await computeSessionsLiveness({ db: db(input) }, ME as any);
      const overlay = liveness.conversations_dormant;
      const cli = await computeInboxSessions({ db: db(input) }, ME as any, { show_all: true, projection: true });
      const row = cli.sessions.find((s: any) => s._id === "conversations_dormant");
      const replica = placeProjectableRow({ ...tables.conversations[0], ...overlay }, false, EPOCH);
      expect(overlay).toMatchObject({ bucket: expected, work_state: expected });
      expect(row).toMatchObject({ bucket: expected, work_state: expected });
      expect(replica).toEqual({ bucket: expected, work_state: expected });
    }
  });

  test("deriveLiveAt at the epoch equals the shipped live fields; rowLiveDeadlines + computeBucketStale equal the shipped flip", async () => {
    const tables = {
      conversations: [
        conv("graced", { updated_at: EPOCH - 30_000, message_count: 6 }),
        conv("decay", { updated_at: EPOCH - 2 * H, message_count: 40 }),
        conv("unanswered", { updated_at: EPOCH - 2 * MIN, message_count: 12, last_message_role: "user" }),
        conv("parent", { updated_at: EPOCH - 10 * MIN, message_count: 9 }),
        conv("child", { is_subagent: true, parent_conversation_id: "conversations_parent", updated_at: EPOCH - 2 * MIN, message_count: 4 }),
        conv("waiting", { updated_at: EPOCH - 3 * H, message_count: 20 }),
        conv("dormant", { updated_at: EPOCH - 3 * H, message_count: 275, thread_state_status: "dormant" }),
        conv("done", { updated_at: EPOCH - 5 * H, message_count: 30, thread_state_status: "done" }),
        conv("dead", { updated_at: EPOCH - 3 * MIN, message_count: 7 }),
        conv("own", { updated_at: EPOCH - MIN, message_count: 3 }),
      ],
      managed_sessions: [
        { _id: "ms_graced", user_id: ME, conversation_id: "conversations_graced", last_heartbeat: EPOCH - 5_000, agent_status: "idle", agent_status_updated_at: EPOCH - 30_000 },
        { _id: "ms_decay", user_id: ME, conversation_id: "conversations_decay", last_heartbeat: EPOCH - 5_000, agent_status: "working", agent_status_updated_at: EPOCH - 2 * H },
        { _id: "ms_parent", user_id: ME, conversation_id: "conversations_parent", last_heartbeat: EPOCH - 5_000, agent_status: "idle", agent_status_updated_at: EPOCH - 10 * MIN },
        { _id: "ms_child", user_id: ME, conversation_id: "conversations_child", last_heartbeat: EPOCH - 5_000, agent_status: "working", agent_status_updated_at: EPOCH - 2 * MIN },
        { _id: "ms_waiting", user_id: ME, conversation_id: "conversations_waiting", last_heartbeat: EPOCH - 5_000, agent_status: "waiting", agent_status_updated_at: EPOCH - 3 * H, open_tasks: [{ id: "t1" }], open_tasks_at: EPOCH - 4 * MIN },
        { _id: "ms_dormant", user_id: ME, conversation_id: "conversations_dormant", last_heartbeat: EPOCH - 5_000, agent_status: "dormant", agent_status_updated_at: EPOCH - 3 * H, open_tasks: [{ id: "bjmsej5ia" }], open_tasks_at: EPOCH - MIN },
        { _id: "ms_done", user_id: ME, conversation_id: "conversations_done", last_heartbeat: EPOCH - 5 * H, agent_status: "done", agent_status_updated_at: EPOCH - 5 * H },
        { _id: "ms_dead", user_id: ME, conversation_id: "conversations_dead", last_heartbeat: EPOCH - 4 * MIN, agent_status: "working", agent_status_updated_at: EPOCH - 3 * MIN },
        { _id: "ms_own", user_id: ME, conversation_id: "conversations_own", last_heartbeat: EPOCH - 1000, agent_status: "permission_blocked", agent_status_updated_at: EPOCH - MIN },
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    let checkedLive = 0;
    let checkedFlip = 0;
    for (const [cid, row] of Object.entries<any>(liveness)) {
      const conv = tables.conversations.find((c: any) => c._id === cid)!;
      const facts = { ...conv, ...row };
      const live = deriveLiveAt(facts, EPOCH);
      expect({ is_idle: live.is_idle, is_unresponsive: live.is_unresponsive, awaiting_input: live.awaiting_input, is_connected: live.daemon_alive })
        .toEqual({ is_idle: row.is_idle, is_unresponsive: row.is_unresponsive, awaiting_input: row.awaiting_input, is_connected: row.is_connected });
      // The status ships raw, the daemon's own word; the verdict is derived.
      expect(row.agent_status).toBe(tables.managed_sessions.find((m) => m.conversation_id === cid)?.agent_status ?? null);
      checkedLive++;
      // The flip: members whose asking cannot change with time (false, and an
      // ask only ever drops) and that ride no lead.
      if (row.bucket === undefined || row.asking || rollupParentIdOf(conv as any)) continue;
      const stale = computeBucketStale(
        {
          deadlines: rowLiveDeadlines(facts),
          placeAt: (t) => placeProjectableRow({ ...facts, ...deriveLiveAt(facts, t) }, false, t),
          current: row.bucket,
        },
        EPOCH,
      );
      expect(stale).toEqual({ bucket_stale_at: row.bucket_stale_at, stale_bucket: row.stale_bucket });
      checkedFlip++;
    }
    expect(checkedLive).toBeGreaterThanOrEqual(8);
    expect(checkedFlip).toBeGreaterThanOrEqual(5);
    expect(liveness.conversations_graced).toMatchObject({ agent_status_updated_at: EPOCH - 30_000, last_role_is_user: false, is_idle: false });
    // Settled with a producing subagent: idle, and parked on the child.
    expect(liveness.conversations_parent).toMatchObject({ is_idle: true, bucket: "dormant" });
    expect(liveness.conversations_parent.producing_until).toBeGreaterThan(EPOCH);
    expect(liveness.conversations_unanswered).toMatchObject({ last_role_is_user: true, agent_status: null });
    // Both ship the daemon's stale "working"; what they say is the verdict a
    // reader derives from it: decayed to idle, and stopped once the heartbeat
    // lapsed.
    expect(liveness.conversations_decay).toMatchObject({ agent_status: "working", is_idle: true });
    expect(trustedStatusAt(liveness.conversations_decay, EPOCH)).toBe("idle");
    expect(liveness.conversations_dead).toMatchObject({ agent_status: "working", is_connected: false });
    expect(trustedStatusAt(liveness.conversations_dead, EPOCH)).toBe("stopped");
  });
});

