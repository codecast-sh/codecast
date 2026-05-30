import { describe, expect, test } from "bun:test";
import { backlogFieldsPatch } from "./heartbeatBacklog";

describe("backlogFieldsPatch", () => {
  test("omits a field the daemon did not send (rollout safety)", () => {
    // OLD daemon: neither field present → patch is empty so ctx.db.patch leaves any
    // prior backlog value untouched (the bug was coercing undefined → 0).
    expect(backlogFieldsPatch({})).toEqual({});
  });

  test("does not overwrite a previously-set value when the field is undefined", () => {
    // Simulate the heartbeat merge: a newer daemon wrote a real backlog, then an
    // OLD daemon's heartbeat arrives with the field undefined. The merged patch must
    // not carry the field, so the prior value survives.
    const prior = { daemon_pending_sync_messages: 42, daemon_pending_sync_conversations: 7 };
    const merged = { ...prior, ...backlogFieldsPatch({}) };
    expect(merged.daemon_pending_sync_messages).toBe(42);
    expect(merged.daemon_pending_sync_conversations).toBe(7);
  });

  test("patches the fields when the daemon sends them, including a real zero", () => {
    expect(
      backlogFieldsPatch({ pending_sync_messages: 5, pending_sync_conversations: 2 })
    ).toEqual({
      daemon_pending_sync_messages: 5,
      daemon_pending_sync_conversations: 2,
    });
    // An explicit 0 (queue genuinely drained) is a real value and IS written —
    // distinguished from "field absent" by being defined.
    expect(
      backlogFieldsPatch({ pending_sync_messages: 0, pending_sync_conversations: 0 })
    ).toEqual({
      daemon_pending_sync_messages: 0,
      daemon_pending_sync_conversations: 0,
    });
  });

  test("handles one field present and the other absent independently", () => {
    expect(backlogFieldsPatch({ pending_sync_messages: 9 })).toEqual({
      daemon_pending_sync_messages: 9,
    });
    expect(backlogFieldsPatch({ pending_sync_conversations: 3 })).toEqual({
      daemon_pending_sync_conversations: 3,
    });
  });
});
