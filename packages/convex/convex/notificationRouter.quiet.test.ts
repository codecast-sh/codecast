import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { emitNotification } from "./notificationRouter";

const ADA = "user-ada";

function ctx() {
  const db = makeFakeDb({
    users: [{ _id: ADA, name: "Ada", push_token: "tok", notifications_enabled: true }],
    notifications: [],
    push_outbox: [],
    user_presence: [],
    system_config: [],
  });
  return { db, scheduler: { runAfter: async () => {} } };
}

const base = {
  event_type: "daemon_overloaded" as const,
  entity_type: "device" as const,
  entity_id: "devices_1",
  direct_recipient_id: ADA as any,
  actor_name: "MacBook",
  message: "The daemon's event loop was frozen 395s in the last hour.",
};

describe("emitNotification quiet", () => {
  test("a quiet row lands in the bell marked quiet and queues no push", async () => {
    const c = ctx();
    await emitNotification(c as any, { ...base, quiet: true });
    const tables = c.db._inserted.map((r: any) => r.table);
    expect(tables).toEqual(["notifications"]);
    expect(c.db._inserted[0]!.doc.quiet).toBe(true);
  });

  test("an ordinary row still queues the push", async () => {
    const c = ctx();
    await emitNotification(c as any, base);
    const tables = c.db._inserted.map((r: any) => r.table);
    expect(tables).toContain("push_outbox");
    expect(c.db._inserted[0]!.doc.quiet).toBeUndefined();
  });
});
