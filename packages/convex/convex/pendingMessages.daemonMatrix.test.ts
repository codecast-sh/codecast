import { describe, expect, test } from "bun:test";
import {
  ackInjectedForDaemon,
  canDaemonSeePendingMessage,
  claimPendingMessageForDaemon,
  collectDeliverableForOwner,
} from "./pendingMessages";
import { findEchoedPendingMessage } from "./messages";

// ── DAEMON adversarial matrix (docs/architecture/local-first-sync-test-matrix.md, DAEMON section)
// In-memory fake ctx.db in the style of pendingMessages.teamSend.test.ts: faithful enough to run
// the REAL visibility/claim/ack code. withIndex ignores the index NAME and matches on the eq/gt
// constraints the builder declares.

type Rec = Record<string, any>;

function createDb(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  const counters: Record<string, number> = {};
  for (const [table, rows] of Object.entries(seed)) {
    tables[table] = rows.map((r) => ({ ...r }));
  }
  const allRows = () => Object.values(tables).flat();
  const db = {
    async get(id: string) {
      return allRows().find((r) => r._id === id) ?? null;
    },
    async insert(table: string, doc: Rec) {
      counters[table] = (counters[table] ?? 0) + 1;
      const _id = `${table}_${counters[table]}`;
      (tables[table] ??= []).push({ _id, ...doc });
      return _id;
    },
    async patch(id: string, patch: Rec) {
      const row = allRows().find((r) => r._id === id);
      if (!row) throw new Error(`patch: no row ${id}`);
      Object.assign(row, patch);
    },
    query(table: string) {
      const constraints: Array<{ field: string; op: "eq" | "gt"; val: any }> = [];
      const q: any = {
        eq(field: string, val: any) {
          constraints.push({ field, op: "eq", val });
          return q;
        },
        gt(field: string, val: any) {
          constraints.push({ field, op: "gt", val });
          return q;
        },
      };
      const run = () =>
        (tables[table] ?? []).filter((r) =>
          constraints.every((c) =>
            c.op === "eq"
              ? String(r[c.field]) === String(c.val)
              : (r[c.field] ?? -Infinity) > c.val,
          ),
        );
      return {
        withIndex(_name: string, builder: (q: any) => unknown) {
          builder(q);
          const chain = {
            async collect() {
              return run();
            },
            async first() {
              return run()[0] ?? null;
            },
            async take(n: number) {
              return run().slice(0, n);
            },
          };
          return chain;
        },
      };
    },
  };
  return { db, tables };
}

const NOW = 1_800_000_000_000;
const ONLINE_AGO = 10_000; // well inside DEVICE_ONLINE_MS
const OFFLINE_AGO = 30 * 60_000; // well past DEVICE_ONLINE_MS

function seedOwnershipWorld(opts: {
  ownerDeviceId?: string;
  ownerLastSeen?: number;
  claimantIsRemote?: boolean;
  claimantRegistered?: boolean;
}) {
  const devices: Rec[] = [];
  if (opts.ownerDeviceId && opts.ownerLastSeen !== undefined) {
    devices.push({
      _id: "dev_owner",
      user_id: "user_a",
      device_id: opts.ownerDeviceId,
      last_seen: opts.ownerLastSeen,
    });
  }
  if (opts.claimantRegistered !== false) {
    devices.push({
      _id: "dev_claimant",
      user_id: "user_a",
      device_id: "device_live",
      last_seen: NOW - ONLINE_AGO,
      is_remote: opts.claimantIsRemote ?? false,
    });
  }
  return createDb({
    conversations: [
      {
        _id: "conv_1",
        user_id: "user_a",
        owner_device_id: opts.ownerDeviceId,
      },
    ],
    devices,
    pending_messages: [
      {
        _id: "pm_1",
        conversation_id: "conv_1",
        from_user_id: "user_a",
        owner_user_id: "user_a",
        content: "hello",
        status: "pending",
        created_at: NOW - 60_000,
        retry_count: 0,
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DPM-02 — offline-owner delivery black hole.
// A conversation owned by a DEAD device (retired laptop, or the same machine
// after a machine-key rotation minted a new device id) must not black-hole
// delivery: the user's live local daemon must see, claim (take over), and
// deliver the row. deliverMessage's offline-owner reclaim is unreachable when
// the subscription filters the row first, so the fix must live in the
// visibility/claim layer itself.
// ─────────────────────────────────────────────────────────────────────────────
describe("DPM-02 — offline-owner takeover", () => {
  test("a pending row owned by an OFFLINE device is served and re-claimed by the user's live local daemon", async () => {
    const { db, tables } = seedOwnershipWorld({
      ownerDeviceId: "device_dead",
      ownerLastSeen: NOW - OFFLINE_AGO,
    });

    const deliverable = await collectDeliverableForOwner(
      { db } as any,
      "user_a" as any,
      "device_live",
      NOW,
    );
    expect(deliverable.map((m: any) => m._id)).toEqual(["pm_1"]);

    const claimed = await claimPendingMessageForDaemon(
      { db } as any,
      "pm_1" as any,
      "user_a" as any,
      "device_live",
      NOW,
    );
    expect(claimed?._id).toBe("pm_1");
    // Takeover re-stamps ownership so status writes and future routing follow the live device.
    expect(tables.conversations[0].owner_device_id).toBe("device_live");
  });

  test("an owner device with NO device row at all counts as offline (never registered ⇒ cannot be delivering)", async () => {
    const { db } = seedOwnershipWorld({ ownerDeviceId: "device_ghost" }); // no dev row
    const deliverable = await collectDeliverableForOwner({ db } as any, "user_a" as any, "device_live", NOW);
    expect(deliverable.map((m: any) => m._id)).toEqual(["pm_1"]);
  });

  test("SECURITY PIN: an ONLINE owner device stays exclusive — no takeover, row invisible to peers", async () => {
    const { db, tables } = seedOwnershipWorld({
      ownerDeviceId: "device_other",
      ownerLastSeen: NOW - ONLINE_AGO,
    });
    const deliverable = await collectDeliverableForOwner({ db } as any, "user_a" as any, "device_live", NOW);
    expect(deliverable).toEqual([]);
    const claimed = await claimPendingMessageForDaemon({ db } as any, "pm_1" as any, "user_a" as any, "device_live", NOW);
    expect(claimed).toBeNull();
    expect(tables.conversations[0].owner_device_id).toBe("device_other");
  });

  test("SECURITY PIN: a REMOTE claimant never takes over an offline-owned conversation", async () => {
    const { db, tables } = seedOwnershipWorld({
      ownerDeviceId: "device_dead",
      ownerLastSeen: NOW - OFFLINE_AGO,
      claimantIsRemote: true,
    });
    const deliverable = await collectDeliverableForOwner({ db } as any, "user_a" as any, "device_live", NOW);
    expect(deliverable).toEqual([]);
    const claimed = await claimPendingMessageForDaemon({ db } as any, "pm_1" as any, "user_a" as any, "device_live", NOW);
    expect(claimed).toBeNull();
    expect(tables.conversations[0].owner_device_id).toBe("device_dead");
  });

  test("SECURITY PIN: an UNREGISTERED claimant cannot take over (fail closed without a device row)", async () => {
    const { db, tables } = seedOwnershipWorld({
      ownerDeviceId: "device_dead",
      ownerLastSeen: NOW - OFFLINE_AGO,
      claimantRegistered: false,
    });
    const deliverable = await collectDeliverableForOwner({ db } as any, "user_a" as any, "device_live", NOW);
    expect(deliverable).toEqual([]);
    expect(tables.conversations[0].owner_device_id).toBe("device_dead");
  });

  test("unowned conversations keep first-claim semantics (unchanged legacy path)", async () => {
    const { db, tables } = seedOwnershipWorld({});
    const deliverable = await collectDeliverableForOwner({ db } as any, "user_a" as any, "device_live", NOW);
    expect(deliverable.map((m: any) => m._id)).toEqual(["pm_1"]);
    await claimPendingMessageForDaemon({ db } as any, "pm_1" as any, "user_a" as any, "device_live", NOW);
    expect(tables.conversations[0].owner_device_id).toBe("device_live");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DPM-01 / DLF-01 — claim semantics.
// ─────────────────────────────────────────────────────────────────────────────
describe("DPM-01/DLF-01 — claim is ownership-only and loser-safe", () => {
  test("DLF-01: a successful claim does NOT change row status — a crash mid-claim leaves the row deliverable", async () => {
    const { db, tables } = seedOwnershipWorld({});
    await claimPendingMessageForDaemon({ db } as any, "pm_1" as any, "user_a" as any, "device_live", NOW);
    expect(tables.pending_messages[0].status).toBe("pending");
  });

  test("DPM-01: the second device to claim after a first-claim lands sees null and backs off", async () => {
    const { db, tables } = seedOwnershipWorld({});
    // second live device for the same user
    tables.devices.push({ _id: "dev_b", user_id: "user_a", device_id: "device_b", last_seen: NOW - ONLINE_AGO });
    const first = await claimPendingMessageForDaemon({ db } as any, "pm_1" as any, "user_a" as any, "device_live", NOW);
    expect(first?._id).toBe("pm_1");
    const second = await claimPendingMessageForDaemon({ db } as any, "pm_1" as any, "user_a" as any, "device_b", NOW);
    expect(second).toBeNull();
    expect(tables.conversations[0].owner_device_id).toBe("device_live");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEC-01 — content-blind bulk ack falsely terminalizes never-landed rows.
// The daemon now reports exactly WHICH rows it pasted into a live pane; the
// server acks only those. A stranded injected row (paste never landed, or a
// previous daemon process injected it and died) is left for the heal cron to
// re-pend and re-deliver — never silently flipped to terminal `delivered`.
// This is the prod case observed 2026-07-29 (session jx798yp): rows terminal
// `delivered` whose conversations never received the message, triggered by
// auto-resume re-syncing a fresh JSONL from position 0 (historical user turns
// fired the blanket ack).
// ─────────────────────────────────────────────────────────────────────────────
describe("DEC-01 — scoped injected-ack", () => {
  function seedInjectedWorld() {
    return createDb({
      conversations: [{ _id: "conv_1", user_id: "user_a", has_pending_messages: true }],
      pending_messages: [
        {
          _id: "pm_landed",
          conversation_id: "conv_1",
          from_user_id: "user_a",
          owner_user_id: "user_a",
          content: "message that was really pasted",
          status: "injected",
          created_at: NOW - 90_000,
          retry_count: 0,
        },
        {
          _id: "pm_stranded",
          conversation_id: "conv_1",
          from_user_id: "user_a",
          owner_user_id: "user_a",
          content: "message whose paste never landed",
          status: "injected",
          created_at: NOW - 80_000,
          retry_count: 0,
        },
      ],
    });
  }

  test("an injected row the daemon did not report as pasted is NOT acked by an unrelated echo", async () => {
    const { db, tables } = seedInjectedWorld();
    const acked = await ackInjectedForDaemon({ db } as any, "conv_1" as any, ["pm_landed" as any]);
    expect(acked).toBe(1);
    expect(tables.pending_messages.find((m) => m._id === "pm_landed")!.status).toBe("delivered");
    // The stranded row stays `injected` for the heal cron to re-pend and re-deliver.
    expect(tables.pending_messages.find((m) => m._id === "pm_stranded")!.status).toBe("injected");
    // has_pending_messages must survive: something is still in flight.
    expect(tables.conversations[0].has_pending_messages).toBe(true);
  });

  test("a daemon that knows of NO pastes (fresh restart) acks nothing", async () => {
    const { db, tables } = seedInjectedWorld();
    const acked = await ackInjectedForDaemon({ db } as any, "conv_1" as any, []);
    expect(acked).toBe(0);
    for (const m of tables.pending_messages) expect(m.status).toBe("injected");
  });

  test("back-compat: an OLD daemon that passes no id list keeps the blanket behavior", async () => {
    const { db, tables } = seedInjectedWorld();
    const acked = await ackInjectedForDaemon({ db } as any, "conv_1" as any, undefined);
    expect(acked).toBe(2);
    for (const m of tables.pending_messages) expect(m.status).toBe("delivered");
    expect(tables.conversations[0].has_pending_messages).toBe(false);
  });

  test("ids from a stale process for rows already content-acked are harmless no-ops", async () => {
    const { db, tables } = seedInjectedWorld();
    await db.patch("pm_landed", { status: "delivered" });
    const acked = await ackInjectedForDaemon({ db } as any, "conv_1" as any, ["pm_landed" as any]);
    expect(acked).toBe(0);
    expect(tables.pending_messages.find((m) => m._id === "pm_landed")!.status).toBe("delivered");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEC-05 — a truncated echo can never content-match its pending row; the scoped
// ack (DEC-01) is what still delivers it. This test documents the gap and the
// rescue path together.
// ─────────────────────────────────────────────────────────────────────────────
describe("DEC-05 — oversized message echo", () => {
  test("a truncated echo is scoped-acked and stamped for send/v2 coverage", async () => {
    const fullContent = "x".repeat(500) + " tail that will be cut";
    const truncatedEcho = fullContent.slice(0, 500) + "\n... [truncated 22 chars]";
    const pendingRow = {
      _id: "pm_big",
      content: fullContent,
      created_at: NOW - 5_000,
      status: "injected",
    };
    // The content-matched ack provably cannot see this echo…
    expect(findEchoedPendingMessage([pendingRow], truncatedEcho, NOW)).toBeUndefined();

    // …so the scoped bulk ack (daemon-reported paste) must be what delivers it.
    const { db, tables } = createDb({
      conversations: [{ _id: "conv_1", user_id: "user_a" }],
      pending_messages: [{
        ...pendingRow,
        conversation_id: "conv_1",
        from_user_id: "user_a",
        client_id: "command_big",
        retry_count: 0,
      }],
      messages: [{
        _id: "message_truncated",
        conversation_id: "conv_1",
        role: "user",
        content: truncatedEcho,
        timestamp: NOW,
      }],
    });
    const acked = await ackInjectedForDaemon(
      { db } as any,
      "conv_1" as any,
      ["pm_big" as any],
      [{
        pendingMessageId: "pm_big" as any,
        transcriptMessageId: "message_truncated" as any,
      }],
    );
    expect(acked).toBe(1);
    expect(tables.pending_messages[0].status).toBe("delivered");
    expect(tables.messages[0].client_id).toBe("command_big");
  });

  test("a daemon ack never overwrites a transcript owned by another command", async () => {
    const { db, tables } = createDb({
      conversations: [{ _id: "conv_1", user_id: "user_a" }],
      pending_messages: [{
        _id: "pm_new",
        conversation_id: "conv_1",
        from_user_id: "user_a",
        client_id: "command_new",
        content: "same",
        status: "injected",
        created_at: NOW,
        retry_count: 0,
      }],
      messages: [{
        _id: "message_old",
        conversation_id: "conv_1",
        role: "user",
        content: "same",
        client_id: "command_old",
        timestamp: NOW,
      }],
    });
    await ackInjectedForDaemon(
      { db } as any,
      "conv_1" as any,
      ["pm_new" as any],
      [{
        pendingMessageId: "pm_new" as any,
        transcriptMessageId: "message_old" as any,
      }],
    );
    expect(tables.messages[0].client_id).toBe("command_old");
  });

  // Regression: the acct-switch double stamp. A recycled session boots with a
  // harness-emitted <task-notification> user turn; the daemon's positional
  // delivery ack paired the pasted "continue" pending row with THAT turn and
  // stamped its client_id there. Because the ack left echo_message_id unset,
  // the real "continue" echo (minutes later) re-adopted the row through the
  // delivered tier — TWO transcript messages sharing one client_id, which the
  // web timeline rendered as overlapping duplicate rows.
  test("a vouched ack ties the row to its transcript so a later content-matched echo cannot re-adopt it", async () => {
    const { db, tables } = createDb({
      conversations: [{ _id: "conv_1", user_id: "user_a" }],
      pending_messages: [{
        _id: "pm_continue",
        conversation_id: "conv_1",
        from_user_id: "user_a",
        client_id: "acct-switch-cmd1-conv_1",
        content: "continue",
        status: "injected",
        created_at: NOW - 10_000,
        retry_count: 0,
      }],
      messages: [{
        _id: "message_notification",
        conversation_id: "conv_1",
        role: "user",
        content: "<task-notification>\n<task-id>b1</task-id>\n<status>stopped</status>\n</task-notification>",
        timestamp: NOW,
      }],
    });
    await ackInjectedForDaemon(
      { db } as any,
      "conv_1" as any,
      ["pm_continue" as any],
      [{
        pendingMessageId: "pm_continue" as any,
        transcriptMessageId: "message_notification" as any,
      }],
    );
    const row = tables.pending_messages[0];
    expect(row.status).toBe("delivered");
    expect(row.echo_message_id).toBe("message_notification");
    // The true echo arrives later: the delivered tier must NOT re-match a row
    // that already has its transcript relation.
    expect(findEchoedPendingMessage([row as any], "continue", NOW + 240_000)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DOF-01 — a multi-message backlog for one conversation surfaces in creation
// order, so the delivery loop (which iterates the array under per-conversation
// serialization) attempts older messages first. Cross-retry reordering is only
// reachable through undeliverable-parking → cron revival, which is the
// documented never-drop late-arrival.
// ─────────────────────────────────────────────────────────────────────────────
describe("DOF-01 — backlog ordering", () => {
  test("deliverables for one conversation come back oldest-first and deduped across the index union", async () => {
    const { db } = createDb({
      conversations: [{ _id: "conv_1", user_id: "user_a" }],
      devices: [],
      pending_messages: [
        // Self-sends appear under BOTH by_owner_status and by_user_status.
        { _id: "pm_old", conversation_id: "conv_1", from_user_id: "user_a", owner_user_id: "user_a", content: "first", status: "pending", created_at: NOW - 30_000, retry_count: 0 },
        { _id: "pm_new", conversation_id: "conv_1", from_user_id: "user_a", owner_user_id: "user_a", content: "second", status: "pending", created_at: NOW - 10_000, retry_count: 0 },
      ],
    });
    const deliverable = await collectDeliverableForOwner({ db } as any, "user_a" as any, "device_live", NOW);
    expect(deliverable.map((m: any) => m._id)).toEqual(["pm_old", "pm_new"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DPM-02 interlock — canDaemonSeePendingMessage stays pure and conservative:
// without device-liveness facts it must behave exactly as before (fail closed
// on any owner mismatch).
// ─────────────────────────────────────────────────────────────────────────────
describe("canDaemonSeePendingMessage — default remains fail-closed", () => {
  const msg = {
    from_user_id: "user_a" as any,
    owner_user_id: "user_a" as any,
    status: "pending",
  };
  test("owner mismatch without liveness facts is invisible", () => {
    expect(
      canDaemonSeePendingMessage(msg, { user_id: "user_a" as any, owner_device_id: "other" }, "user_a" as any, "mine"),
    ).toBe(false);
  });
  test("unowned conversation stays visible", () => {
    expect(
      canDaemonSeePendingMessage(msg, { user_id: "user_a" as any }, "user_a" as any, "mine"),
    ).toBe(true);
  });
});
