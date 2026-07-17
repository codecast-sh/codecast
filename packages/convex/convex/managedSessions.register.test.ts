import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performRegisterManagedSession } from "./managedSessions";

// Cross-user register/reclaim semantics. The freshness guard (2026-07-06
// hijack) still blocks a foreign daemon while the rightful owner heartbeats —
// but after a cross-user reparent the CONVERSATION names the new runner, and
// the source machine's daemon keeps heartbeating its stale row (its tmux pane
// is still alive). Conversation authority breaks that deadlock: the register
// reclaims when the conversation's user_id names the caller, regardless of
// heartbeat freshness.
const SOURCE = "u".repeat(31) + "a"; // pre-move runner (old machine's account)
const DEST = "u".repeat(31) + "b"; // post-reparent runner (caller)

function fixtures(overrides: {
  convUserId?: string;
  ownerDeviceId?: string;
  managedRow?: Record<string, any> | null;
  devices?: any[];
} = {}) {
  const now = Date.now();
  return makeFakeDb({
    conversations: [
      {
        _id: "conv1",
        session_id: "sess1",
        user_id: overrides.convUserId ?? DEST,
        owner_device_id: overrides.ownerDeviceId ?? "destdev",
        status: "active",
      },
    ],
    devices: overrides.devices ?? [
      { _id: "d1", user_id: DEST, device_id: "destdev", label: "Dest", last_seen: now },
      { _id: "d2", user_id: SOURCE, device_id: "srcdev", label: "Source", last_seen: now },
    ],
    managed_sessions:
      overrides.managedRow === null
        ? []
        : [
            {
              _id: "ms1",
              session_id: "sess1",
              conversation_id: "conv1",
              user_id: SOURCE,
              pid: 111,
              tmux_session: "cc-old-machine",
              last_heartbeat: now, // FRESH — the source daemon is still beating
              started_at: now - 1000,
              ...(overrides.managedRow ?? {}),
            },
          ],
  });
}

const rows = (db: any) => db._tables.managed_sessions;

describe("performRegisterManagedSession cross-user reclaim", () => {
  test("conversation naming the caller reclaims despite a fresh source heartbeat (reparent handover self-heal)", async () => {
    const db = fixtures(); // conv.user_id = DEST, row user = SOURCE, heartbeat fresh
    await performRegisterManagedSession({ db }, DEST as any, {
      session_id: "sess1",
      pid: 222,
      tmux_session: "cc-new-machine",
      conversation_id: "conv1" as any,
      device_id: "destdev",
    });
    expect(rows(db).length).toBe(1);
    expect(rows(db)[0].user_id).toBe(DEST);
    expect(rows(db)[0].tmux_session).toBe("cc-new-machine");
    expect(rows(db)[0].conversation_id).toBe("conv1");
  });

  test("the tmux backfill (no conversation arg) reclaims too and keeps the conversation link", async () => {
    const db = fixtures();
    await performRegisterManagedSession({ db }, DEST as any, {
      session_id: "sess1",
      pid: 222,
      tmux_session: "cc-new-machine",
      device_id: "destdev",
    });
    expect(rows(db).length).toBe(1);
    expect(rows(db)[0].user_id).toBe(DEST);
    // conversation_id carried forward from the replaced row, not severed
    expect(rows(db)[0].conversation_id).toBe("conv1");
    expect(rows(db)[0].tmux_session).toBe("cc-new-machine");
  });

  test("a foreign daemon is still refused while the rightful owner heartbeats (the 2026-07-06 hijack)", async () => {
    // Conversation names SOURCE — the caller has no claim on it.
    const db = fixtures({ convUserId: SOURCE, ownerDeviceId: "srcdev" });
    const res = await performRegisterManagedSession({ db }, DEST as any, {
      session_id: "sess1",
      pid: 222,
      conversation_id: "conv1" as any,
    });
    expect(res?.notOwner).toBe(true);
    expect(rows(db)[0].user_id).toBe(SOURCE); // row untouched
  });

  test("source daemon cannot steal the session back: the new owner's device is seen online across accounts", async () => {
    // Post-reparent state, row already handed over: conversation runs under
    // DEST on destdev (online). The SOURCE daemon re-registers its live pane.
    const db = fixtures({ managedRow: null });
    const res = await performRegisterManagedSession({ db }, SOURCE as any, {
      session_id: "sess1",
      pid: 111,
      tmux_session: "cc-old-machine",
      conversation_id: "conv1" as any,
      device_id: "srcdev",
    });
    expect(res?.notOwner).toBe(true);
    expect(rows(db).length).toBe(0); // no row created under SOURCE
    const conv = db._tables.conversations[0];
    expect(conv.owner_device_id).toBe("destdev"); // not re-stamped
  });

  test("stale cross-user row is still reclaimable without conversation authority (logout/login resurface)", async () => {
    const db = fixtures({
      convUserId: SOURCE, // conversation still names the old user
      ownerDeviceId: "srcdev",
      managedRow: { last_heartbeat: Date.now() - 10 * 60 * 1000 }, // provably gone
    });
    await performRegisterManagedSession({ db }, DEST as any, {
      session_id: "sess1",
      pid: 222,
      conversation_id: "conv1" as any,
    });
    expect(rows(db).length).toBe(1);
    expect(rows(db)[0].user_id).toBe(DEST);
  });

  test("same-user re-register still patches in place", async () => {
    const db = fixtures({ managedRow: { user_id: DEST } });
    await performRegisterManagedSession({ db }, DEST as any, {
      session_id: "sess1",
      pid: 333,
      tmux_session: "cc-new-machine",
    });
    expect(rows(db).length).toBe(1);
    expect(rows(db)[0]._id).toBe("ms1"); // same row, patched
    expect(rows(db)[0].pid).toBe(333);
    expect(rows(db)[0].tmux_session).toBe("cc-new-machine");
  });
});
