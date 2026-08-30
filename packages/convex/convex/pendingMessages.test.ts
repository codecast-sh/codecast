import { describe, expect, test } from "bun:test";
import {
  canDaemonSeePendingMessage,
  claimPendingMessageForDaemon,
  collectOldLegacyPendingMessages,
  collectDeliverableForOwner,
  isControlMessage,
  markPendingDelivered,
  planStuckMessageHeal,
  resetConversationPendingMessages,
  updatePendingMessageStatusForDaemon,
  cancelQueuedMessagesOnKill,
  updateMessageStatus,
} from "./pendingMessages";
import { makeFakeDb } from "./testDb";

describe("collectOldLegacyPendingMessages", () => {
  test("reads only by_status and excludes recent and fenced rows", async () => {
    const cutoff = 1_000;
    const rowsByStatus: Record<string, any[]> = {
      pending: [
        { _id: "old-pending", status: "pending", created_at: 100 },
        { _id: "recent-pending", status: "pending", created_at: cutoff },
      ],
      injected: [
        { _id: "old-injected", status: "injected", created_at: 200 },
      ],
      failed: [
        {
          _id: "fenced-failed",
          status: "failed",
          created_at: 300,
          delivery_protocol_version: 2,
        },
      ],
      undeliverable: [],
    };
    const indexReads: Array<{ index: string; status: string }> = [];
    const ctx = {
      db: {
        query(table: string) {
          expect(table).toBe("pending_messages");
          return {
            withIndex(index: string, builder: (q: any) => unknown) {
              let status = "";
              const q = {
                eq(field: string, value: string) {
                  expect(field).toBe("status");
                  status = value;
                  return q;
                },
              };
              builder(q);
              indexReads.push({ index, status });
              return {
                order(direction: string) {
                  expect(direction).toBe("asc");
                  return this;
                },
                async take(limit: number) {
                  expect(limit).toBe(500);
                  return rowsByStatus[status] ?? [];
                },
              };
            },
          };
        },
      },
    };

    const matches = await collectOldLegacyPendingMessages(ctx as any, cutoff);

    expect(matches.map((row) => row._id)).toEqual([
      "old-pending",
      "old-injected",
    ]);
    expect(indexReads).toEqual([
      { index: "by_status", status: "pending" },
      { index: "by_status", status: "injected" },
      { index: "by_status", status: "failed" },
      { index: "by_status", status: "undeliverable" },
    ]);
  });
});

// Fake ctx.db that records patches and answers by_conversation_status lookups from a
// configurable set of "other" rows still in flight for the conversation.
const createCtx = ({
  remainingByStatus = {},
  conversationExists = true,
}: {
  remainingByStatus?: Record<string, any>;
  conversationExists?: boolean;
}) => {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      query(_table: string) {
        let status = "";
        return {
          withIndex(_index: string, builder: (q: any) => unknown) {
            const q = {
              eq(field: string, value: string) {
                if (field === "status") status = value;
                return q;
              },
            };
            builder(q);
            return {
              async first() {
                return remainingByStatus[status] ?? null;
              },
            };
          },
        };
      },
      async patch(id: string, patch: Record<string, unknown>) {
        patches.push({ id, patch });
      },
      async get(id: string) {
        return conversationExists ? { _id: id } : null;
      },
    },
  };
  return { ctx, patches };
};

describe("markPendingDelivered", () => {
  test("promotes an injected message to delivered and clears the conversation flag when drained", async () => {
    const { ctx, patches } = createCtx({ remainingByStatus: {} });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "injected",
    });

    const msgPatch = patches.find((p) => p.id === "m1");
    expect(msgPatch?.patch.status).toBe("delivered");
    expect(typeof msgPatch?.patch.delivered_at).toBe("number");

    const convPatch = patches.find((p) => p.id === "c1");
    expect(convPatch?.patch).toEqual({ has_pending_messages: false });
  });

  test("is a no-op for an already-delivered message (delivered is terminal)", async () => {
    const { ctx, patches } = createCtx({ remainingByStatus: {} });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "delivered",
    });
    expect(patches).toHaveLength(0);
  });

  test("is a no-op for a cancelled message (cancelled is terminal)", async () => {
    const { ctx, patches } = createCtx({ remainingByStatus: {} });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "cancelled",
    });
    expect(patches).toHaveLength(0);
  });

  test("terminalizes an orphaned message without patching a deleted conversation", async () => {
    const { ctx, patches } = createCtx({
      remainingByStatus: {},
      conversationExists: false,
    });
    await markPendingDelivered(ctx as any, {
      _id: "m-orphan" as any,
      conversation_id: "c-missing" as any,
      status: "injected",
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      id: "m-orphan",
      patch: { status: "delivered" },
    });
  });

  test("does NOT clear the conversation flag while another pending message remains", async () => {
    const { ctx, patches } = createCtx({
      remainingByStatus: { pending: { _id: "m2" } },
    });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "pending",
    });

    expect(patches.find((p) => p.id === "m1")?.patch.status).toBe("delivered");
    expect(patches.find((p) => p.id === "c1")).toBeUndefined();
  });

  test("does NOT clear the conversation flag while another injected message remains", async () => {
    const { ctx, patches } = createCtx({
      remainingByStatus: { injected: { _id: "m3" } },
    });
    await markPendingDelivered(ctx as any, {
      _id: "m1" as any,
      conversation_id: "c1" as any,
      status: "injected",
    });

    expect(patches.find((p) => p.id === "m1")?.patch.status).toBe("delivered");
    expect(patches.find((p) => p.id === "c1")).toBeUndefined();
  });
});

const createOwnerCtx = (records: Record<string, any>) => {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      async get(id: string) {
        return records[id] ?? null;
      },
      async patch(id: string, patch: Record<string, unknown>) {
        patches.push({ id, patch });
        records[id] = { ...records[id], ...patch };
      },
      query(_table: string) {
        return {
          withIndex(_index: string, builder: (q: any) => unknown) {
            builder({ eq: () => ({ eq: () => {} }) });
            return {
              async first() {
                return null;
              },
            };
          },
        };
      },
    },
  };
  return { ctx, patches, records };
};

describe("daemon pending-message ownership", () => {
  test("only the owner daemon can see, claim, and mark a pending row", async () => {
    const records: Record<string, any> = {
      c1: { _id: "c1", user_id: "u1", owner_device_id: "dev-owner" },
      m1: { _id: "m1", conversation_id: "c1", from_user_id: "u1", status: "pending", retry_count: 0 },
    };
    const { ctx, patches } = createOwnerCtx(records);

    expect(canDaemonSeePendingMessage(records.m1 as any, records.c1 as any, "u1" as any, "dev-owner")).toBe(true);
    expect(canDaemonSeePendingMessage(records.m1 as any, records.c1 as any, "u1" as any, "dev-other")).toBe(false);

    await expect(claimPendingMessageForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-other")).resolves.toBeNull();
    expect(patches).toHaveLength(0);

    const skipped = await updatePendingMessageStatusForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-other", { status: "injected" });
    expect(skipped).toEqual({ updated: false, skipped: true });
    expect(patches).toHaveLength(0);

    const claimed = await claimPendingMessageForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-owner");
    expect(claimed?._id).toBe("m1");

    const updated = await updatePendingMessageStatusForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-owner", { status: "injected" });
    expect(updated).toEqual({ updated: true, skipped: false });
    expect(patches).toEqual([{ id: "m1", patch: { status: "injected" } }]);
  });

  test("a cross-user (team) row is seen/claimed by the OWNER daemon, not the sender", async () => {
    // Alice (u-alice) sent to Bob's conversation (owned by u-bob). The row carries owner_user_id=u-bob.
    const records: Record<string, any> = {
      cBob: { _id: "cBob", user_id: "u-bob", owner_device_id: "dev-bob" },
      m1: { _id: "m1", conversation_id: "cBob", from_user_id: "u-alice", owner_user_id: "u-bob", status: "pending", retry_count: 0 },
    };
    const { ctx } = createOwnerCtx(records);

    // The sender's daemon must NOT be able to see or claim it.
    expect(canDaemonSeePendingMessage(records.m1 as any, records.cBob as any, "u-alice" as any, "dev-alice")).toBe(false);
    await expect(claimPendingMessageForDaemon(ctx as any, "m1" as any, "u-alice" as any, "dev-alice")).resolves.toBeNull();

    // The owner's daemon sees and claims it.
    expect(canDaemonSeePendingMessage(records.m1 as any, records.cBob as any, "u-bob" as any, "dev-bob")).toBe(true);
    const claimed = await claimPendingMessageForDaemon(ctx as any, "m1" as any, "u-bob" as any, "dev-bob");
    expect(claimed?._id).toBe("m1");
  });

  test("legacy unowned conversations are atomically claimed before daemon delivery", async () => {
    const records: Record<string, any> = {
      c1: { _id: "c1", user_id: "u1" },
      m1: { _id: "m1", conversation_id: "c1", from_user_id: "u1", status: "pending", retry_count: 0 },
    };
    const { ctx, patches } = createOwnerCtx(records);

    const claimed = await claimPendingMessageForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-a");
    expect(claimed?._id).toBe("m1");
    expect(records.c1.owner_device_id).toBe("dev-a");
    expect(patches).toEqual([{ id: "c1", patch: { owner_device_id: "dev-a" } }]);

    await expect(claimPendingMessageForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-b")).resolves.toBeNull();
    expect(patches).toHaveLength(1);
  });

  test("terminal delivered and cancelled rows cannot be revived by daemon status updates", async () => {
    for (const status of ["delivered", "cancelled"]) {
      const records: Record<string, any> = {
        c1: { _id: "c1", user_id: "u1" },
        m1: { _id: "m1", conversation_id: "c1", from_user_id: "u1", status, retry_count: 4 },
      };
      const { ctx, patches } = createOwnerCtx(records);

      const result = await updatePendingMessageStatusForDaemon(ctx as any, "m1" as any, "u1" as any, "dev-owner", { status: "pending" });
      expect(result).toEqual({ updated: false, skipped: true });
      expect(patches).toHaveLength(0);
      expect(records.m1.status).toBe(status);
      expect(records.c1.owner_device_id).toBeUndefined();
    }
  });
});

// Fake ctx.db that answers the two delivery indexes the daemon poll unions, modelling the real
// Convex semantics: an index eq() on an unset optional field matches NOTHING (there is no entry
// to range over). This is exactly what made an un-stamped self-send invisible to the owner scan.
const createDeliverCtx = (rows: Array<Record<string, any>>, convs: Record<string, any>) => {
  const ctx = {
    db: {
      async get(id: string) {
        return convs[id] ?? null;
      },
      query(_table: string) {
        return {
          withIndex(indexName: string, builder: (q: any) => unknown) {
            const eqs: Record<string, any> = {};
            const q = { eq(field: string, value: any) { eqs[field] = value; return q; } };
            builder(q);
            const keyField = indexName === "by_owner_status" ? "owner_user_id" : "from_user_id";
            const matching = () => rows.filter((r) => r[keyField] === eqs[keyField] && r.status === eqs.status);
            return {
              async collect() {
                return matching();
              },
              async take(n: number) {
                return matching().slice(0, n);
              },
            };
          },
        };
      },
    },
  };
  return { ctx };
};

// Regression for the delivery outage: switching the daemon poll to the owner index dropped every
// self-send whose owner_user_id was never stamped (two of three insert paths forgot the field), so
// no web-composer message reached any agent. collectDeliverableForOwner unions the legacy
// from_user_id index back in as the safety net — a self-send must deliver regardless of that field.
describe("collectDeliverableForOwner", () => {
  test("delivers an un-stamped self-send via the from_user_id fallback, plus owner-routed team sends", async () => {
    const rows = [
      // The bug's exact shape: my own message with NO owner_user_id (written by a path that forgot it).
      { _id: "self_unowned", conversation_id: "cMine", from_user_id: "u1", status: "pending" },
      // A teammate's message into my conversation — only reachable via the owner index.
      { _id: "team_owned", conversation_id: "cMine", from_user_id: "u-alice", owner_user_id: "u1", status: "pending" },
      // Someone else's message — must never appear in my daemon's queue.
      { _id: "other_user", conversation_id: "cOther", from_user_id: "u2", owner_user_id: "u2", status: "pending" },
    ];
    const convs = {
      cMine: { _id: "cMine", user_id: "u1" },
      cOther: { _id: "cOther", user_id: "u2" },
    };
    const { ctx } = createDeliverCtx(rows, convs);

    const out = await collectDeliverableForOwner(ctx as any, "u1" as any, "dev1");
    expect(out.map((r) => r._id).sort()).toEqual(["self_unowned", "team_owned"]);
  });

  test("dedups a row that matches both indexes (owner == sender self-send)", async () => {
    const rows = [
      { _id: "both", conversation_id: "cMine", from_user_id: "u1", owner_user_id: "u1", status: "pending" },
    ];
    const convs = { cMine: { _id: "cMine", user_id: "u1" } };
    const { ctx } = createDeliverCtx(rows, convs);

    const out = await collectDeliverableForOwner(ctx as any, "u1" as any, "dev1");
    expect(out.map((r) => r._id)).toEqual(["both"]);
  });

  // Regression for the 2026-08-30 delivery outage: unbounded collects made this query's
  // cost track the pending backlog, so a backend brownout (which grows the backlog) was
  // exactly when the query timed out — wedging the daemon's subscription in a permanent
  // server-side error state. The scan is bounded now; a deep backlog drains in waves.
  test("bounds the scan so a deep backlog cannot make the query un-executable", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({
      _id: `m${i}`, conversation_id: "cMine", from_user_id: "u1", owner_user_id: "u1", status: "pending",
    }));
    const convs = { cMine: { _id: "cMine", user_id: "u1" } };
    const { ctx } = createDeliverCtx(rows, convs);

    const out = await collectDeliverableForOwner(ctx as any, "u1" as any, "dev1");
    expect(out.length).toBe(500);
    // Index order = oldest first, so the oldest slice delivers first.
    expect(out[0]._id).toBe("m0");
  });
});

describe("isControlMessage", () => {
  test("recognizes __cc_poll keystroke answers (keys and steps forms)", () => {
    expect(isControlMessage('{"__cc_poll":true,"keys":["1"],"display":"Default (recommended)"}')).toBe(true);
    expect(isControlMessage('{"__cc_poll":true,"steps":[{"key":"2"}]}')).toBe(true);
  });

  test("recognizes __cc_poll free-text answers (text form — declines the menu and types)", () => {
    // The web sends a custom/"Other" AUQ answer as prose in `text` with no keys/steps; it
    // must still route as a fire-and-forget control message so it isn't re-injected.
    expect(isControlMessage('{"__cc_poll":true,"text":"use the intro response","display":"x"}')).toBe(true);
  });

  test("treats normal user text and malformed JSON as non-control", () => {
    expect(isControlMessage("https://codecast.sh/conversation/x not responding")).toBe(false);
    expect(isControlMessage("go")).toBe(false);
    expect(isControlMessage('{"__cc_poll":true}')).toBe(false); // missing keys/steps/text
    expect(isControlMessage("{not json")).toBe(false);
  });
});

// Fake ctx.db that returns a fixed by_conversation_id collection and records patches.
const createCollectCtx = (messages: Array<Record<string, any>>) => {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      query() {
        return {
          withIndex(_index: string, builder: (q: any) => unknown) {
            builder({ eq: () => ({ eq: () => {} }) });
            return { async collect() { return messages; } };
          },
        };
      },
      async patch(id: string, patch: Record<string, unknown>) {
        patches.push({ id, patch });
      },
    },
  };
  return { ctx, patches };
};

// Regression: a message that never reached a dead session is left as injected/failed/
// undeliverable. resumeSession/restartSession call this on reconnect so those stranded
// messages get redelivered instead of staying stuck and forcing a manual resend.
describe("resetConversationPendingMessages", () => {
  test("re-pends stranded injected/failed/undeliverable messages, leaving pending/delivered alone", async () => {
    const messages = [
      { _id: "m_injected", status: "injected", retry_count: 3, delivered_at: 123 },
      { _id: "m_failed", status: "failed", retry_count: 5 },
      { _id: "m_undeliverable", status: "undeliverable", retry_count: 12 },
      { _id: "m_pending", status: "pending", retry_count: 0 },
      { _id: "m_delivered", status: "delivered", retry_count: 1, delivered_at: 456 },
      { _id: "m_cancelled", status: "cancelled", retry_count: 1 },
    ];
    const { ctx, patches } = createCollectCtx(messages);

    const count = await resetConversationPendingMessages(ctx as any, "c1" as any);
    expect(count).toBe(3);

    for (const id of ["m_injected", "m_failed", "m_undeliverable"]) {
      const p = patches.find((x) => x.id === id);
      expect(p?.patch.status).toBe("pending");
      expect(p?.patch.retry_count).toBe(0);
      expect("delivered_at" in (p?.patch ?? {})).toBe(true);
      expect(p?.patch.delivered_at).toBeUndefined();
    }
    // Already-pending and terminal-delivered rows must not be touched.
    expect(patches.find((x) => x.id === "m_pending")).toBeUndefined();
    expect(patches.find((x) => x.id === "m_delivered")).toBeUndefined();
    expect(patches.find((x) => x.id === "m_cancelled")).toBeUndefined();
    // Conversation is re-flagged as having pending work so the inbox/daemon notice it.
    expect(patches.find((x) => x.id === "c1")?.patch).toEqual({ has_pending_messages: true });
  });

  test("no-op when nothing is stranded (does not re-flag the conversation)", async () => {
    const messages = [
      { _id: "m_pending", status: "pending", retry_count: 0 },
      { _id: "m_delivered", status: "delivered", retry_count: 1 },
    ];
    const { ctx, patches } = createCollectCtx(messages);

    const count = await resetConversationPendingMessages(ctx as any, "c1" as any);
    expect(count).toBe(0);
    expect(patches).toHaveLength(0);
  });
});

// The cron healer's decision logic. Core invariant under test: it never abandons a message
// (undeliverable is non-terminal, and there is no age ceiling) and never consumes the
// real-attempt budget for waiting time.
describe("planStuckMessageHeal", () => {
  const now = 1_000_000_000_000;
  const recent = (status: string, content = "hi", ageMs = 5 * 60_000) =>
    planStuckMessageHeal({ status, content, created_at: now - ageMs }, now);

  test("revives undeliverable — it is NOT a dead-end", () => {
    expect(recent("undeliverable").kind).toBe("repend");
  });

  test("revives failed (transient sync failure)", () => {
    expect(recent("failed").kind).toBe("repend");
  });

  test("re-pends an injected message once the ack grace has elapsed (session likely died)", () => {
    expect(recent("injected", "real text", 3 * 60_000).kind).toBe("repend");
  });

  test("leaves a freshly-injected message alone so the JSONL ack can land", () => {
    expect(recent("injected", "real text", 30_000).kind).toBe("skip");
  });

  test("acks a stale injected control message instead of re-injecting keystrokes", () => {
    const control = '{"__cc_poll":true,"keys":["2"],"display":"Commit everything together"}';
    expect(recent("injected", control, 3 * 60_000).kind).toBe("deliver_control");
  });

  test("leaves a fresh pending message to the daemon's live subscription", () => {
    // Within the in-flight grace the daemon owns delivery — the cron must not race it
    // (and must never bump retry_count for waiting time, the original pending bug).
    expect(recent("pending", "real text", 30_000).kind).toBe("skip");
  });

  test("revives an abandoned pending message — a dropped status-write left it with no backstop", () => {
    // Past the grace, a still-pending row provably never landed (a delivered message is promoted
    // to terminal "delivered" by the content-match ack), so reviving it can't duplicate delivery.
    expect(recent("pending", "real text", 3 * 60_000).kind).toBe("repend");
  });

  test("does NOT revive a pending poll-keystroke control message (re-pending could double-select)", () => {
    const control = '{"__cc_poll":true,"keys":["2"],"display":"Commit everything together"}';
    expect(recent("pending", control, 3 * 60_000).kind).toBe("skip");
  });

  test("revives stranded messages regardless of age — a message must always reach delivery", () => {
    const old = 9 * 60 * 60_000; // 9h, well past the former 1h heal window
    expect(recent("undeliverable", "hi", old).kind).toBe("repend");
    expect(recent("failed", "hi", old).kind).toBe("repend");
    expect(recent("injected", "real text", old).kind).toBe("repend");
    expect(recent("pending", "real text", old).kind).toBe("repend");
  });
});

// Kill is TERMINAL for the messages already queued. The retry loop is otherwise
// indefinite, so a retained message could land long after the kill and revive a
// session still stamped inbox_killed_at (observed live), or — once its retries
// were exhausted — strand the row as completed + has_pending_messages forever.
describe("cancelQueuedMessagesOnKill", () => {
  const CONV = "c1";
  const mkDb = (rows: Array<Record<string, any>>, convExtra: Record<string, any> = {}) =>
    makeFakeDb({
      conversations: [{ _id: CONV, user_id: "u1", has_pending_messages: true, ...convExtra }],
      pending_messages: rows.map((r) => ({ conversation_id: CONV, retry_count: 0, ...r })),
    });

  test("cancels every non-terminal queued message and clears the conversation flag", async () => {
    const db = mkDb([
      { _id: "m_pending", status: "pending" },
      { _id: "m_injected", status: "injected" },
      { _id: "m_failed", status: "failed" },
      { _id: "m_undeliverable", status: "undeliverable" },
      { _id: "m_delivered", status: "delivered" },
      { _id: "m_cancelled", status: "cancelled" },
    ]);

    expect(await cancelQueuedMessagesOnKill({ db } as any, CONV as any)).toBe(4);
    const row = (id: string) => db._tables.pending_messages.find((r: any) => r._id === id)!;
    for (const id of ["m_pending", "m_injected", "m_failed", "m_undeliverable"]) {
      expect(row(id).status).toBe("cancelled");
    }
    expect(row("m_delivered").status).toBe("delivered");
    expect(db._tables.conversations[0].has_pending_messages).toBe(false);
  });

  // The stranded-row repair: a kill whose queue already went terminal still has
  // to clear the flag, or the row sits "completed + has pending work" forever.
  test("clears a stale has_pending_messages flag even with nothing left to cancel", async () => {
    const db = mkDb([{ _id: "m_delivered", status: "delivered" }]);
    expect(await cancelQueuedMessagesOnKill({ db } as any, CONV as any)).toBe(0);
    expect(db._tables.conversations[0].has_pending_messages).toBe(false);
  });

  // A queue deeper than one page must not survive a kill — the cancel drains,
  // it doesn't sample.
  test("drains a queue larger than one page", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ _id: `m${i}`, status: "pending" }));
    const db = mkDb(many);
    expect(await cancelQueuedMessagesOnKill({ db } as any, CONV as any)).toBe(250);
    expect(db._tables.pending_messages.every((r: any) => r.status === "cancelled")).toBe(true);
    expect(db._tables.conversations[0].has_pending_messages).toBe(false);
  });

  // Fenced (delivery-protocol v2) rows can't be patched to "cancelled" behind
  // the epoch machinery's back — kill routes them through its sanctioned cancel
  // instead, so kill is terminal on a fenced conversation too.
  test("cancels UNSTARTED fenced deliveries through the epoch machinery", async () => {
    const db = mkDb([
      { _id: "m_fenced", status: "pending", delivery_protocol_version: 2, delivery_status: "pending" },
    ], { execution_protocol_state: "fenced" });
    expect(await cancelQueuedMessagesOnKill({ db } as any, CONV as any)).toBe(1);
    expect(db._tables.pending_messages[0].status).toBe("cancelled");
    expect(db._tables.pending_messages[0].delivery_status).toBe("cancelled-by-supersession");
    expect(db._tables.conversations[0].has_pending_messages).toBe(false);
  });

  // Kill must never be the gesture that fails on exactly the sessions it exists
  // for. A runaway session's history is dominated by TERMINAL delivered rows, so
  // the sweep reads only the status-scoped index — collecting by_conversation_id
  // (the documented anti-pattern) is what blows the transaction's read limit.
  test("never reads the conversation's whole history — status-scoped indexes only", async () => {
    const history = Array.from({ length: 2000 }, (_, i) => ({ _id: `d${i}`, status: "delivered" }));
    const db = mkDb([...history, { _id: "m_live", status: "pending" }], { execution_protocol_state: "fenced" });
    const indexes: string[] = [];
    const rawQuery = db.query.bind(db);
    db.query = (table: string) => {
      const builder = rawQuery(table);
      const rawWithIndex = builder.withIndex.bind(builder);
      builder.withIndex = (name: string, fn?: any) => {
        if (table === "pending_messages") indexes.push(name);
        return rawWithIndex(name, fn);
      };
      return builder;
    };

    expect(await cancelQueuedMessagesOnKill({ db } as any, CONV as any)).toBe(1);
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.every((i) => i === "by_conversation_status")).toBe(true);
    expect(db._tables.pending_messages.filter((r: any) => r.status === "delivered")).toHaveLength(2000);
  });

  // The fenced sweep is the expensive one; an ordinary conversation must not pay
  // for it. (Its rows are legacy by construction, so there is nothing to find.)
  test("skips the fenced sweep entirely on a conversation that isn't fenced", async () => {
    const db = mkDb([{ _id: "m_pending", status: "pending" }]);
    const heads: string[] = [];
    const rawQuery = db.query.bind(db);
    db.query = (table: string) => { heads.push(table); return rawQuery(table); };
    await cancelQueuedMessagesOnKill({ db } as any, CONV as any);
    expect(heads).not.toContain("conversation_execution_heads");
  });

  // Overflow: one transaction cancels at most the budget and hands the rest to a
  // scheduled continuation, so the kill mutation itself always lands fast.
  test("caps one transaction at the budget and schedules the remainder", async () => {
    const db = mkDb(Array.from({ length: 350 }, (_, i) => ({ _id: `m${i}`, status: "pending" })));
    const scheduled: any[] = [];
    const ctx = { db, scheduler: { runAfter: async (_d: number, fn: any, a: any) => { scheduled.push([fn, a]); } } };

    expect(await cancelQueuedMessagesOnKill(ctx as any, CONV as any)).toBe(300);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0][1]).toEqual({ conversation_id: CONV });
    expect(db._tables.pending_messages.filter((r: any) => r.status === "pending")).toHaveLength(50);

    // The continuation finishes the job (and doesn't need another).
    scheduled.length = 0;
    expect(await cancelQueuedMessagesOnKill(ctx as any, CONV as any)).toBe(50);
    expect(db._tables.pending_messages.every((r: any) => r.status === "cancelled")).toBe(true);
    expect(scheduled).toHaveLength(0);
  });

  // A delivery already landing in the pane is the one thing kill may not
  // rewrite — only the delivery machinery resolves it. The flag stays true,
  // which is the honest answer (classifyWorkState keeps the killed row out of
  // the Working bucket regardless).
  test("leaves an in-flight fenced delivery alone and does not lie about the flag", async () => {
    const db = mkDb([
      { _id: "m_started", status: "pending", delivery_protocol_version: 2, delivery_status: "delivery-started" },
    ], { execution_protocol_state: "fenced" });
    expect(await cancelQueuedMessagesOnKill({ db } as any, CONV as any)).toBe(0);
    expect(db._tables.pending_messages[0].status).toBe("pending");
    expect(db._tables.pending_messages[0].delivery_status).toBe("delivery-started");
    expect(db._tables.conversations[0].has_pending_messages).toBe(true);
  });
});

// The delivery-side twin of the enqueue wake-up rules: if the system injects a
// message into a conversation, that conversation is alive whatever its inbox
// flags say. Without this, a message that outlived a kill runs the session while
// the row still reads killed — and classifyWorkState now files that as "idle",
// so the contradiction is invisible.
describe("delivery revives a killed conversation", () => {
  const CONV = "c1";
  const killedDb = () =>
    makeFakeDb({
      conversations: [{
        _id: CONV, user_id: "u1", status: "completed",
        inbox_killed_at: 111, inbox_dismissed_at: 111, inbox_stashed_at: 111,
      }],
      pending_messages: [{ _id: "m1", conversation_id: CONV, status: "pending", retry_count: 0 }],
    });

  test("an injection clears the kill/dismiss stamps and re-activates the row", async () => {
    const db = killedDb();
    await updatePendingMessageStatusForDaemon({ db } as any, "m1" as any, "u1" as any, "dev1", { status: "injected" });
    const conv = db._tables.conversations[0];
    expect(conv.inbox_killed_at).toBeUndefined();
    expect(conv.inbox_dismissed_at).toBeUndefined();
    expect(conv.status).toBe("active");
    // Stash survives on purpose: "keep working out of my sight" is exactly what
    // a delivering-but-hidden session is doing (mirrors enqueue's machine wake).
    expect(conv.inbox_stashed_at).toBe(111);
  });

  // The PUBLIC status mutation is not proof of delivery. With device_id omitted
  // it writes through the same helper but its authorization passes on
  // message.from_user_id alone — no conversation ownership — so a teammate who
  // sent into my session (or a replay of their client) could post
  // status:"injected" and un-retire a session I killed with nothing delivered.
  // "injected" is self-reported and reversible; only the owning daemon's word counts.
  test("the PUBLIC status mutation cannot revive a killed session", async () => {
    const db = killedDb();
    // The sender is a teammate — the conversation is mine.
    db._tables.pending_messages[0].from_user_id = "u_teammate";
    await (updateMessageStatus as any)._handler(
      {
        db,
        auth: { getUserIdentity: async () => ({ subject: "u_teammate|session" }) },
      },
      { message_id: "m1", status: "injected" },
    );
    const conv = db._tables.conversations[0];
    expect(db._tables.pending_messages[0].status).toBe("injected"); // the write itself still lands
    expect(conv.inbox_killed_at).toBe(111); // …but the session stays retired
    expect(conv.status).toBe("completed");
  });

  test("a CANCEL is not a delivery and revives nothing", async () => {
    const db = killedDb();
    await cancelQueuedMessagesOnKill({ db } as any, CONV as any);
    const conv = db._tables.conversations[0];
    expect(conv.inbox_killed_at).toBe(111);
    expect(conv.status).toBe("completed");
  });
});

describe("getConversationPendingMessage", () => {
  test("returns the pending row's own id as message_id (the client feeds it to getMessageStatus)", async () => {
    const { getConversationPendingMessage } = await import("./pendingMessages");
    const auth = { async getUserIdentity() { return { subject: "u_owner|session" }; } };
    const ctx = {
      auth,
      db: makeFakeDb({
        conversations: [{ _id: "conv_1", user_id: "u_owner" }],
        pending_messages: [
          { _id: "pm_1", conversation_id: "conv_1", from_user_id: "u_owner", status: "pending", created_at: 5, retry_count: 0, content: "hi" },
        ],
      }),
    } as any;
    const result = await (getConversationPendingMessage as any)._handler(ctx, { conversation_id: "conv_1" });
    expect(result?.message_id).toBe("pm_1");
    expect(result?.status).toBe("pending");
  });
});
