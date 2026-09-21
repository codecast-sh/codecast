import { describe, expect, test } from "bun:test";
import { performRegisterManagedSession } from "./managedSessions";
import { makeFakeDb } from "./testDb";

describe("cross-user reclaim", () => {
  for (const age of [30_000, 90_000, 180_000, 600_000]) {
    test(`heartbeat age ${age} grants no execution authority`, async () => {
      const db = makeFakeDb({
        conversations: [{ _id: "conv", user_id: "owner", session_id: "session" }],
        managed_sessions: [{ _id: "managed", user_id: "owner", session_id: "session", conversation_id: "conv", last_heartbeat: Date.now() - age }],
      });
      expect(await performRegisterManagedSession({ db }, "stranger" as any, { session_id: "session", pid: 2 })).toEqual({ notOwner: true });
      expect(db._patched).toEqual([]);
      expect(db._deleted).toEqual([]);
      expect(db._inserted).toEqual([]);
    });
  }
});
